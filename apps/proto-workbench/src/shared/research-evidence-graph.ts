import { z } from 'zod';
import { canonicalResearchJson } from './research-plan.ts';
import type { ResearchPlanIR, StudySpec } from './research-plan.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const EvidenceNodeSchema = z.object({
  id, kind: z.enum(['project', 'study', 'question', 'hypothesis', 'dataset', 'plan', 'run', 'attempt', 'artifact', 'quantity', 'claim', 'citation', 'review']),
  version: z.string().min(1).max(128), sha256: digest,
  integrity: z.enum(['verified', 'damaged', 'unavailable', 'not-checked']),
  freshness: z.enum(['current', 'stale', 'unknown']),
  label: z.string().trim().min(1).max(500),
  stepId: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).optional(), planSha256: digest.optional(),
  reviewDecision: z.enum(['unreviewed', 'accepted-in-scope', 'rejected']).optional(),
}).strict();
/** Edges point from the input/supporting object to the dependent object, including derived_from. */
export const EvidenceEdgeSchema = z.object({
  from: id, to: id,
  type: z.enum(['consumes', 'produces', 'derived_from', 'supports', 'contradicts', 'reviews', 'supersedes']),
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();
export const EvidenceGraphSchema = z.object({
  schemaVersion: z.literal('proto.evidence-graph.v1'),
  nodes: z.array(EvidenceNodeSchema).max(4096), edges: z.array(EvidenceEdgeSchema).max(16384),
}).strict();
export type EvidenceGraph = z.infer<typeof EvidenceGraphSchema>;
export type EvidenceNode = z.infer<typeof EvidenceNodeSchema>;
export type EvidenceEdge = z.infer<typeof EvidenceEdgeSchema>;
export interface EvidenceGraphDiagnostic { code: string; message: string; nodeId?: string }
const computational = new Set<EvidenceEdge['type']>(['consumes', 'produces', 'derived_from']);
const dependencies = new Set<EvidenceEdge['type']>(['consumes', 'produces', 'derived_from', 'supports', 'contradicts']);

function validEndpoint(edge: EvidenceEdge, from: EvidenceNode, to: EvidenceNode): boolean {
  switch (edge.type) {
    case 'consumes': return ['dataset', 'artifact', 'quantity', 'plan'].includes(from.kind) && ['plan', 'run', 'attempt'].includes(to.kind);
    case 'produces': return ['run', 'attempt'].includes(from.kind) && ['artifact', 'quantity'].includes(to.kind);
    case 'derived_from': return ['dataset', 'artifact', 'quantity'].includes(from.kind) && ['dataset', 'artifact', 'quantity', 'claim'].includes(to.kind);
    case 'supports': case 'contradicts': return ['artifact', 'quantity', 'citation', 'claim'].includes(from.kind) && ['claim', 'hypothesis'].includes(to.kind);
    case 'reviews': return from.kind === 'review' && ['claim', 'hypothesis', 'artifact', 'run', 'plan'].includes(to.kind);
    case 'supersedes': return from.kind === to.kind && from.id !== to.id && !!edge.reason;
  }
}

export function validateEvidenceGraph(value: unknown): { ok: boolean; diagnostics: EvidenceGraphDiagnostic[] } {
  const parsed = EvidenceGraphSchema.safeParse(value);
  if (!parsed.success) return { ok: false, diagnostics: [{ code: 'EVIDENCE_SCHEMA_INVALID', message: 'Evidence graph fields or bounds do not match the supported schema.' }] };
  const graph = parsed.data, diagnostics: EvidenceGraphDiagnostic[] = [], nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length) diagnostics.push({ code: 'EVIDENCE_DUPLICATE_ID', message: 'Every evidence object has one stable version identity.' });
  const seen = new Set<string>(), incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from), to = nodes.get(edge.to), key = `${edge.from}|${edge.type}|${edge.to}`;
    if (!from || !to) diagnostics.push({ code: 'EVIDENCE_LINK_MISSING', message: 'An evidence edge references an absent object.' });
    else if (!validEndpoint(edge, from, to)) diagnostics.push({ code: 'EVIDENCE_LINK_TYPE', message: 'The relation does not apply to these object types, or supersession lacks a reason.' });
    if (seen.has(key)) diagnostics.push({ code: 'EVIDENCE_DUPLICATE_EDGE', message: 'Duplicate evidence links are not accepted.' });
    seen.add(key);
    if (computational.has(edge.type) && from && to) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const current = queue.shift()!; visited++;
    for (const edge of graph.edges.filter(edge => edge.from === current && computational.has(edge.type))) {
      const count = (incoming.get(edge.to) ?? 0) - 1; incoming.set(edge.to, count); if (count === 0) queue.push(edge.to);
    }
  }
  if (visited !== nodes.size) diagnostics.push({ code: 'EVIDENCE_COMPUTATION_CYCLE', message: 'The computational provenance subgraph must be acyclic.' });
  return { ok: diagnostics.length === 0, diagnostics };
}

