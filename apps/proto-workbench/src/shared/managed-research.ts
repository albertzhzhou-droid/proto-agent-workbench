import { z } from 'zod';
import type { ComputeStudy, ComputeStudySummary } from './compute-studies.ts';
import type { WorkflowDraft, WorkflowExecution, WorkflowPreview } from './research-workflows.ts';
import { WorkflowDraftSchema } from './research-workflows.ts';
import type { EvidenceGraph, ResearchCompletion } from './research-evidence-graph.ts';

const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ResearchDatasetDraftSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  version: z.number().int().positive(),
  sourcePath: z.string().min(1).max(1024),
  entityIds: z.array(z.string().min(1).max(256)).min(1).max(10000),
  units: z.array(z.string().min(1).max(128)).min(1).max(32),
  referenceVersion: z.string().min(1).max(512),
}).strict();
export const ManagedResearchDraftSchema = z.object({
  workflow: WorkflowDraftSchema,
  datasets: z.array(ResearchDatasetDraftSchema).max(32),
  stepSemantics: z.array(z.object({
    stepId: z.string().min(1).max(48),
    role: z.enum(['required', 'optional-exploration', 'superseded-with-reason']),
    supersededReason: z.string().trim().min(1).max(2000).optional(),
    datasetIds: z.array(z.string().min(1).max(48)).max(32),
    assumptions: z.array(z.string().trim().min(1).max(2000)).max(32),
  }).strict()).min(1).max(16),
}).strict();
export type ManagedResearchDraft = z.infer<typeof ManagedResearchDraftSchema>;
export const ManagedResearchRequestSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('list')}).strict(),
  z.object({action: z.literal('create'), name: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(8000)}).strict(),
  z.object({action: z.literal('get'), studyId: id}).strict(),
  z.object({action: z.literal('compile'), studyId: id, expectedStudyRevision: z.number().int().positive(), draft: ManagedResearchDraftSchema}).strict(),
  z.object({action: z.literal('preview'), studyId: id, planId: id}).strict(),
  z.object({action: z.literal('inspect-plan'), studyId: id, planId: id}).strict(),
  z.object({action: z.literal('start'), studyId: id, planId: id, expectedPreviewSha256: digest}).strict(),
  z.object({action: z.literal('execution'), studyId: id, planId: id, executionId: id}).strict(),
  z.object({action: z.literal('cancel'), studyId: id, planId: id, executionId: id}).strict(),
  z.object({action: z.literal('compare'), studyId: id, leftPlanId: id, rightPlanId: id}).strict(),
  z.object({action: z.literal('capsule'), studyId: id, mode: z.enum(['manifest-only', 'full'])}).strict(),
]);
export type ManagedResearchRequest = z.infer<typeof ManagedResearchRequestSchema>;
export interface ManagedPlanSummary { id: string; title: string; createdAt: string; workflowId: string; workflowRevision: number; sha256: string }
export interface ManagedResearchResponse {
  studies?: ComputeStudySummary[];
  study?: ComputeStudy;
  plans?: ManagedPlanSummary[];
  plan?: ManagedPlanSummary;
  workflow?: WorkflowDraft;
  preview?: WorkflowPreview;
  execution?: WorkflowExecution;
  diagnostics?: Array<{code: string; message: string; stepId?: string}>;
  evidence?: {verifiedRuns: number; missingRuns: number; sourceFreshness: string[]; integrity: 'verified' | 'incomplete'; scientificReview: 'unreviewed'; objects: Array<{runId: string; sha256: string}>};
  comparison?: unknown;
  graph?: EvidenceGraph;
  completion?: ResearchCompletion;
  capsule?: {path: string; sha256: string; mode: 'manifest-only' | 'full'; bytes: number};
  limits?: string[];
}
export interface ManagedResearchApi { request(input: ManagedResearchRequest): Promise<ManagedResearchResponse> }
