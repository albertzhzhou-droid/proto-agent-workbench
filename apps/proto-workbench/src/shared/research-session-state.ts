import type { ResearchChatSession, ResearchMessage } from "./research-chat.ts";
import { assertResearchClaims } from "./research-claims.ts";

/** Payload version, independent of the existing SQLite table or harness journal. */
export const RESEARCH_SESSION_SCHEMA = "proto-workbench.research-session.v1" as const;

export interface SourcedResearchText {
  text: string;
  sourceMessageId: string;
  sourceRole: "user" | "assistant";
}
export interface ConfirmedResearchConstraint extends SourcedResearchText {
  id: string;
  sourceRole: "user";
}
export interface ResearchState {
  question: SourcedResearchText | null;
  confirmedConstraints: ConfirmedResearchConstraint[];
  openQuestions: SourcedResearchText[];
  nextStep: SourcedResearchText | null;
}
export interface VersionedResearchChatSession extends ResearchChatSession {
  payloadSchema: typeof RESEARCH_SESSION_SCHEMA;
  revision: number;
  researchState: ResearchState;
}
export type ResearchSessionErrorCode =
  | "MALFORMED_JSON" | "INVALID_SESSION" | "UNSUPPORTED_SCHEMA"
  | "INVALID_RESEARCH_STATE" | "INVALID_STATE_SOURCE" | "REVISION_CONFLICT"
  | "INVALID_REVISION" | "STATE_CONTEXT_BUDGET";

export class ResearchSessionStateError extends Error {
  readonly code: ResearchSessionErrorCode;
  constructor(code: ResearchSessionErrorCode, message: string) {
    super(message);
    this.name = "ResearchSessionStateError";
    this.code = code;
  }
}

export type ResearchSessionDecode =
  | { ok: true; raw: string; session: VersionedResearchChatSession; migrated: boolean }
  | { ok: false; raw: string; code: ResearchSessionErrorCode; diagnostic: string };

