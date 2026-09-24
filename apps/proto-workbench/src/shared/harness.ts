/** Versioned execution contracts, independent of renderer projections. */
export const HARNESS_DEFAULTS = Object.freeze({ contextTokens: 32_768, outputTokens: 4_096, maxOutputTokens: 8_192, safetyTokens: 2_048, maxRounds: 128, maxGeneratedTokens: 65_536, activeTimeMs: 2 * 60 * 60_000, maxReadConcurrency: 3, repairBudget: Object.freeze({ outputRepairs: 1, progressRepairs: 1, verifyRepairs: 1 }) });
/** `abstained` and `needs-human` are deliberate stops, not failures: the work
 * and its evidence are intact, but no further round can establish the result. */
export type HarnessState = "queued" | "preparing" | "generating" | "executing" | "checkpointing" | "validating" | "recovering" | "paused" | "completed" | "incomplete" | "blocked" | "cancelled" | "effect-unknown" | "failed" | "abstained" | "needs-human";
export interface HarnessAbstention { reason: string; unmetRequirements: string[]; declaredAt: string }
/** Host-owned acceptance classes. Repairable failures may use the persisted
 * allowance; a missing dependency gets one targeted hint. Unsupported, stale
 * and conflicting evidence goes directly to human review. */
export type BlockingClass = "repairable" | "dependency-missing" | "unsupported" | "stale" | "conflicting";
export interface HarnessDiagnostic {
  code: string;
  blockingClass: BlockingClass;
  /** Deliverable path or requirement id the failure is about. */
  subject: string;
  message: string;
  evidenceRefs?: string[];
  remedy?: {tool: string; reason: string};
}
export interface HarnessVerdict {callId: string; round: number; recordedAt: string; diagnostics: HarnessDiagnostic[]; passed: string[]; action: "completed" | "repair" | "needs-human"; summary?: string}
export interface HarnessNegativeResult {tool: string; argsHash: string; failureCode: string; resultHandle: string; callId: string}
const UNRESOLVABLE: ReadonlySet<string> = new Set<BlockingClass>(["dependency-missing", "unsupported", "stale", "conflicting"]);
/** Strict repairability predicate retained for consumers. The controller also
 * handles dependency-missing through its separate, persisted one-hint rule.
 * Unknown diagnostics remain repairable within the normal task allowance. */
export const isRepairable = (diagnostic: unknown): boolean =>
  !(typeof diagnostic === "object" && diagnostic !== null
    && UNRESOLVABLE.has(String((diagnostic as {blockingClass?: unknown}).blockingClass)));
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
  /** Shared evidence gate category; a successful repair is independently reverified. */
  evidenceStatus?: "complete" | "incomplete-evidence";
  selectedTools?: string[];
  instanceId?: string;
  contextUsed?: number;
  tokenCountMethod?: "exact" | "conservative-estimate";
  inFlightGenerationTokens?: number;
  recoveryCounters?: {transportRetries: number; outputRepairs: number; progressRepairs: number; instanceRebinds: number; journalReconciliations: number; resumes: number};
  observationProgress?: {seen: string[]; unchanged: number; repairIssued: boolean; obligations: string};
  /** Repairs still available for the whole task. Persisted so that resuming a
   * run continues its repair allowance instead of granting a fresh one. */
  repairBudget?: {outputRepairs: number; progressRepairs: number; verifyRepairs?: number};
  verdicts?: HarnessVerdict[];
  dependencyHints?: string[];
  negativeResults?: HarnessNegativeResult[];
  toolCallCounts?: Record<string, number>;
  toolDispatches?: string[];
  abstention?: HarnessAbstention;
}
export interface HarnessProjection {
  runId: string; threadId: string; state: HarnessState; revision: number; round: number;
  generatedTokens: number; activeTimeMs: number; contextTokens: number; resultCount: number;
  contextUsed?: number; tokenCountMethod?: "exact" | "conservative-estimate"; inFlightGenerationTokens?: number;
  deliveredPaths: string[]; resumable: boolean; error?: HarnessErrorInfo;
  /** Legacy static-completion-fallback marker. Read recoveryCounters for recovery. */
  hostRecovered: boolean;
  recoveryCounters?: HarnessCheckpoint["recoveryCounters"];
  repairBudget?: HarnessCheckpoint["repairBudget"];
  abstention?: HarnessAbstention;
  budgets?: MissionContract["budgets"];
  verdicts?: HarnessVerdict[];
  diagnosticCounts?: Partial<Record<BlockingClass, number>>;
  toolCallCounts?: Record<string, number>;
}
export interface ToolResultEnvelope {
  schema: "proto-workbench.tool-result.v1"; handle: string; tool: string; ok: boolean;
  sha256: string; bytes: number; data: Record<string, unknown>; truncated: boolean;
}
