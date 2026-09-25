import type { ComputeStudyOpenedRun } from '../../shared/compute-studies.ts';
import type { ResearchPlanIR, StudyDataset } from '../../shared/research-plan.ts';
import type { WorkflowExecution, WorkflowStepExecution } from '../../shared/research-workflows.ts';
import type { EvidenceGraph, EvidenceNode, ResearchCompletion, ResearchCompletionFacts } from '../../shared/research-evidence-graph.ts';
import { canonicalResearchJson } from '../../shared/research-plan.ts';
import { evaluateResearchCompletion } from '../../shared/research-evidence-graph.ts';
import { researchHash, verifyResearchPlanIdentity } from './research-plan-compiler.ts';

type Diagnostic = { code: string; message: string; stepId?: string };
export interface ManagedResearchEvidenceInput {
  /** Obtained from a checked persisted plan record, never a renderer execution verdict. */
  plan: ResearchPlanIR;
  binding: { workflowId: string; workflowRevision: number };
  execution: WorkflowExecution;
  openRun(runId: string): Promise<ComputeStudyOpenedRun>;
  /** Must read a contained regular file with the host path and byte-identity guard. */
  sourceHash(sourcePath: string): Promise<string>;
  /** Optional independent check of the retained immutable original bytes. */
  verifyDatasetSnapshot?(dataset: StudyDataset): Promise<boolean>;
  /** Prior attempts of this frozen plan in append order; missing historical unknown effects cannot be inferred. */
  priorExecutions?: WorkflowExecution[];
}
export interface ManagedResearchEvidence {
  graph: EvidenceGraph;
  facts: ResearchCompletionFacts;
  completion: ResearchCompletion;
  verifiedRuns: number;
  missingRuns: number;
  sourceFreshness: string[];
  diagnostics: Diagnostic[];
  /** Only runs that passed complete plan/request/runtime/retained-binding checks. */
  runs: Array<{ stepId: string; run: ComputeStudyOpenedRun }>;
}

const digest = /^[a-f0-9]{64}$/;
const same = (left: unknown, right: unknown) => canonicalResearchJson(left) === canonicalResearchJson(right);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const successful = (step: WorkflowStepExecution) => ['succeeded', 'reused'].includes(step.status);
function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/') || /~(?![01])/.test(path)) throw new Error('RUN_RESULT_POINTER_INVALID');
  for (const encoded of path.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) throw new Error('RUN_RESULT_POINTER_MISSING');
    } else if (!object(value)) throw new Error('RUN_RESULT_POINTER_MISSING');
    if (!Object.hasOwn(value as object, key)) throw new Error('RUN_RESULT_POINTER_MISSING');
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function effect(step: WorkflowStepExecution): ResearchCompletionFacts['attempts'][number]['effect'] {
  if (step.error?.executionState === 'effect-unknown') return 'unknown';
  if (['pending', 'blocked'].includes(step.status)) return 'none';
  if (successful(step)) return 'committed';
  if (['no-effect', 'tool-error'].includes(step.error?.executionState ?? '')) return 'none';
  return 'unknown';
}
function freshness(value: string): EvidenceNode['freshness'] { return value === 'current' ? 'current' : value === 'changed' || value === 'stale' ? 'stale' : 'unknown'; }
function assertExecution(input: ManagedResearchEvidenceInput, execution: WorkflowExecution): void {
  if (execution.studyId !== input.plan.spec.studyId || execution.workflowId !== input.binding.workflowId || execution.workflowRevision !== input.binding.workflowRevision) throw new Error('EXECUTION_PLAN_SCOPE_MISMATCH');
  const steps = input.plan.workflow.steps;
  if (new Set(execution.steps.map(step => step.stepId)).size !== steps.length || execution.steps.length !== steps.length
      || execution.steps.some(step => !steps.some(expected => expected.id === step.stepId && expected.tool === step.tool && expected.title === step.title))) throw new Error('EXECUTION_PLAN_STEPS_MISMATCH');
}

