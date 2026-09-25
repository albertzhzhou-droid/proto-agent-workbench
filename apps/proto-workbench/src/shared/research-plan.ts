import { z } from 'zod';
import { WorkflowDraftSchema, WorkflowStepSchema } from './research-workflows.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(2000);
export const StudyDatasetSchema = z.object({
  id, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourcePath: z.string().min(1).max(1024), sha256,
  entityIds: z.array(id).min(1).max(10000), units: z.array(z.string().min(1).max(80)).min(1).max(32),
  referenceVersion: text,
}).strict();
export const ResearchStepSchema = WorkflowStepSchema.extend({
  role: z.enum(['required', 'optional-exploration', 'superseded-with-reason']),
  supersededReason: text.optional(), datasetIds: z.array(id).min(1).max(32),
  methodIdentity: z.object({ contractSha256: sha256, runtimeSha256: sha256 }).strict(),
  assumptions: z.array(text).min(1).max(40),
}).strict();
export const ProofObligationSchema = z.object({
  id, stepId: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  kind: z.enum(['artifact-intact', 'source-current', 'human-review', 'quantity-bound']),
  description: text, required: z.boolean(),
}).strict();
export const StudySpecSchema = z.object({
  schemaVersion: z.literal('proto.study-spec.v1'), studyId: z.string().uuid(),
  title: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(8000),
  datasets: z.array(StudyDatasetSchema).min(1).max(32),
  steps: z.array(ResearchStepSchema).min(1).max(16),
  proofObligations: z.array(ProofObligationSchema).max(128),
}).strict();
export type StudyDataset = z.infer<typeof StudyDatasetSchema>;
export type StudySpec = z.infer<typeof StudySpecSchema>;
export type ResearchStep = z.infer<typeof ResearchStepSchema>;
export type ProofObligation = z.infer<typeof ProofObligationSchema>;

/** A projection of the current canonical tool and Compute catalog, never a second registry. */
export const ScientificMethodContractSchema = z.object({
  schemaVersion: z.literal('proto.method-contract.v1'), methodId: id, canonicalTool: z.literal('proto_compute_run'),
  implementation: text, inputSchema: z.record(z.string(), z.json()),
  fileInputs: z.record(z.string(), z.json()),
  outputSchema: z.null(), quantityProfile: z.object({ status: z.enum(['requires-dataset-binding', 'exempt', 'unavailable']), reason: text }).strict(),
  applicability: z.array(text).max(100), limitations: z.array(text).max(100),
  referenceHandles: z.array(text).max(100), dependencies: z.array(text).max(100),
  maturity: z.enum(['method-implementation', 'numerical-reference-tested', 'demonstration', 'heuristic', 'unavailable']),
  scientificValidation: z.literal('not-established'), semanticGaps: z.array(text).max(100),
  cachePolicy: z.literal('host-execution-fingerprint'), contractSha256: sha256,
}).strict();
export type ScientificMethodContract = z.infer<typeof ScientificMethodContractSchema>;
export const ResearchPlanIRSchema = z.object({
  schemaVersion: z.literal('proto.research-plan.v1'), compilerVersion: z.literal('1'),
  spec: StudySpecSchema, workflow: WorkflowDraftSchema,
  methods: z.array(ScientificMethodContractSchema).min(1).max(16),
  obligations: z.array(ProofObligationSchema).min(1).max(160),
  specSha256: sha256, planSha256: sha256,
  scope: z.literal('static-contract-validation; not execution or scientific acceptance'),
}).strict();
export type ResearchPlanIR = z.infer<typeof ResearchPlanIRSchema>;
export interface ResearchPlanDiagnostic { code: string; message: string; path?: string; stepId?: string }
export type ResearchPlanCompilation = { ok: false; diagnostics: ResearchPlanDiagnostic[] } | {
  ok: true; diagnostics: ResearchPlanDiagnostic[]; plan: ResearchPlanIR; workflow: ResearchPlanIR['workflow'];
};

/** Exact finite JSON used for content identity; rejects getters, cycles, unsafe integers and oversized input. */
export function canonicalResearchJson(value: unknown): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 300000 || depth > 48) throw new Error('Research JSON exceeds its node or depth limit.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return item;
    if (Array.isArray(item)) return item.map(value => visit(value, depth + 1));
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('Research JSON cannot contain accessors.');
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    }
    throw new Error('Research values must be exact finite JSON.');
  };
  const result = JSON.stringify(visit(value, 0));
  if (new TextEncoder().encode(result).length > 2 * 1024 * 1024) throw new Error('Research JSON exceeds 2 MiB.');
  return result;
}