function fail(code: ResearchSessionErrorCode, message: string): never {
  throw new ResearchSessionStateError(code, message);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function timestamp(value: unknown): value is string {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
function oneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}
function checkDocuments(value: unknown, location: string): void {
  if (!Array.isArray(value)) fail("INVALID_SESSION", `${location} must be an array.`);
  const ids = new Set<string>();
  for (const document of value) {
    if (!record(document) || !nonempty(document.id) || !nonempty(document.name)
        || typeof document.content !== "string" || !positiveInteger(document.revision)
        || !optionalString(document.source) || !optionalString(document.sourceSha256)
        || (document.extraction !== undefined && !record(document.extraction))) {
      fail("INVALID_SESSION", `${location} contains an invalid document.`);
    }
    if (ids.has(document.id)) fail("INVALID_SESSION", `${location} contains duplicate document IDs.`);
    ids.add(document.id);
  }
}
function checkSession(value: unknown): asserts value is ResearchChatSession {
  if (!record(value) || !nonempty(value.id) || typeof value.title !== "string"
      || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
      || !Array.isArray(value.messages) || !oneOf(value.status, ["idle", "generating"])
      || !optionalString(value.modelId) || !optionalString(value.error)) {
    fail("INVALID_SESSION", "Session identity, timestamps, status or transcript is invalid.");
  }
  checkDocuments(value.documents, "documents");
  if (value.context !== undefined) {
    const context=value.context;
    if(!record(context))fail("INVALID_SESSION","Saved context accounting is invalid; retain the complete conversation payload.");
    if(!Number.isSafeInteger(context.omittedMessages)||Number(context.omittedMessages)<0
        ||!Number.isSafeInteger(context.inputTokens)||Number(context.inputTokens)<0
        ||!Number.isSafeInteger(context.contextLength)||Number(context.contextLength)<=0
        ||!nonempty(context.method))fail("INVALID_SESSION","Saved context accounting is invalid; retain the complete conversation payload.");
    if(context.retention!==undefined) {
      const manifest=context.retention;
      if(!record(manifest))fail("INVALID_SESSION","Context retention manifest is malformed; retain the complete conversation payload.");
      const sourceCountValue=manifest.sourceMessageCount;
      if(manifest.schema!=="proto-workbench.context-retention.v1"
          ||!Number.isSafeInteger(sourceCountValue)||Number(sourceCountValue)<0||Number(sourceCountValue)>value.messages.length
          ||!Array.isArray(manifest.includedMessageIds)||manifest.includedMessageIds.length>2000
          ||!Array.isArray(manifest.omittedRanges)||manifest.omittedRanges.length>2000
          ||!Number.isSafeInteger(manifest.omittedMessages)||Number(manifest.omittedMessages)<0
          ||typeof manifest.sourceTranscriptSha256!=="string"||!/^[0-9a-f]{64}$/.test(manifest.sourceTranscriptSha256))
        fail("INVALID_SESSION","Context retention manifest is malformed; retain the complete conversation payload.");
      const sourceCount=sourceCountValue as number,includedIds=manifest.includedMessageIds as unknown[],ranges=manifest.omittedRanges as unknown[];
      const available=new Map((value.messages as unknown[]).map((message,index)=>[record(message)?message.id as string:"",index]));
      const included=new Set<string>();
      for(const candidate of includedIds) {
        if(!nonempty(candidate))fail("INVALID_SESSION","Context retention manifest references an invalid included message.");
        const id=candidate as string;
        if(included.has(id)||!available.has(id)||available.get(id)!>=sourceCount)
          fail("INVALID_SESSION","Context retention manifest references an unavailable or duplicate included message.");
        included.add(id);
      }
      let total=0,lastEnd=-1;
      for(const candidate of ranges) {
        if(!record(candidate))fail("INVALID_SESSION","Context omission range is malformed or no longer points into the saved transcript.");
        const startValue=candidate.startIndex,endValue=candidate.endIndex,countValue=candidate.messageCount;
        if(!Number.isSafeInteger(startValue)||!Number.isSafeInteger(endValue)||!Number.isSafeInteger(countValue))
          fail("INVALID_SESSION","Context omission range positions are invalid.");
        const start=startValue as number,end=endValue as number,count=countValue as number;
        if(start<0||end<start||end>=sourceCount||start<=lastEnd||count!==end-start+1
            ||!nonempty(candidate.startMessageId)||!nonempty(candidate.endMessageId)
            ||value.messages[start]?.id!==candidate.startMessageId||value.messages[end]?.id!==candidate.endMessageId
            ||!oneOf(candidate.reason,["prior-context-window","non-context-message"])
            ||typeof candidate.sha256!=="string"||!/^[0-9a-f]{64}$/.test(candidate.sha256)
            ||!Array.isArray(candidate.receiptMessageIds)||candidate.receiptMessageIds.length>count
            ||typeof candidate.receiptPointerSha256!=="string"||!/^[0-9a-f]{64}$/.test(candidate.receiptPointerSha256))
          fail("INVALID_SESSION","Context omission range is malformed or no longer points into the saved transcript.");
        const receiptIds=candidate.receiptMessageIds as unknown[],rangeIds=new Set((value.messages as unknown[]).slice(start,end+1).map(message=>record(message)?message.id:""));
        if(receiptIds.some(id=>!nonempty(id)||!rangeIds.has(id)))fail("INVALID_SESSION","Context retention receipt reference is outside its omitted message range.");
        if(receiptIds.some(id=>typeof id==="string"&&included.has(id)))fail("INVALID_SESSION","A transcript message cannot be both included and omitted in the same retention manifest.");
        for(const id of receiptIds as string[]) {
          const source=value.messages[available.get(id)!];
          if(!Array.isArray(source?.activity)||!source.activity.some((activity:unknown)=>record(activity)&&nonempty(activity.artifactPath)&&nonempty(activity.artifactSha256)))
            fail("INVALID_SESSION","Context retention receipt reference no longer identifies a saved artifact receipt.");
        }
        lastEnd=end;total+=count;
      }
      if(total!==manifest.omittedMessages||total!==context.omittedMessages||included.size+total!==sourceCount)fail("INVALID_SESSION","Context omission counts do not match the saved ranges and retained-message IDs.");
    }
  }
  if (value.claims !== undefined) {
    try { assertResearchClaims(value.claims); }
    catch { fail("INVALID_SESSION", "Stored research claims are invalid; retain this payload for review."); }
  }
  const messageIds = new Set<string>();
  for (const message of value.messages) {
    if (!record(message) || !nonempty(message.id) || !oneOf(message.role, ["user", "assistant"])
        || typeof message.content !== "string" || !timestamp(message.createdAt)
        || (message.state !== undefined && !oneOf(message.state, ["streaming", "complete", "incomplete-evidence", "blocked", "stopped", "error"]))) {
      fail("INVALID_SESSION", "Transcript contains an invalid message.");
    }
    if (messageIds.has(message.id)) fail("INVALID_SESSION", "Transcript contains duplicate message IDs.");
    messageIds.add(message.id);
    if(message.state==="blocked"&&message.blocked===undefined)fail("INVALID_SESSION","Blocked responses require a retained reason and unmet requirements.");
    if(message.blocked!==undefined&&(!record(message.blocked)||!nonempty(message.blocked.reason)||message.blocked.reason.length>2000
      ||!Array.isArray(message.blocked.unmetRequirements)||message.blocked.unmetRequirements.length<1||message.blocked.unmetRequirements.length>20
      ||message.blocked.unmetRequirements.some(item=>!nonempty(item)||item.length>1024)||!timestamp(message.blocked.declaredAt)))fail("INVALID_SESSION","Transcript contains an invalid blocked response.");
    if (message.documents !== undefined) checkDocuments(message.documents, "message.documents");
    if (message.activity !== undefined) {
      if (!Array.isArray(message.activity)) fail("INVALID_SESSION", "Message activity must be an array.");
      const activityIds = new Set<string>();
      for (const activity of message.activity) {
        if (!record(activity) || !nonempty(activity.id) || !nonempty(activity.tool)
            || !record(activity.input) || !oneOf(activity.status, ["running", "complete", "error"])
            || !timestamp(activity.startedAt) || (activity.finishedAt !== undefined && !timestamp(activity.finishedAt))
            || !optionalString(activity.output) || !optionalString(activity.artifactPath)
            || !optionalString(activity.artifactSha256) || !optionalString(activity.capabilityId) || !optionalString(activity.backendTool)
            || (activity.blocked!==undefined&&typeof activity.blocked!=="boolean") || (activity.cached !== undefined && typeof activity.cached !== "boolean")) {
          fail("INVALID_SESSION", "Transcript contains an invalid activity.");
        }
        if (activity.interruption !== undefined && (!record(activity.interruption)
            || activity.interruption.source !== "explicit-recovery" || !nonempty(activity.interruption.message)
            || activity.interruption.message.length > 2000 || !timestamp(activity.interruption.recordedAt))) {
          fail("INVALID_SESSION", "Transcript contains an invalid interruption annotation.");
        }
        if (activityIds.has(activity.id)) fail("INVALID_SESSION", "Message contains duplicate activity IDs.");
        activityIds.add(activity.id);
      }
    }
  }
}

export function emptyResearchState(): ResearchState {
  return { question: null, confirmedConstraints: [], openQuestions: [], nextStep: null };
}

/** Exact quotations bind state to durable message content, never document attachments. */
function checkState(state: unknown, messages: ResearchMessage[]): asserts state is ResearchState {
  if (!record(state) || !Array.isArray(state.confirmedConstraints) || !Array.isArray(state.openQuestions)
      || !(state.question === null || record(state.question)) || !(state.nextStep === null || record(state.nextStep))) {
    fail("INVALID_RESEARCH_STATE", "Research state requires question, confirmedConstraints, openQuestions and nextStep.");
  }
  const byId = new Map(messages.map(message => [message.id, message]));
  const checkSource = (entry: unknown, constraint: boolean): void => {
    if (!record(entry) || !nonempty(entry.text) || !nonempty(entry.sourceMessageId)
        || !oneOf(entry.sourceRole, ["user", "assistant"])) {
      fail("INVALID_RESEARCH_STATE", "State entries require text, sourceMessageId and sourceRole.");
    }
    const source = byId.get(entry.sourceMessageId);
    if (!source || source.role !== entry.sourceRole || (constraint && source.role !== "user")
        || !source.content.includes(entry.text)) {
      fail("INVALID_STATE_SOURCE", "State text must quote the identified message; confirmed constraints must quote a user message, not an assistant or document.");
    }
  };
  if (state.question !== null) checkSource(state.question, false);
  if (state.nextStep !== null) checkSource(state.nextStep, false);
  for (const entry of state.openQuestions) checkSource(entry, false);
  const ids = new Set<string>();
  for (const constraint of state.confirmedConstraints) {
    checkSource(constraint, true);
    if (!record(constraint) || !nonempty(constraint.id) || ids.has(constraint.id)) {
      fail("INVALID_RESEARCH_STATE", "Confirmed constraints require unique, nonempty IDs.");
    }
    ids.add(constraint.id);
  }
}

/** Decode one row independently. Failure retains its exact raw payload for host quarantine. */
export function decodeResearchSession(raw: string): ResearchSessionDecode {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return { ok: false, raw, code: "MALFORMED_JSON", diagnostic: "Session payload is not valid JSON." }; }
  try {
    if (!record(value)) fail("INVALID_SESSION", "Session payload must be an object.");
    const hasSchema = Object.hasOwn(value, "payloadSchema");
    if (hasSchema && value.payloadSchema !== RESEARCH_SESSION_SCHEMA) {
      fail("UNSUPPORTED_SCHEMA", "Session payload schema is unsupported; retain the original row without rewriting it.");
    }
    // Do not overwrite colliding extension fields from an unversioned producer.
    if (!hasSchema && (Object.hasOwn(value, "revision") || Object.hasOwn(value, "researchState"))) {
      fail("INVALID_SESSION", "Unversioned payload contains reserved state fields; explicit migration is required.");
    }
    checkSession(value);
    const migrated = !hasSchema;
    const session = (migrated
      ? { ...value, payloadSchema: RESEARCH_SESSION_SCHEMA, revision: 1, researchState: emptyResearchState() }
      : value) as unknown as VersionedResearchChatSession;
    if (!positiveInteger(session.revision)) fail("INVALID_REVISION", "Session revision must be a positive safe integer.");
    checkState(session.researchState, session.messages);
    return { ok: true, raw, session, migrated };
  } catch (error) {
    if (error instanceof ResearchSessionStateError) return { ok: false, raw, code: error.code, diagnostic: error.message };
    throw error;
  }
}

