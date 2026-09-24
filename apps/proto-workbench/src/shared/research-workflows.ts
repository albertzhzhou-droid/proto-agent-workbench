import type { SchemaMigrationReport } from "./storage-migrations.ts";
import {z} from 'zod';
import type {ComputeRequest,ComputeRun,ComputeCatalog} from './compute.ts';
import type {ComputeStudyOpenedRun,ComputeStudyRunBinding} from './compute-studies.ts';

const uuid=z.string().uuid(),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const stepId=z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const toolId=z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const WorkflowValueTypeSchema=z.enum(['number','integer','string','boolean','array','object']);
export type WorkflowValueType=z.infer<typeof WorkflowValueTypeSchema>;
export const WorkflowBindingSchema=z.object({argument:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/),fromStep:stepId,
 pointer:z.string().max(512).refine(value=>value===''||value.startsWith('/'),'Use a JSON pointer into the saved result.'),type:WorkflowValueTypeSchema}).strict();
export const WorkflowStepSchema=z.object({id:stepId,title:z.string().trim().min(1).max(120),tool:toolId,
 arguments:z.record(z.string(),z.json()),bindings:z.array(WorkflowBindingSchema).max(40)}).strict();
export const WorkflowDraftSchema=z.object({name:z.string().trim().min(1).max(120),description:z.string().max(8000),
 steps:z.array(WorkflowStepSchema).min(1).max(16)}).strict();