/** Reopens host evidence; it never executes a tool, modifies a run or promotes scientific maturity. */
export async function collectManagedResearchEvidence(input: ManagedResearchEvidenceInput): Promise<ManagedResearchEvidence> {
  if (!verifyResearchPlanIdentity(input.plan)) throw new Error('RESEARCH_PLAN_IDENTITY_INVALID');
  assertExecution(input, input.execution);
  const history = input.priorExecutions ?? [];
  if (history.length > 100 || new Set([...history, input.execution].map(item => item.id)).size !== history.length + 1) throw new Error('EXECUTION_HISTORY_INVALID');
  for (const execution of history) assertExecution(input, execution);
  const graph: EvidenceGraph = { schemaVersion: 'proto.evidence-graph.v1', nodes: [], edges: [] };
  const output: ManagedResearchEvidence = { graph, facts: { planSha256: input.plan.planSha256, attempts: [], obligationResults: [], graph },
    completion: { complete: false, blockers: [], optionalFailures: [], scope: 'evidence obligations only; not scientific acceptance' },
    verifiedRuns: 0, missingRuns: 0, sourceFreshness: [], diagnostics: [], runs: [] };
  const add = (code: string, message: string, stepId?: string) => output.diagnostics.push({ code, message, ...(stepId ? { stepId } : {}) });
  const planNode = `plan:${input.plan.planSha256}`;
  graph.nodes.push({ id: planNode, kind: 'plan', version: input.plan.compilerVersion, sha256: input.plan.planSha256, integrity: 'verified', freshness: 'current', label: input.plan.spec.title });
  for (const dataset of input.plan.spec.datasets) {
    let current: EvidenceNode['freshness'] = 'unknown', integrity: EvidenceNode['integrity'] = 'not-checked';
    try {
      const currentHash = await input.sourceHash(dataset.sourcePath);
      if (!digest.test(currentHash)) throw new Error('DATASET_DIGEST_INVALID');
      current = currentHash === dataset.sha256 ? 'current' : 'stale';
      if (current === 'current') integrity = 'verified';
    } catch { add('DATASET_CURRENT_UNAVAILABLE', `The current source ${dataset.sourcePath} could not be verified.`); }
    if (input.verifyDatasetSnapshot) {
      try { integrity = await input.verifyDatasetSnapshot(dataset) ? 'verified' : 'unavailable'; }
      catch { integrity = 'unavailable'; }
    }
    output.sourceFreshness.push(current);
    graph.nodes.push({ id: dataset.id, kind: 'dataset', version: String(dataset.version), sha256: dataset.sha256, integrity, freshness: current, label: dataset.sourcePath });
    // Actual source dependencies attach to each consuming attempt below. Routing all
    // datasets through the plan node would incorrectly invalidate independent branches.
  }
  for (const execution of history) for (const step of execution.steps) output.facts.attempts.push({
    stepId: step.stepId, attemptId: `${execution.id}:${step.stepId}`, status: step.status, effect: effect(step), artifactIntegrity: 'not-checked',
  });
  const openedByStep = new Map<string, ComputeStudyOpenedRun>();
  const artifacts = new Map<string, EvidenceNode>();
  const nodes = () => new Map(graph.nodes.map(node => [node.id, node]));
  for (const planned of input.plan.workflow.steps) {
    const step = input.execution.steps.find(step => step.stepId === planned.id)!;
    const attemptId = `${input.execution.id}:${step.stepId}`, attemptNode = `attempt:${attemptId}`;
    const specification = input.plan.spec.steps.find(item => item.id === step.stepId)!;
    const fact: ResearchCompletionFacts['attempts'][number] = { stepId: step.stepId, attemptId, status: step.status, effect: effect(step), artifactIntegrity: 'unavailable' };
    output.facts.attempts.push(fact);
    graph.nodes.push({ id: attemptNode, kind: 'attempt', version: attemptId, sha256: researchHash(step), integrity: 'verified', freshness: 'current', label: step.title, stepId: step.stepId, planSha256: input.plan.planSha256 });
    graph.edges.push({ from: planNode, to: attemptNode, type: 'consumes' });
    for (const datasetId of specification.datasetIds) graph.edges.push({ from: datasetId, to: attemptNode, type: 'consumes' });
    for (const binding of planned.bindings) {
      const source = artifacts.get(binding.fromStep);
      if (source) graph.edges.push({ from: source.id, to: attemptNode, type: 'consumes' });
    }
    if (!step.runId) { if (successful(step)) { output.missingRuns++; add('RUN_MISSING', 'The successful step has no saved run identity.', step.stepId); } continue; }
    let opened: ComputeStudyOpenedRun | undefined;
    let artifactIntegrity: EvidenceNode['integrity'] = 'unavailable', current: EvidenceNode['freshness'] = 'unknown';
    try {
      opened = await input.openRun(step.runId);
      if (opened.integrity.status === 'damaged') artifactIntegrity = 'damaged';
      if (opened.integrity.status !== 'verified' || !opened.binding || !step.binding || !same(opened.binding, step.binding)) throw new Error('RUN_RETAINED_BINDING_MISMATCH');
      if (opened.runId !== step.runId || opened.tool !== planned.tool || opened.binding.tool !== planned.tool || opened.request?.tool !== planned.tool || opened.receipt?.tool !== planned.tool
          || opened.receipt.run_id !== step.runId || opened.receipt.ok !== true || opened.receipt.preview === true || !object(opened.receipt.result)) throw new Error('RUN_IDENTITY_MISMATCH');
      const args = structuredClone(planned.arguments);
      for (const binding of planned.bindings) {
        const source = openedByStep.get(binding.fromStep);
        if (!source?.receipt?.result) throw new Error('UPSTREAM_RUN_UNVERIFIED');
        Object.defineProperty(args, binding.argument, { value: pointer(source.receipt.result, binding.pointer), enumerable: true, writable: true, configurable: true });
      }
      if (!same(opened.request, { tool: planned.tool, arguments: args })) throw new Error('RUN_REQUEST_PLAN_MISMATCH');
      const fingerprint = opened.receipt.execution_fingerprint;
      if(fingerprint?.verified_unchanged !== true) throw new Error('RUN_EXECUTION_FINGERPRINT_UNVERIFIED');
      if (!fingerprint?.materials || researchHash({ runtime: fingerprint.materials.runtime, implementation: fingerprint.materials.implementation }) !== specification.methodIdentity.runtimeSha256) throw new Error('RUN_RUNTIME_PLAN_MISMATCH');
      if (step.fingerprint && step.fingerprint.fingerprint_sha256 !== fingerprint.fingerprint_sha256) throw new Error('RUN_FINGERPRINT_MISMATCH');
      const method = input.plan.methods.find(method => method.methodId === planned.tool)!;
      for (const [argument, definition] of Object.entries(method.fileInputs)) {
        const selected = object(definition) && definition.list ? args[argument] : [args[argument]];
        if (Array.isArray(selected)) for (const path of selected) if (typeof path === 'string') {
          const dataset = input.plan.spec.datasets.find(dataset => specification.datasetIds.includes(dataset.id) && dataset.sourcePath.replaceAll('\\', '/') === path.replaceAll('\\', '/'));
          const source = opened.sourceFreshness.details.find(item => item.name.startsWith('file:') && item.path.replaceAll('\\', '/') === path.replaceAll('\\', '/'));
          if (!dataset || !source || source.expectedSha256 !== dataset.sha256) throw new Error('RUN_FILE_DATASET_BINDING_MISMATCH');
        }
      }
      // A file can change during dispatch and later be restored. Check its saved input digest as well as live freshness.
      for (const datasetId of specification.datasetIds) {
        const dataset = input.plan.spec.datasets.find(item => item.id === datasetId)!;
        const source = opened.sourceFreshness.details.find(item => item.name.startsWith('file:') && item.path.replaceAll('\\', '/') === dataset.sourcePath.replaceAll('\\', '/'));
        if (source && source.expectedSha256 !== dataset.sha256) throw new Error('RUN_DATASET_PLAN_MISMATCH');
      }
      artifactIntegrity = 'verified'; current = freshness(opened.sourceFreshness.status);
      if (specification.datasetIds.some(id => nodes().get(id)?.freshness === 'stale')) current = 'stale';
      else if (specification.datasetIds.some(id => nodes().get(id)?.freshness !== 'current')) current = 'unknown';
      if (planned.bindings.some(binding => artifacts.get(binding.fromStep)?.freshness !== 'current')) current = planned.bindings.some(binding => artifacts.get(binding.fromStep)?.freshness === 'stale') ? 'stale' : 'unknown';
      fact.artifactIntegrity = 'verified'; openedByStep.set(step.stepId, opened);
      output.verifiedRuns++; output.runs.push({ stepId: step.stepId, run: opened });
    } catch (error) {
      output.missingRuns++; add('RUN_EVIDENCE_UNVERIFIED', error instanceof Error ? error.message : 'Saved run evidence could not be reopened.', step.stepId);
    }
    const artifact: EvidenceNode = { id: `artifact:${attemptId}`, kind: 'artifact', version: step.runId, sha256: step.binding?.resultSha256 ?? researchHash({ missingRunId: step.runId }), integrity: artifactIntegrity, freshness: current, label: `${step.title} result`, stepId: step.stepId, planSha256: input.plan.planSha256 };
    graph.nodes.push(artifact); graph.edges.push({ from: attemptNode, to: artifact.id, type: 'produces' }); artifacts.set(step.stepId, artifact);
    output.sourceFreshness.push(current);
  }
  for (const obligation of input.plan.obligations) {
    const step = input.plan.spec.steps.find(step => step.id === obligation.stepId)!;
    if (obligation.kind === 'source-current') {
      output.facts.obligationResults.push({ id: obligation.id, status: step.datasetIds.every(id => nodes().get(id)?.integrity === 'verified' && nodes().get(id)?.freshness === 'current') ? 'satisfied' : 'unsatisfied', evidenceIds: step.datasetIds });
    } else if (obligation.kind === 'artifact-intact') {
      const artifact = artifacts.get(step.id);
      if (artifact) output.facts.obligationResults.push({ id: obligation.id, status: artifact.integrity === 'verified' ? 'satisfied' : 'unsatisfied', evidenceIds: [artifact.id] });
    }
    // No accepted human review or bound quantity is manufactured from run success.
  }
  output.sourceFreshness = [...new Set(output.sourceFreshness)];
  output.completion = evaluateResearchCompletion(input.plan, output.facts);
  return output;
}