/** Returns a projection; never changes retained hashes, prior graph versions, or historical integrity. */
export function invalidateEvidenceGraph(value: EvidenceGraph, changedIds: string[]): { graph: EvidenceGraph; affectedIds: string[] } {
  const validation = validateEvidenceGraph(value);
  if (!validation.ok) throw new Error(validation.diagnostics.map(item => item.code).join(', '));
  const graph = structuredClone(value), affected = new Set(changedIds), known = new Set(graph.nodes.map(node => node.id));
  if (changedIds.some(id => !known.has(id))) throw new Error('EVIDENCE_CHANGED_ID_UNKNOWN');
  const queue = [...affected];
  while (queue.length) {
    const from = queue.shift()!;
    for (const edge of graph.edges) if (edge.from === from && dependencies.has(edge.type) && !affected.has(edge.to)) { affected.add(edge.to); queue.push(edge.to); }
  }
  for (const node of graph.nodes) if (affected.has(node.id)) node.freshness = 'stale';
  return { graph, affectedIds: [...affected].sort() };
}

export interface ScientificDiffEntry {
  category: 'inputs' | 'sample-inclusion' | 'units' | 'parameters' | 'references' | 'method' | 'runtime' | 'seed' | 'claims';
  subjectId: string; before: unknown; after: unknown;
}
export interface ScientificDiff {
  schemaVersion: 'proto.scientific-diff.v1'; changes: ScientificDiffEntry[];
  attribution: 'descriptive-only'; warnings: string[];
}
export function scientificDiff(left: StudySpec, right: StudySpec, claims: { left: Record<string, string>; right: Record<string, string> } = { left: {}, right: {} }): ScientificDiff {
  const changes: ScientificDiffEntry[] = [];
  const compare = (category: ScientificDiffEntry['category'], subjectId: string, before: unknown, after: unknown) => {
    const a = before ?? null, b = after ?? null;
    if (canonicalResearchJson(a) !== canonicalResearchJson(b)) changes.push({ category, subjectId, before: a, after: b });
  };
  for (const id of [...new Set([...left.datasets, ...right.datasets].map(item => item.id))].sort()) {
    const a = left.datasets.find(item => item.id === id), b = right.datasets.find(item => item.id === id);
    compare('inputs', id, a ? { version: a.version, sha256: a.sha256, sourcePath: a.sourcePath } : null, b ? { version: b.version, sha256: b.sha256, sourcePath: b.sourcePath } : null);
    compare('sample-inclusion', id, a?.entityIds.slice().sort(), b?.entityIds.slice().sort());
    compare('units', id, a?.units.slice().sort(), b?.units.slice().sort());
    compare('references', id, a?.referenceVersion, b?.referenceVersion);
  }
  const seedKeys = new Set(['seed', 'random_seed', 'random_state']);
  for (const id of [...new Set([...left.steps, ...right.steps].map(item => item.id))].sort()) {
    const a = left.steps.find(item => item.id === id), b = right.steps.find(item => item.id === id);
    compare('method', id, a ? { tool: a.tool, contract: a.methodIdentity.contractSha256 } : null, b ? { tool: b.tool, contract: b.methodIdentity.contractSha256 } : null);
    compare('runtime', id, a?.methodIdentity.runtimeSha256, b?.methodIdentity.runtimeSha256);
    compare('parameters', id, a ? { arguments: Object.fromEntries(Object.entries(a.arguments).filter(([key]) => !seedKeys.has(key))), bindings: a.bindings, assumptions: a.assumptions, role: a.role, datasetIds: a.datasetIds, reason: a.supersededReason ?? null } : null,
      b ? { arguments: Object.fromEntries(Object.entries(b.arguments).filter(([key]) => !seedKeys.has(key))), bindings: b.bindings, assumptions: b.assumptions, role: b.role, datasetIds: b.datasetIds, reason: b.supersededReason ?? null } : null);
    compare('seed', id, a ? Object.fromEntries(Object.entries(a.arguments).filter(([key]) => seedKeys.has(key))) : null, b ? Object.fromEntries(Object.entries(b.arguments).filter(([key]) => seedKeys.has(key))) : null);
  }
  for (const id of [...new Set([...Object.keys(claims.left), ...Object.keys(claims.right)])].sort()) compare('claims', id, claims.left[id], claims.right[id]);
  const count = new Set(changes.map(change => change.category)).size;
  return { schemaVersion: 'proto.scientific-diff.v1', changes, attribution: 'descriptive-only', warnings: [
    'Recorded differences do not establish scientific equivalence or causal attribution.',
    ...(count > 1 ? ['Multiple categories changed; this comparison cannot attribute the outcome to any single factor.'] : []),
  ] };
}