export type WorkflowBinding=z.infer<typeof WorkflowBindingSchema>;
export type WorkflowStep=z.infer<typeof WorkflowStepSchema>;
export type WorkflowDraft=z.infer<typeof WorkflowDraftSchema>;
export const ResearchWorkflowsRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('list'),studyId:uuid}).strict(),
 z.object({action:z.literal('get'),studyId:uuid,workflowId:uuid,revision:revision.optional()}).strict(),
 z.object({action:z.literal('validate'),studyId:uuid,draft:WorkflowDraftSchema}).strict(),
 z.object({action:z.literal('save'),studyId:uuid,workflowId:uuid.optional(),expectedRevision:revision.optional(),draft:WorkflowDraftSchema}).strict(),
 z.object({action:z.literal('branch'),studyId:uuid,workflowId:uuid,revision:revision,name:z.string().trim().min(1).max(120)}).strict(),
 z.object({action:z.literal('preview'),studyId:uuid,workflowId:uuid,expectedRevision:revision,forceSteps:z.array(stepId).max(16).optional()}).strict(),
 z.object({action:z.literal('start'),studyId:uuid,workflowId:uuid,expectedRevision:revision,expectedPlanSha256:digest,forceSteps:z.array(stepId).max(16).optional()}).strict(),
 z.object({action:z.literal('compare-executions'),studyId:uuid,leftWorkflowId:uuid,leftExecutionId:uuid,rightWorkflowId:uuid,rightExecutionId:uuid}).strict(),
 z.object({action:z.literal('get-execution'),studyId:uuid,workflowId:uuid,executionId:uuid}).strict(),
 z.object({action:z.literal('cancel'),studyId:uuid,workflowId:uuid,executionId:uuid}).strict(),
 z.object({action:z.literal('recover'),studyId:uuid,workflowId:uuid,executionId:uuid,acknowledgeInterrupted:z.literal(true)}).strict(),
]);
export type ResearchWorkflowsRequest=z.infer<typeof ResearchWorkflowsRequestSchema>;
export interface WorkflowBranchOrigin {workflowId:string;revision:number;definitionSha256:string}
export interface ResearchWorkflow extends WorkflowDraft {id:string;studyId:string;revision:number;createdAt:string;updatedAt:string;parentBranch?:WorkflowBranchOrigin}
export interface ResearchWorkflowSummary {id:string;studyId:string;revision:number;name:string;stepCount:number;updatedAt:string;parentBranch?:WorkflowBranchOrigin}
export interface WorkflowVersionSummary {revision:number;name:string;createdAt:string}
export interface WorkflowDiagnostic {code:string;message:string;stepId?:string;argument?:string;executionState?:'no-effect'|'tool-error'|'effect-unknown'}
export interface WorkflowValidation {ok:boolean;order:string[];diagnostics:WorkflowDiagnostic[]}
export type WorkflowPreviewStepState='forced'|'reusable'|'execute'|'conditional'|'blocked';
export interface WorkflowPreviewStep {
 stepId:string;title:string;tool:string;state:WorkflowPreviewStepState;reason:string;dependencies:string[];
 requestSha256?:string;fingerprintSha256?:string;cacheKey?:string;changedMaterials:string[];previousRunId?:string;
}
export interface WorkflowPreview {
 schema:'proto-agent.workflow-preview.v1';workflowId:string;workflowRevision:number;requestedForceSteps:string[];forcedClosure:string[];
 steps:WorkflowPreviewStep[];comparisonWarnings:string[];canStart:boolean;resourceEstimate:{state:'unknown';reason:string};planSha256:string;generatedAt:string;
}
export interface WorkflowComparisonStep {
 stepId:string;state:'comparable-inputs-equal'|'comparable-inputs-changed'|'different-method'|'missing-result'|'unverified-result';
 leftTool?:string;rightTool?:string;leftRunId?:string;rightRunId?:string;changedArgumentNames:string[];changedMaterials:string[];
 resultBytes:'same'|'different'|'unavailable';sourceFreshness:'both-current'|'stale-or-unknown'|'unavailable';
}
export interface WorkflowExecutionComparison {
 schema:'proto-agent.workflow-execution-comparison.v1';studyId:string;
 left:{workflowId:string;executionId:string;workflowRevision:number};right:{workflowId:string;executionId:string;workflowRevision:number};
 steps:WorkflowComparisonStep[];limits:string[];comparisonSha256:string;generatedAt:string;
}
export interface ComputeFingerprint {
 ok:true;schema_version:'proto-agent.compute-fingerprint.v1';fingerprint_sha256:string;cacheable:boolean;reasons:string[];
 materials:{request:unknown;files:unknown;implementation:unknown;runtime:unknown};
}
export interface ComputeExecutionFingerprint extends Omit<ComputeFingerprint,'ok'|'schema_version'> {verified_unchanged:boolean}
export type WorkflowExecutionStatus='pending'|'running'|'succeeded'|'failed'|'cancelled'|'interrupted';
export type WorkflowStepStatus='pending'|'running'|'reused'|'succeeded'|'failed'|'blocked'|'cancelled'|'interrupted';
export interface WorkflowStepExecution {
 stepId:string;title:string;tool:string;status:WorkflowStepStatus;operationId?:string;startedAt?:string;finishedAt?:string;
 request?:ComputeRequest;fingerprint?:ComputeFingerprint;cacheKey?:string;cacheReason?:string;
 runId?:string;binding?:ComputeStudyRunBinding;reusedFromExecutionId?:string;
 error?:WorkflowDiagnostic;blockedBy?:string[];
}
export interface WorkflowExecution {
 id:string;workflowId:string;workflowRevision:number;studyId:string;name:string;status:WorkflowExecutionStatus;
 createdAt:string;updatedAt:string;finishedAt?:string;owner:{pid:number;instanceId:string};
 steps:WorkflowStepExecution[];forceSteps:string[];parentExecutionId?:string;cancelRequested?:boolean;
 recoveryAvailable?:boolean;recoveryReason?:string;
}
export interface WorkflowExecutionSummary {id:string;workflowId:string;workflowRevision:number;status:WorkflowExecutionStatus;createdAt:string;updatedAt:string}
export interface ResearchWorkflowsResponse {
 migrationReport?:SchemaMigrationReport;
 workflows?:ResearchWorkflowSummary[];workflow?:ResearchWorkflow;versions?:WorkflowVersionSummary[];
 executions?:WorkflowExecutionSummary[];execution?:WorkflowExecution;validation?:WorkflowValidation;preview?:WorkflowPreview;comparison?:WorkflowExecutionComparison;
}
export interface ResearchWorkflowDependencies {
 catalog(tool?:string):Promise<ComputeCatalog>;
 fingerprint(request:ComputeRequest):Promise<ComputeFingerprint>;
 run(request:ComputeRequest,context:{signal:AbortSignal;executionId:string;stepId:string;attemptId:string;operationId:string}):Promise<ComputeRun>;
 openRun(runId:string):Promise<ComputeStudyOpenedRun>;
 ownerState?(pid:number):Promise<'alive'|'dead'|'unknown'>;
}
export const RESEARCH_WORKFLOW_LIMITS={steps:16,workflowsPerStudy:50,versionsPerWorkflow:100,executionsPerWorkflow:100,
 draftBytes:2*1024*1024,executionBytes:4*1024*1024,bindingCount:40} as const;
export const RESEARCH_WORKFLOW_REQUEST_BYTES=RESEARCH_WORKFLOW_LIMITS.draftBytes+16*1024;
