import type { ModelDescriptor } from "./contracts.ts";
import type { ResearchState } from "./research-session-state.ts";
import type { ResearchClaim, ResearchClaimEvidenceInput, ResearchClaimReviewState, ResearchClaimSourceRead, ResearchClaimSummary } from "./research-claims.ts";

export interface ResearchDocument {
  id: string; name: string; content: string; revision: number;
  source?: string; sourceSha256?: string;
  extraction?: ResearchDocumentExtraction;
}
export interface ResearchDocumentExtraction {
  format: "pdf" | "docx" | "xlsx"; sourceName: string; sourceBytes: number;
  sourcePath: string; extractionPath: string; extractionSha256: string; textPath: string;
  unitCount: number; totalCharacters: number; previewCharacters: number; complete: boolean; warnings: string[];
}
export interface ResearchDocumentUnit {
  index: number; kind: "page" | "paragraph" | "table-row" | "sheet-rows";
  locator: string; text: string; page?: number; paragraph?: number; sheet?: string; range?: string;
  cells?: { address: string; value: string; type: string; formula?: string }[];
}
export interface ResearchDocumentPage {
  documentId: string; sourceName: string; sourceSha256: string; totalUnits: number;
  startUnit: number; nextUnit: number | null; units: ResearchDocumentUnit[]; warnings: string[];
}
export interface ResearchMessage {
  id: string; role: "user" | "assistant"; content: string; createdAt: string;
  documents?: ResearchDocument[];
  /** Generation state only; complete never means scientific verification. */
  state?: "streaming" | "complete" | "incomplete-evidence" | "blocked" | "stopped" | "error";
  blocked?: {reason:string; unmetRequirements:string[]; declaredAt:string};
  modelBinding?: { instanceId: string; modelFingerprint: string | null; contextLength: number };
  policyGrant?: import("./tool-policy.ts").PolicyGrant;
  budget?: { steps: number; outputTokens: number; outputTokenMethod: "conservative-estimate"; limit: number };
  activity?: ResearchActivity[];
}
export interface ResearchMessagePage {
  liveStream?: { messageId:string; baseRevision:number; sha256:string };
  sessionId: string; revision: number; totalMessages: number; startIndex: number;
  transcriptSha256: string; nextCursor: string | null; messages: ResearchMessage[]; resetRequired?: boolean;
}
export interface ContextOmissionRange {
  startIndex: number; endIndex: number; startMessageId: string; endMessageId: string;
  messageCount: number; reason: "prior-context-window" | "non-context-message";
  sha256: string; receiptMessageIds: string[]; receiptPointerSha256: string;
}
export interface ContextRetentionManifest {
  schema: "proto-workbench.context-retention.v1"; sourceMessageCount: number;
  sourceTranscriptSha256: string; includedMessageIds: string[];
  omittedRanges: ContextOmissionRange[]; omittedMessages: number;
}
export interface ResearchActivity {
  id: string; tool: string; input: Record<string,unknown>; status: "running" | "complete" | "error";
  /** Canonical scientific identity alongside the model's original alias in input. */
  capabilityId?: string; backendTool?: string; blocked?: boolean;
  output?: string; artifactPath?: string; artifactSha256?: string; cached?: boolean; startedAt: string; finishedAt?: string;
  /** Recomputed by the host from the full receipt on each returned snapshot. */
  evidence?: ResearchEvidence;
  execution?: { operationId: string; state: string; outcome?: "ok" | "tool-error"; decisionId?: string; capabilityId?:string; effect?:"read"|"write"; tool?:string; argumentsSha256?:string; updatedAt?:string };
  /** Recovery annotation, separate from any preserved partial tool output. */
  interruption?: { source:"explicit-recovery";message:string;recordedAt:string };
}
export interface ResearchFact {
  id: string; activityId: string; operator: string;
  subjectId: string; quantity: string; value: number; unit: string;
  context: Record<string, string | number>;
  artifactPath: string; artifactSha256: string;
  valuePointer: string; identityPointer: string; unitSource: string;
}
export interface ResearchEvidence {
  schema: "proto-workbench.research-evidence.v1";
  status: "bound-facts" | "unlocatable" | "unreviewed" | "mismatch";
  scope: "saved-tool-receipt-fields-only";
  interpretation: "unreviewed";
  facts: ResearchFact[]; diagnostics: string[];
  unlocatableValues?: ResearchUnlocatableValue[];
}
export interface ResearchUnlocatableValue {
  activityId:string; artifactPath:string; artifactSha256:string;
  resultPath:string; resultPointer:string; valueText:string|null;
  reason:"QUANTITY_CONTRACT_MISSING"|"NON_NUMERIC_QUANTITY"|"UNSAFE_NUMERIC_VALUE"|"MISSING_VALUE";
  missingReason?:string;
}
export interface ResearchPlanItem { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
export type ResearchWorkflow = "explore" | "literature" | "analysis" | "reproduce";
export interface ResearchChatSession {
  id: string; title: string; modelId?: string; createdAt: string; updatedAt: string;
  messages: ResearchMessage[]; documents: ResearchDocument[];
  status: "idle" | "generating"; error?: string;
  context?: { omittedMessages: number; inputTokens: number; contextLength: number; method: string; retention?: ContextRetentionManifest };
  plan?: ResearchPlanItem[]; workflow?: ResearchWorkflow;
  moduleSettings?: import("./modules.ts").ModuleSettings;
  /** Optional for old preview fixtures; durable service sessions always have these fields. */
  payloadSchema?: "proto-workbench.research-session.v1";
  revision?: number;
  researchState?: ResearchState;
  claims?: ResearchClaim[];
  /** Disposable host ownership view. It never grants authority when restored from JSON. */
  execution?: ResearchExecutionState;
}
export interface ResearchExecutionState {
  status: "none" | "owned" | "live-elsewhere" | "owner-unknown" | "recoverable";
  canCancel: boolean; canRecover: boolean; reason: string;
}
export interface ResearchSessionPage {
  nextCursor: string | null; generation: string; indexingPending: number;
  resetRequired?: boolean;
}
export interface ResearchChatRecoveryIssue {
  sessionId: string; code: string; message: string;
  disposition: "retained-unopened" | "reloaded-latest";
}
export type ResearchChatSummary = Pick<ResearchChatSession, "id" | "title" | "updatedAt" | "status" | "modelId"> & {
  claimSummary?: ResearchClaimSummary;
  claimReviewSummary?: {total:number;reviewed:number;unreviewed:number;sourceChecks:"pending"};
};
export type ResearchChatRequest =
  | { action: "create" | "models" }
  | { action: "list"; limit?:number; cursor?:string }
  | { action: "open_link"; url:string }
  | { action: "get" | "cancel"; sessionId: string }
  | { action: "messages"; sessionId: string; cursor?: string; limit?: number }
  | { action: "recover"; sessionId:string; expectedRevision:number; confirmUnowned?:true }
  | { action: "rename"; sessionId: string; title: string }
  | { action: "research_state"; sessionId: string; expectedRevision: number; state: ResearchState }
  | { action: "claim_source"; sessionId: string; documentId: string; unitIndex?: number; startOffset?: number }
  | { action: "claim_save"; sessionId: string; expectedRevision: number; claimId?: string; text: string; evidence: ResearchClaimEvidenceInput[] }
  | { action: "claim_review"; sessionId: string; expectedRevision: number; claimId: string; state: ResearchClaimReviewState }
  | { action: "connect"; modelId: string; instanceId?: string }
  | { action: "send"; sessionId: string; modelId: string; content: string; documentIds: string[]; workflow?: ResearchWorkflow; toolsEnabled?: boolean; networkEnabled?: boolean; codeExecutionEnabled?: boolean }
  | { action: "document"; sessionId: string; name: string; content: string; documentId?: string; expectedRevision?: number }
  | { action: "read"; sessionId: string; path: string }
  | { action: "import"; sessionId: string; name: string; base64: string }
  | { action: "document_read"; sessionId: string; documentId: string; startUnit?: number; limit?: number }
  | { action: "export"; sessionId: string; documentId: string; expectedRevision: number };
export interface ResearchChatResponse {
  session?: ResearchChatSession;
  sessions?: ResearchChatSummary[];
  sessionPage?: ResearchSessionPage;
  recoveryIssues?: ResearchChatRecoveryIssue[];
  recoveryIssueCount?: number;
  claimSource?: ResearchClaimSourceRead;
  models?: ModelDescriptor[];
  exportPath?: string;
  documentPage?: ResearchDocumentPage;
  messagePage?: ResearchMessagePage;
}
export interface ResearchChatApi { request(input: ResearchChatRequest): Promise<ResearchChatResponse> }
