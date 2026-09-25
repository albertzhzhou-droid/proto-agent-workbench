import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import type { ComputeCatalog, ComputeTool } from '../../shared/compute.ts';
import { requireToolContract } from '../../shared/tool-contracts.ts';
import units from '../../shared/scientific-units.generated.json' with { type: 'json' };
import { canonicalResearchJson, StudySpecSchema, ScientificMethodContractSchema, ResearchPlanIRSchema } from '../../shared/research-plan.ts';
import type { ResearchPlanCompilation, ResearchPlanDiagnostic, ScientificMethodContract } from '../../shared/research-plan.ts';
import type { WorkflowDraft } from '../../shared/research-workflows.ts';

const ajv = new Ajv({ strict: false, allErrors: true, ownProperties: true });
export const researchHash = (value: unknown): string => createHash('sha256').update(canonicalResearchJson(value)).digest('hex');

/** No availability guess, version number invention, worker calls, or secondary hand-written method registry. */
export function deriveMethodContract(tool: ComputeTool): ScientificMethodContract {
  const canonical = requireToolContract('proto_compute_run');
  if (!tool.input_schema || !tool.implementation) throw new Error('The method is missing its current input schema or implementation identity.');
  const base = {
    schemaVersion: 'proto.method-contract.v1' as const, methodId: tool.id, canonicalTool: canonical.name as 'proto_compute_run',
    implementation: tool.implementation, inputSchema: tool.input_schema, fileInputs: tool.file_inputs ?? {}, outputSchema: null,
    quantityProfile: tool.quantity_profile ?? { status: 'unavailable' as const, reason: 'The canonical catalog does not declare output quantity semantics.' },
    applicability: tool.maturity?.applicability ?? [], limitations: tool.maturity?.known_limitations ?? [],
    referenceHandles: [...(tool.method_references ?? []), ...(tool.maturity?.evidence.flatMap(item => [item.path, ...(item.test_ids ?? [])]) ?? [])],
    dependencies: tool.dependency, maturity: tool.maturity?.method_stage ?? 'unavailable', scientificValidation: 'not-established' as const,
    semanticGaps: ['The catalog has no per-method output JSON schema.',
      'The existing WorkflowDraft does not forward dataset_manifests or quantity_bindings; numerical output units are not certified by this compiler.',
      'Missing-value, randomness and resource policies require method-specific reviewed contracts; the host runtime fingerprint remains mandatory.'],
    cachePolicy: 'host-execution-fingerprint' as const,
  };
  return ScientificMethodContractSchema.parse({ ...base, contractSha256: researchHash({ ...base, canonicalToolContract: canonical }) });
}

/** The application obtains these facts from current, checked host state, never model arguments. */
export interface ResearchPlanHostFacts {
  runtimeFingerprints: Record<string, string>;
  datasetFingerprints: Record<string, string>;
}