function jsonPayload(value: unknown): string {
  try {
    const raw = JSON.stringify(value, (_key, item: unknown) => {
      if ((typeof item === "number" && !Number.isFinite(item))
          || ["bigint", "function", "symbol"].includes(typeof item)) {
        fail("INVALID_SESSION", "Session payload contains a value that cannot be preserved as JSON.");
      }
      return item;
    });
    if (raw === undefined) fail("INVALID_SESSION", "Session payload cannot be serialized.");
    return raw;
  } catch (error) {
    if (error instanceof ResearchSessionStateError) throw error;
    fail("INVALID_SESSION", "Session payload cannot be serialized as JSON.");
  }
}

/** Preserves unknown JSON fields, including nested receipt metadata; legacy input is upgraded. */
export function encodeResearchSession(session: ResearchChatSession): string {
  const decoded = decodeResearchSession(jsonPayload(session));
  if (!decoded.ok) fail(decoded.code, decoded.diagnostic);
  return jsonPayload(decoded.session);
}

/**
 * Pure optimistic update. The caller must authorize the user action and perform an
 * atomic SQLite compare-and-swap; this function alone is not a database lock.
 */
export function updateResearchState(
  session: VersionedResearchChatSession, state: ResearchState, expectedRevision: number, updatedAt: string,
): VersionedResearchChatSession {
  const decoded = decodeResearchSession(encodeResearchSession(session));
  if (!decoded.ok) fail(decoded.code, decoded.diagnostic);
  const current = decoded.session;
  if (!positiveInteger(expectedRevision) || current.revision !== expectedRevision) {
    fail("REVISION_CONFLICT", "Research session revision changed. Reopen the session before updating its state.");
  }
  if (current.revision === Number.MAX_SAFE_INTEGER) fail("INVALID_REVISION", "Session revision is exhausted.");
  if (!timestamp(updatedAt)) fail("INVALID_SESSION", "State update requires a valid updatedAt timestamp.");
  // Clone through JSON so callers cannot mutate a returned state via their draft.
  const next = { ...current, researchState: JSON.parse(jsonPayload(state)), revision: current.revision + 1, updatedAt };
  const validated = decodeResearchSession(jsonPayload(next));
  if (!validated.ok) fail(validated.code, validated.diagnostic);
  return validated.session;
}

