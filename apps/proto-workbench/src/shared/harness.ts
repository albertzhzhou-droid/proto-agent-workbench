/** Versioned execution contracts, independent of renderer projections. */
export const HARNESS_DEFAULTS = Object.freeze({ contextTokens: 32_768, outputTokens: 4_096, maxOutputTokens: 8_192, safetyTokens: 2_048, maxRounds: 128, maxGeneratedTokens: 65_536, activeTimeMs: 2 * 60 * 60_000, maxReadConcurrency: 3 });
export type HarnessState = "queued" | "preparing" | "generating" | "executing" | "checkpointing" | "validating" | "recovering" | "paused" | "completed" | "incomplete" | "blocked" | "cancelled" | "effect-unknown" | "failed";
export interface MaterialBinding { partsPath: string; partsSha256: string; snapshotId?: string; selectionDigest?: string }
export type MissionEvidenceRequirement =
  | {kind: "materials"; minimumRecords: number; fields: Array<"sequence_sha256" | "source" | "license" | "length">; recordKind: "catalogue" | "protein"; allReturnedRecords?: boolean; reports?: Array<{paths: string[]; fields: Array<"sequence_sha256" | "source" | "license" | "length">}>}
  | {kind: "artifact-report"; minimumRecords: number; category: "metadata" | "artifacts"; reportPaths?: string[]; allRecords?: boolean; generatedOnly?: boolean}
  | {kind: "source-field"; field: string; sourcePaths: string[]; reportPaths?: string[]}
  | {kind: "dna-edit"; path: string; baselinePath?: string; construct?: string; occurrenceOrientations: Array<{instanceId: string; orientation: "forward" | "reverse"}>; preservePartIdentities: boolean; preserveOccurrenceIds: boolean; onlyTargetOccurrences: boolean; topology?: "linear" | "circular"; bindingError?: string}
  | {kind: "literature"; providers: Array<"pubmed" | "crossref" | "europe-pmc">; minimumRecords: number; live: boolean; countPublicationsOnly?: boolean}
  | {kind: "structure"; official: boolean}
  | {kind: "provenance"; workflow: boolean; verification: boolean; review: boolean};
export interface MissionContract {
  schema: "proto-workbench.mission.v1";
  runId: string; threadId: string; workspacePath: string; goal: string; modelId: string;
  mode: "plan" | "act"; contextTokens: number;
  primaryModelContextTokens?: number;
  scope: { writeRoots: string[]; network: boolean; execution: boolean };
  deliverables: Array<{ path: string; kind: "dna" | "protein" | "document" }>;
  requiresArtifacts?: boolean;
  requiredReads?: string[];
  evidenceRequirements?: MissionEvidenceRequirement[];
  materialBinding?: MaterialBinding;
  budgets: { activeTimeMs: number; maxRounds: number; maxGeneratedTokens: number };
}
export interface HarnessToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export type HarnessMessage = ({ role: "system" | "user" | "assistant"; content: string; tool_calls?: HarnessToolCall[] } | { role: "tool"; content: string; tool_call_id: string }) & { _harnessGenerated?: boolean };
export interface HarnessErrorInfo { code: string; stage: string; message: string; retryable: boolean; effectState: "none" | "committed" | "unknown" }
export interface HarnessCheckpoint {
  schema: "proto-workbench.execution.v1"; revision: number; contract: MissionContract;
  state: HarnessState; messages: HarnessMessage[]; round: number; generatedTokens: number; activeTimeMs: number;
  pendingCalls: HarnessToolCall[]; completedCalls: string[]; resultHandles: string[];
  deliveredPaths: string[]; fullContent: string; createdAt: string; updatedAt: string;
  error?: HarnessErrorInfo;
  /** Legacy static-completion-fallback marker; not checkpoint/journal recovery. */
  hostRecovered: boolean;
  selectedTools?: string[];
  instanceId?: string;
  contextUsed?: number;
  tokenCountMethod?: "exact" | "conservative-estimate";
  inFlightGenerationTokens?: number;
  recoveryCounters?: {transportRetries: number; outputRepairs: number; progressRepairs: number; instanceRebinds: number; journalReconciliations: number; resumes: number};
  observationProgress?: {seen: string[]; unchanged: number; repairIssued: boolean; obligations: string};
}
export interface HarnessProjection {
  runId: string; threadId: string; state: HarnessState; revision: number; round: number;
  generatedTokens: number; activeTimeMs: number; contextTokens: number; resultCount: number;
  contextUsed?: number; tokenCountMethod?: "exact" | "conservative-estimate"; inFlightGenerationTokens?: number;
  deliveredPaths: string[]; resumable: boolean; error?: HarnessErrorInfo;
  /** Legacy static-completion-fallback marker. Read recoveryCounters for recovery. */
  hostRecovered: boolean;
  recoveryCounters?: HarnessCheckpoint["recoveryCounters"];
  budgets?: MissionContract["budgets"];
}
export interface ToolResultEnvelope {
  schema: "proto-workbench.tool-result.v1"; handle: string; tool: string; ok: boolean;
  sha256: string; bytes: number; data: Record<string, unknown>; truncated: boolean;
}