/** Pure, deterministic lowering into the existing workflow language. No execution or filesystem mutation. */
export function compileResearchPlan(value: unknown, catalog: ComputeCatalog, facts: ResearchPlanHostFacts): ResearchPlanCompilation {
  const diagnostics: ResearchPlanDiagnostic[] = [];
  const problem = (code: string, message: string, stepId?: string, path?: string) => diagnostics.push({ code, message, ...(stepId ? { stepId } : {}), ...(path ? { path } : {}) });
  try { canonicalResearchJson(value); } catch (error) { return { ok: false, diagnostics: [{ code: 'RESEARCH_JSON_INVALID', message: String(error) }] }; }
  const parsed = StudySpecSchema.safeParse(value);
  if (!parsed.success) return { ok: false, diagnostics: parsed.error.issues.map(issue => ({ code: 'STUDY_SPEC_INVALID', message: issue.message, path: issue.path.join('.') })) };
  const spec = parsed.data;
  if (!catalog.ok || catalog.execution === 'recorded') problem('CATALOG_NOT_CURRENT', 'Compilation requires the current host Compute catalog.');
  const datasets = new Map(spec.datasets.map(dataset => [dataset.id, dataset]));
  if (datasets.size !== spec.datasets.length) problem('DUPLICATE_DATASET', 'Dataset IDs must identify exactly one frozen version.');
  for (const dataset of spec.datasets) {
    if (/^(?:[A-Za-z]:|[\\/])/.test(dataset.sourcePath) || dataset.sourcePath.split(/[\\/]/).some(part => part === '..' || part === '.')) problem('DATASET_PATH_INVALID', 'Dataset sources must use contained workspace-relative paths.', undefined, dataset.id);
    if (facts.datasetFingerprints[dataset.id] !== dataset.sha256) problem('DATASET_IDENTITY_UNVERIFIED', 'The host has not verified this dataset version digest.', undefined, dataset.id);
    if (new Set(dataset.entityIds).size !== dataset.entityIds.length) problem('DUPLICATE_ENTITY', 'Dataset entity IDs must be unambiguous.', undefined, dataset.id);
    if (new Set(dataset.units).size !== dataset.units.length || dataset.units.some(unit => !Object.hasOwn(units.units, unit))) problem('UNIT_UNSUPPORTED', 'Dataset units must come from the existing reviewed scientific unit contract.', undefined, dataset.id);
  }
  const stepMap = new Map(spec.steps.map(step => [step.id, step]));
  if (stepMap.size !== spec.steps.length) problem('DUPLICATE_STEP', 'Research step IDs must be unique.');
  const active = spec.steps.filter(step => step.role !== 'superseded-with-reason');
  if (!active.some(step => step.role === 'required')) problem('REQUIRED_STEP_MISSING', 'A study must retain at least one required step.');
  const methods = new Map<string, ScientificMethodContract>();
  for (const step of spec.steps) {
    if ((step.role === 'superseded-with-reason') !== !!step.supersededReason) problem('SUPERSESSION_REASON', 'Only superseded steps carry a mandatory explicit reason.', step.id);
    if (new Set(step.datasetIds).size !== step.datasetIds.length || step.datasetIds.some(id => !datasets.has(id))) problem('DATASET_BINDING_INVALID', 'Every declared dataset must resolve to one retained dataset version.', step.id);
    if (step.role === 'superseded-with-reason') continue;
    const matches = catalog.tools.filter(tool => tool.id === step.tool), tool = matches[0];
    if (matches.length !== 1 || !tool?.available || tool.missing_dependencies?.length || !tool.input_schema) { problem('METHOD_UNAVAILABLE', 'The current host catalog must identify one available typed method.', step.id); continue; }
    try {
      const method = deriveMethodContract(tool); methods.set(method.methodId, method);
      if (method.contractSha256 !== step.methodIdentity.contractSha256) problem('METHOD_CONTRACT_CHANGED', 'The method schema or semantic contract changed after selection.', step.id);
      if (facts.runtimeFingerprints[step.tool] !== step.methodIdentity.runtimeSha256) problem('RUNTIME_IDENTITY_UNVERIFIED', 'The method runtime must match a current host-checked fingerprint.', step.id);
      const schema = structuredClone(tool.input_schema);
      const bound = new Set(step.bindings.map(binding => binding.argument));
      schema.required = (schema.required ?? []).filter(name => !bound.has(name));
      const validator = ajv.compile(schema);
      if (!validator(step.arguments)) problem('ARGUMENT_SCHEMA', 'Literal arguments do not satisfy the current canonical method schema.', step.id);
      for (const [argument, input] of Object.entries(tool.file_inputs ?? {})) {
        const paths = input.list ? step.arguments[argument] : [step.arguments[argument]];
        if (Array.isArray(paths)) for (const path of paths) if (typeof path === 'string' && !step.datasetIds.some(id => datasets.get(id)?.sourcePath.replaceAll('\\', '/') === path.replaceAll('\\', '/'))) problem('FILE_DATASET_BINDING_MISSING', `The file input ${argument} must match a declared dataset source identity.`, step.id);
        if (step.bindings.some(binding => binding.argument === argument)) problem('DYNAMIC_FILE_IDENTITY_UNSUPPORTED', 'A computed file path lacks a statically verified dataset identity in this compiler version.', step.id);
      }
      for (const binding of step.bindings) {
        const source = stepMap.get(binding.fromStep);
        if (!source || source.id === step.id || source.role === 'superseded-with-reason') problem('DEPENDENCY_INVALID', 'Bindings must name another active step.', step.id);
        if (step.role === 'required' && source?.role === 'optional-exploration') problem('OPTIONAL_REQUIRED_DEPENDENCY', 'A prerequisite of a required step must itself be required.', step.id);
        if (Object.hasOwn(step.arguments, binding.argument) || step.bindings.filter(item => item.argument === binding.argument).length !== 1) problem('BINDING_COLLISION', 'Each argument has exactly one literal or bound source.', step.id);
        const target = tool.input_schema.properties?.[binding.argument];
        if (!target || target.type !== binding.type && !(target.type === 'number' && binding.type === 'integer')) problem('BINDING_TYPE', 'The result binding type must match the destination method schema.', step.id);
        if (binding.pointer && (!binding.pointer.startsWith('/') || /~(?![01])/.test(binding.pointer))) problem('BINDING_POINTER', 'Result bindings use valid RFC 6901 JSON pointers.', step.id);
      }
    } catch (error) { problem('METHOD_CONTRACT_INVALID', error instanceof Error ? error.message : 'Invalid canonical method contract.', step.id); }
  }
  const ordered: typeof active = [], remaining = new Set(active.map(step => step.id));
  while (remaining.size) {
    const ready = active.filter(step => remaining.has(step.id) && step.bindings.every(binding => ordered.some(source => source.id === binding.fromStep))).sort((a, b) => a.id.localeCompare(b.id));
    if (!ready.length) { problem('RESEARCH_PLAN_CYCLE', 'The computation graph must be an acyclic graph of existing active steps.'); break; }
    for (const step of ready) { ordered.push(step); remaining.delete(step.id); }
  }
  const obligations = [...spec.proofObligations];
  if (new Set(obligations.map(item => item.id)).size !== obligations.length) problem('DUPLICATE_OBLIGATION', 'Proof obligation IDs must be unique.');
  for (const obligation of obligations) {
    const step = stepMap.get(obligation.stepId);
    if (!step || step.role === 'superseded-with-reason' || obligation.required && step.role !== 'required') problem('OBLIGATION_STEP_INVALID', 'Required obligations must name required active steps.', obligation.stepId);
    if (obligation.required && obligation.kind === 'quantity-bound') problem('QUANTITY_WORKFLOW_UNSUPPORTED', 'This workflow version cannot forward the existing quantity adapter bindings; it cannot promise bound quantity output.', obligation.stepId);
  }
  for (const step of active.filter(step => step.role === 'required')) {
    for (const kind of ['artifact-intact', 'source-current'] as const) {
      const id = `compiler:${kind}:${step.id}`;
      if (obligations.some(item => item.id === id)) problem('RESERVED_OBLIGATION_ID', 'Compiler obligation IDs are reserved.', step.id);
      else obligations.push({ id, stepId: step.id, kind, description: kind === 'artifact-intact' ? 'Reopen the result and verify its retained byte and run identity.' : 'Verify the declared source versions before claiming current completion.', required: true });
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const workflow: WorkflowDraft = { name: spec.title, description: spec.question, steps: ordered.map(({ id, title, tool, arguments: args, bindings }) => ({ id, title, tool, arguments: args, bindings })) };
  const base = { schemaVersion: 'proto.research-plan.v1' as const, compilerVersion: '1' as const, spec, workflow,
    methods: [...methods.values()].sort((a, b) => a.methodId.localeCompare(b.methodId)), obligations,
    specSha256: researchHash(spec), scope: 'static-contract-validation; not execution or scientific acceptance' as const };
  const plan = ResearchPlanIRSchema.parse({ ...base, planSha256: researchHash(base) });
  return { ok: true, diagnostics: [], plan, workflow: plan.workflow };
}

export function verifyResearchPlanIdentity(value: unknown): boolean {
  const parsed = ResearchPlanIRSchema.safeParse(value);
  if (!parsed.success) return false;
  const { planSha256, ...base } = parsed.data;
  return researchHash(base) === planSha256 && researchHash(base.spec) === base.specSha256;
}