const AttemptFactSchema = z.object({
  stepId: z.string().min(1).max(128), attemptId: id,
  status: z.enum(['pending', 'running', 'succeeded', 'reused', 'failed', 'blocked', 'cancelled', 'interrupted']),
  effect: z.enum(['none', 'staged', 'committed', 'unknown']),
  artifactIntegrity: z.enum(['verified', 'damaged', 'unavailable', 'not-checked']),
}).strict();
const ObligationResultSchema = z.object({
  id, status: z.enum(['satisfied', 'unsatisfied', 'unknown']), evidenceIds: z.array(id).min(1).max(64),
}).strict();
export const ResearchCompletionFactsSchema = z.object({
  planSha256: digest, attempts: z.array(AttemptFactSchema).max(4096),
  obligationResults: z.array(ObligationResultSchema).max(160),
  graph: EvidenceGraphSchema,
}).strict();
export type ResearchCompletionFacts = z.infer<typeof ResearchCompletionFactsSchema>;
export interface ResearchCompletion {
  complete: boolean; blockers: Array<{ code: string; message: string; stepId?: string; obligationId?: string }>;
  optionalFailures: string[]; scope: 'evidence obligations only; not scientific acceptance';
}

/** Host-owned facts only. No model verdict can waive a failed deterministic obligation. Attempts are in append order. */
export function evaluateResearchCompletion(plan: ResearchPlanIR, value: unknown): ResearchCompletion {
  const result: ResearchCompletion = { complete: false, blockers: [], optionalFailures: [], scope: 'evidence obligations only; not scientific acceptance' };
  const block = (code: string, message: string, stepId?: string, obligationId?: string) => result.blockers.push({ code, message, ...(stepId ? { stepId } : {}), ...(obligationId ? { obligationId } : {}) });
  const parsed = ResearchCompletionFactsSchema.safeParse(value);
  if (!parsed.success) { block('COMPLETION_FACTS_INVALID', 'Completion requires complete host-checked execution and evidence facts.'); return result; }
  const facts = parsed.data;
  if (facts.planSha256 !== plan.planSha256) block('COMPLETION_PLAN_MISMATCH', 'Completion facts belong to a different frozen plan.');
  const graphValidation = validateEvidenceGraph(facts.graph);
  for (const diagnostic of graphValidation.diagnostics) block(diagnostic.code, diagnostic.message);
  if (new Set(facts.attempts.map(item => item.attemptId)).size !== facts.attempts.length) block('DUPLICATE_ATTEMPT', 'Attempt identities must be unique.');
  if (new Set(facts.obligationResults.map(item => item.id)).size !== facts.obligationResults.length) block('DUPLICATE_OBLIGATION_RESULT', 'Each obligation has one current checked result.');
  // All attempts, including old, optional, superseded and unrelated attempts: never erase unknown effects.
  for (const attempt of facts.attempts) {
    if (attempt.effect === 'unknown') block('UNKNOWN_EFFECT', 'An unresolved persistent or external effect blocks research completion.', attempt.stepId);
    if (['pending', 'running'].includes(attempt.status)) block('EXECUTION_ACTIVE', 'Owned work remains pending or running.', attempt.stepId);
    if (!plan.spec.steps.some(step => step.id === attempt.stepId)) block('ATTEMPT_STEP_UNKNOWN', 'An execution attempt has no step in this plan.', attempt.stepId);
  }
  for (const step of plan.spec.steps) {
    const attempts = facts.attempts.filter(attempt => attempt.stepId === step.id), current = attempts.at(-1);
    if (step.role === 'optional-exploration' && attempts.some(item => !['succeeded', 'reused'].includes(item.status))) result.optionalFailures.push(step.id);
    if (step.role !== 'required') continue;
    if (!current || !['succeeded', 'reused'].includes(current.status)) block('REQUIRED_STEP_INCOMPLETE', 'The required step lacks a successful current attempt.', step.id);
    else if (current.artifactIntegrity !== 'verified') block('REQUIRED_ARTIFACT_UNVERIFIED', 'The successful step output must reopen with verified artifact integrity.', step.id);
  }
  const nodes = new Map(facts.graph.nodes.map(node => [node.id, node]));
  for (const obligation of plan.obligations.filter(item => item.required)) {
    const checked = facts.obligationResults.find(item => item.id === obligation.id);
    if (!checked || checked.status !== 'satisfied') { block('PROOF_OBLIGATION_UNSATISFIED', obligation.description, obligation.stepId, obligation.id); continue; }
    const evidence = checked.evidenceIds.map(id => nodes.get(id));
    if (evidence.some(node => !node || node.integrity !== 'verified' || node.freshness !== 'current')) block('OBLIGATION_EVIDENCE_UNVERIFIED', 'Obligation evidence must resolve to intact, current graph objects.', obligation.stepId, obligation.id);
    const expected = { 'artifact-intact': ['artifact'], 'source-current': ['dataset'], 'human-review': ['review'], 'quantity-bound': ['quantity'] }[obligation.kind];
    if (!evidence.some(node => node && expected.includes(node.kind))) block('OBLIGATION_EVIDENCE_TYPE', 'The evidence object type does not establish this obligation.', obligation.stepId, obligation.id);
    if (obligation.kind === 'source-current') {
      const step = plan.spec.steps.find(step => step.id === obligation.stepId)!;
      if (!step || step.datasetIds.some(id => !evidence.some(node => node?.kind === 'dataset' && node.id === id && node.sha256 === plan.spec.datasets.find(dataset => dataset.id === id)?.sha256))) block('OBLIGATION_DATASET_IDENTITY', 'Source evidence must cover every declared dataset version for this step.', obligation.stepId, obligation.id);
    } else if (!evidence.some(node => node && expected.includes(node.kind) && node.stepId === obligation.stepId && node.planSha256 === plan.planSha256 && (obligation.kind !== 'human-review' || node.reviewDecision === 'accepted-in-scope'))) {
      block('OBLIGATION_PLAN_BINDING', 'The artifact, quantity or accepted review must bind to this frozen plan and step.', obligation.stepId, obligation.id);
    }
  }
  result.complete = result.blockers.length === 0;
  return result;
}