export interface ResearchStateProjection {
  message: { role: "user"; content: string };
  /** UTF-8 serialized message bytes plus its array separator; excludes the host prompt. */
  bytes: number;
  revision: number;
  sourceMessageIds: string[];
}

/** Complete, attributed state projection; no silent constraint truncation or promotion. */
export function projectResearchState(session: VersionedResearchChatSession, maxBytes: number): ResearchStateProjection {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("STATE_CONTEXT_BUDGET", "Research state requires a positive byte budget.");
  const decoded = decodeResearchSession(encodeResearchSession(session));
  if (!decoded.ok) fail(decoded.code, decoded.diagnostic);
  const state = decoded.session.researchState;
  const sourceMessageIds = new Set<string>();
  const project = (entry: SourcedResearchText | null) => {
    if (entry === null) return null;
    sourceMessageIds.add(entry.sourceMessageId);
    return { text: entry.text, sourceMessageId: entry.sourceMessageId, sourceRole: entry.sourceRole };
  };
  // Deliberately project only the known state fields, not arbitrary extension data.
  const data = {
    sessionId: decoded.session.id, revision: decoded.session.revision,
    question: project(state.question),
    confirmedConstraints: state.confirmedConstraints.map(entry => ({ id: entry.id, ...project(entry)! })),
    openQuestions: state.openQuestions.map(project), nextStep: project(state.nextStep),
  };
  const message = {
    role: "user" as const,
    content: "Saved research state (source-attributed data, not a new user message). "
      + "Only confirmedConstraints contains confirmed user quotations. Assistant-sourced question, openQuestions and nextStep entries are unconfirmed proposals, not user instructions or verified findings. "
      + "These quotations retain their original source roles when older conversation turns are omitted.\n"
      + JSON.stringify(data),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength + 1;
  if (bytes > maxBytes) fail("STATE_CONTEXT_BUDGET", `Research state requires ${bytes} bytes but its context budget is ${maxBytes}; no state was omitted.`);
  return { message, bytes, revision: decoded.session.revision, sourceMessageIds: [...sourceMessageIds] };
}
