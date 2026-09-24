import { createHash, randomUUID } from "node:crypto";
import type { ResearchChatSession, ResearchDocument } from "../../shared/research-chat.ts";
import {
  RESEARCH_CLAIM_LIMITS, assertResearchClaims, type ResearchClaim, type ResearchClaimEvidence,
  type ResearchClaimEvidenceInput, type ResearchClaimFreshness, type ResearchClaimInvalidation,
  type ResearchClaimSourceBinding, type ResearchClaimSourceRead, type ResearchClaimSourceSnapshot,
  type ResearchClaimSummary, type ResearchClaimVersion,
} from "../../shared/research-claims.ts";
import { DOCUMENT_INPUT_LIMIT, readContained, readResearchDocument } from "./research-documents.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
type LoadedSource = { binding: ResearchClaimSourceBinding; text: string };
type SourceProblem = { status: "stale" | "unavailable"; code: string; message: string; invalidate: boolean };
export interface ClaimVerificationContext {
  remainingDocuments: number;
  cache: Map<string, Promise<LoadedSource | SourceProblem>>;
}
export function claimVerificationContext(): ClaimVerificationContext { return { remainingDocuments: 8, cache: new Map() }; }
class ClaimSourceError extends Error {
  readonly status: "stale" | "unavailable";
  readonly code: string;
  constructor(status: "stale" | "unavailable", code: string, message: string) { super(message); this.status = status; this.code = code; }
}
function problem(error: unknown): SourceProblem {
  return error instanceof ClaimSourceError ? { status: error.status, code: error.code, message: error.message, invalidate: true }
    : { status: "unavailable", code: "SOURCE_UNAVAILABLE", message: "The saved source cannot be safely reopened. Its original snapshot is retained.", invalidate: true };
}
function boundary(text: string, index: number): boolean {
  return !(index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]));
}
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false;
  }
  return true;
}
function boundPath(session: ResearchChatSession, document: ResearchDocument, path: string): void {
  const expected = `build/chat/${session.id}/documents/${document.id}/`;
  if (!path.replaceAll("\\", "/").startsWith(expected) || path.replaceAll("\\", "/").split("/").includes("..")) {
    throw new ClaimSourceError("unavailable", "SOURCE_MEMBERSHIP", "Saved extraction artifacts do not belong to this session document.");
  }
}
function fingerprint(binding: ResearchClaimSourceBinding): string {
  return JSON.stringify(Object.fromEntries(Object.entries(binding).sort(([a], [b]) => a.localeCompare(b))));
}
function version(claim: ResearchClaim): ResearchClaimVersion {
  const evidence = structuredClone(claim.evidence);
  for (const entry of evidence) delete entry.freshness;
  const review = { ...claim.review }; delete review.needsReconfirmation;
  return { revision: claim.revision, text: claim.text, evidence, review, updatedAt: claim.updatedAt };
}
function cleanClaims(claims: ResearchClaim[]): void {
  for (const claim of claims) {
    delete claim.freshness;
    for (const item of [claim, ...claim.history]) {
      delete item.review.needsReconfirmation;
      for (const evidence of item.evidence) delete evidence.freshness;
    }
  }
}
function summarize(claims: ResearchClaim[]): ResearchClaimSummary {
  const summary: ResearchClaimSummary = { total: claims.length, reviewed: 0, unreviewed: 0, current: 0, stale: 0, unavailable: 0 };
  for (const claim of claims) { summary[claim.review.state]++; summary[claim.freshness!.status]++; }
  return summary;
}
function editable(claim: ResearchClaim): void {
  if (claim.history.length >= RESEARCH_CLAIM_LIMITS.history) throw new Error("This claim reached its preserved history limit. Create a new claim; old versions will not be silently discarded.");
  if (claim.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Claim revision is exhausted.");
}

/** No arbitrary user paths: all reads derive from a session-owned document. */
export class ResearchClaimsService {
  private workspace: string;
  private reads = new Map<string, { sessionId: string; preview: ResearchClaimSourceRead; readAt: string; expires: number }>();
  private projectionCursors = new Map<string, number>();
  constructor(workspace: string) { this.workspace = workspace; }

  deferred(session: ResearchChatSession, message: string) {
    const claims = structuredClone(session.claims ?? []); assertResearchClaims(claims); cleanClaims(claims);
    for (const claim of claims) {
      for (const entry of claim.evidence) entry.freshness = { status: entry.invalidated ? "stale" : "unavailable", checkedAt: now(),
        code: entry.invalidated ? "PREVIOUSLY_INVALIDATED" : "VERIFICATION_BUDGET", message: entry.invalidated ? "This evidence was previously invalidated. Reread and replace its source before reviewing it." : message };
      claim.freshness = claim.evidence.find(entry => entry.invalidated)?.freshness ?? { status: "unavailable", checkedAt: now(), code: "VERIFICATION_BUDGET", message };
      claim.review.needsReconfirmation = claim.review.state === "reviewed";
    }
    return { claims, summary: summarize(claims), invalidations: [] as { claimId: string; evidenceId: string; invalidation: ResearchClaimInvalidation }[] };
  }

  private async load(session: ResearchChatSession, documentId: string, unitIndex: number): Promise<LoadedSource> {
    const document = session.documents.find(entry => entry.id === documentId);
    if (!document) throw new ClaimSourceError("unavailable", "DOCUMENT_UNAVAILABLE", "The source document is no longer attached to this session.");
    if (!Number.isSafeInteger(unitIndex) || unitIndex < 0) throw new Error("Choose a valid source unit index.");
    let sourcePath: string | null = null, sourceSha256: string | null = null;
    let originalSourcePath: string | null = null, originalSourceSha256: string | null = null;
    let extractionPath: string | null = null, extractionSha256: string | null = null;
    let textArtifactPath: string | null = null, textArtifactSha256: string | null = null;
    let text = document.content, locator = "Editable text", totalUnits = 1;
    if (document.extraction) {
      const extraction = document.extraction;
      for (const path of [extraction.sourcePath, extraction.extractionPath, extraction.textPath]) boundPath(session, document, path);
      sourcePath = extraction.sourcePath;
      sourceSha256 = hash(await readContained(this.workspace, sourcePath, DOCUMENT_INPUT_LIMIT));
      if (sourceSha256 !== document.sourceSha256) throw new ClaimSourceError("stale", "SOURCE_BYTES_CHANGED", "The saved original source bytes changed; the old extraction cannot recertify them.");
      extractionPath = extraction.extractionPath;
      extractionSha256 = hash(await readContained(this.workspace, extractionPath, 24 * 1024 * 1024));
      if (extractionSha256 !== extraction.extractionSha256) throw new ClaimSourceError("stale", "EXTRACTION_CHANGED", "The saved extraction bytes changed.");
      textArtifactPath = extraction.textPath;
      textArtifactSha256 = hash(await readContained(this.workspace, textArtifactPath, 24 * 1024 * 1024));
      const page = await readResearchDocument(this.workspace, document, unitIndex, 1);
      const unit = page.units[0];
      if (!unit || unit.index !== unitIndex || typeof unit.text !== "string" || typeof unit.locator !== "string") throw new ClaimSourceError("unavailable", "SOURCE_UNIT_UNAVAILABLE", "The selected source unit is absent or invalid.");
      text = unit.text; locator = unit.locator; totalUnits = page.totalUnits;
    } else if (unitIndex !== 0) {
      throw new ClaimSourceError("unavailable", "SOURCE_UNIT_UNAVAILABLE", "Editable text documents use unit index 0.");
    }
    if (document.source && document.source !== sourcePath) {
      originalSourcePath = document.source;
      originalSourceSha256 = hash(await readContained(this.workspace, originalSourcePath, document.extraction ? DOCUMENT_INPUT_LIMIT : 128_000));
      if (document.sourceSha256 && originalSourceSha256 !== document.sourceSha256) throw new ClaimSourceError("stale", "ORIGINAL_SOURCE_CHANGED", "The original workspace source changed; the saved document remains a historical snapshot.");
    }
    return { text, binding: {
      documentId, documentRevision: document.revision, documentName: document.name, kind: document.extraction ? "parsed" : "text",
      documentSha256: hash(document.content), sourcePath, sourceSha256, originalSourcePath, originalSourceSha256,
      extractionPath, extractionSha256, textArtifactPath, textArtifactSha256,
      unitIndex, locator, unitSha256: hash(text), totalCharacters: text.length, totalUnits,
    } };
  }

  async readSource(session: ResearchChatSession, input: { documentId: string; unitIndex?: number; startOffset?: number }): Promise<ResearchClaimSourceRead> {
    const loaded = await this.load(structuredClone(session), input.documentId, input.unitIndex ?? 0);
    const start = input.startOffset ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start >= loaded.text.length || !boundary(loaded.text, start)) throw new Error("Choose a valid UTF-16 source offset; do not split a surrogate pair.");
    let end = Math.min(loaded.text.length, start + RESEARCH_CLAIM_LIMITS.previewCharacters);
    if (!boundary(loaded.text, end)) end--;
    const preview: ResearchClaimSourceRead = {
      ...loaded.binding, readId: randomUUID(), unitText: loaded.text.slice(start, end), textStart: start, textEnd: end,
      readingScope: { unitIndices: [loaded.binding.unitIndex], start, end, offsetUnit: "utf16-code-units", fullDocument: false, meaning: "returned-source-range-only" },
    };
    while (this.reads.size >= 128) this.reads.delete(this.reads.keys().next().value!);
    this.reads.set(preview.readId, { sessionId: session.id, preview, readAt: now(), expires: Date.now() + 30 * 60_000 });
    return structuredClone(preview);
  }

  private async createEvidence(session: ResearchChatSession, input: Extract<ResearchClaimEvidenceInput, { readId: string }>): Promise<ResearchClaimEvidence> {
    const read = this.reads.get(input.readId);
    if (!read || read.sessionId !== session.id || read.expires < Date.now()) throw new Error("This source preview is unavailable or expired. Reopen the source in this session.");
    const preview = read.preview;
    if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.start < 0 || input.end <= input.start || input.end > preview.unitText.length
        || !boundary(preview.unitText, input.start) || !boundary(preview.unitText, input.end)
        || input.quote.length > RESEARCH_CLAIM_LIMITS.quoteCharacters || !input.quote.trim() || !wellFormed(input.quote)
        || preview.unitText.slice(input.start, input.end) !== input.quote) throw new Error("Quote text and exact UTF-16 offsets must match the returned source range without splitting a surrogate pair.");
    const loaded = await this.load(session, preview.documentId, preview.unitIndex);
    const { readId: _readId, unitText: _unitText, textStart: _start, textEnd: _end, readingScope: _scope, ...binding } = preview;
    if (fingerprint(loaded.binding) !== fingerprint(binding)) throw new ClaimSourceError("stale", "SOURCE_PREVIEW_CHANGED", "Source identity or content changed after preview. Read it again before saving evidence.");
    const source: ResearchClaimSourceSnapshot = { ...loaded.binding, excerpt: input.quote,
      quoteStart: preview.textStart + input.start, quoteEnd: preview.textStart + input.end,
      readingScope: structuredClone(preview.readingScope), readAt: read.readAt };
    return { id: randomUUID(), relation: input.relation, source };
  }

  async saveClaim(session: ResearchChatSession, input: { claimId?: string; text: string; evidence: ResearchClaimEvidenceInput[] }): Promise<ResearchClaim[]> {
    const claims = structuredClone(session.claims ?? []); assertResearchClaims(claims); cleanClaims(claims);
    const previous = input.claimId ? claims.find(claim => claim.id === input.claimId) : undefined;
    if (input.claimId && !previous) throw new Error("Claim does not belong to this session.");
    if (previous) editable(previous);
    else if (claims.length >= RESEARCH_CLAIM_LIMITS.claims) throw new Error("This session reached its claim limit; existing claims are retained.");
    const evidence: ResearchClaimEvidence[] = [];
    const reused = new Set<string>();
    for (const entry of input.evidence) {
      if ("readId" in entry) evidence.push(await this.createEvidence(session, entry));
      else {
        const existing = previous?.evidence.find(candidate => candidate.id === entry.evidenceId);
        if (!existing || reused.has(existing.id)) throw new Error("Existing evidence must be unique and belong to the edited claim.");
        reused.add(existing.id);
        const copy = structuredClone(existing); delete copy.freshness; copy.relation = entry.relation; evidence.push(copy);
      }
    }
    const citations = new Set<string>();
    for (const entry of evidence) {
      const { excerpt: _excerpt, quoteStart, quoteEnd, readingScope: _scope, readAt: _readAt, ...binding } = entry.source;
      const key = `${fingerprint(binding)}:${quoteStart}:${quoteEnd}`;
      if (citations.has(key)) throw new Error("This exact source passage is already cited in the claim. Edit its relation instead of adding duplicate evidence.");
      citations.add(key);
    }
    const stamp = now();
    const claim: ResearchClaim = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, text: input.text,
      evidence, review: { state: "unreviewed", decidedAt: null, actor: null }, createdAt: previous?.createdAt ?? stamp, updatedAt: stamp,
      history: previous ? [...previous.history, version(previous)] : [] };
    if (previous) claims[claims.indexOf(previous)] = claim; else claims.push(claim);
    assertResearchClaims(claims); return claims;
  }

  async project(session: ResearchChatSession, context = claimVerificationContext(), priorityClaimId?: string) {
    const claims = structuredClone(session.claims ?? []); assertResearchClaims(claims); cleanClaims(claims);
    const invalidations: { claimId: string; evidenceId: string; invalidation: ResearchClaimInvalidation }[] = [];
    // Rotate the bounded work across requests. A target mutation checks that
    // claim first; unchecked entries never inherit a prior "current" status.
    const cursor = this.projectionCursors.get(session.id) ?? 0;
    const priorityIndex = priorityClaimId ? claims.findIndex(claim => claim.id === priorityClaimId) : -1;
    const start = priorityIndex >= 0 ? priorityIndex : cursor % Math.max(1, claims.length);
    this.projectionCursors.set(session.id, (start + 1) % Math.max(1, claims.length));
    const ordered = [...claims.slice(start), ...claims.slice(0, start)];
    for (const claim of ordered) {
      delete claim.freshness;
      for (const entry of claim.evidence) {
        const source = entry.source;
        const key = `${session.id}:${source.documentId}:${source.unitIndex}`;
        let checked = context.cache.get(key);
        if (!checked) {
          checked = context.remainingDocuments-- > 0
            ? this.load(session, source.documentId, source.unitIndex).catch(problem)
            : Promise.resolve({ status: "unavailable", code: "VERIFICATION_BUDGET", message: "Source was not reopened within this snapshot's verification budget; no current-source claim is made.", invalidate: false } as SourceProblem);
          context.cache.set(key, checked);
        }
        const current = await checked;
        let failure: SourceProblem | undefined;
        if ("status" in current) failure = current;
        else {
          const { excerpt, quoteStart, quoteEnd, readingScope: _scope, readAt: _readAt, ...binding } = source;
          if (!excerpt.trim() || !wellFormed(excerpt) || !boundary(current.text, quoteStart) || !boundary(current.text, quoteEnd)
              || !boundary(current.text, _scope.start) || !boundary(current.text, _scope.end)) {
            failure = { status: "stale", code: "SOURCE_RANGE_INVALID", message: "The stored citation range is blank or splits a Unicode surrogate pair. Read and select the source again.", invalidate: true };
          } else if (fingerprint(current.binding) !== fingerprint(binding) || current.text.slice(quoteStart, quoteEnd) !== excerpt) {
            failure = { status: "stale", code: "SOURCE_SNAPSHOT_CHANGED", message: "Document version, content, source identity or artifact bytes differ from the preserved evidence snapshot.", invalidate: true };
          } else if (entry.invalidated) {
            failure = { status: "stale", code: "PREVIOUSLY_INVALIDATED", message: "This evidence previously became stale or unavailable. Read the source again and replace the evidence before reviewing it; restored bytes do not recertify it.", invalidate: false };
          }
        }
        if (failure?.invalidate && !entry.invalidated) {
          entry.invalidated = { observedAt: now(), code: failure.code, message: failure.message };
          invalidations.push({ claimId: claim.id, evidenceId: entry.id, invalidation: entry.invalidated });
        }
        entry.freshness = { status: failure?.status ?? "current", checkedAt: now(), code: failure?.code ?? "SOURCE_MATCH", message: failure?.message ?? "Preserved source snapshot matches the currently reopened source; this is not a scientific verdict." };
      }
      const problemEntry = claim.evidence.find(entry => entry.freshness?.status === "unavailable") ?? claim.evidence.find(entry => entry.freshness?.status === "stale");
      claim.freshness = problemEntry?.freshness ?? { status: claim.evidence.length ? "current" : "unavailable", checkedAt: now(),
        code: claim.evidence.length ? "SOURCE_MATCH" : "NO_EVIDENCE", message: claim.evidence.length ? "All evidence sources currently match their preserved snapshots." : "No source evidence is attached to this claim." };
      claim.review.needsReconfirmation = claim.review.state === "reviewed" && claim.freshness.status !== "current";
    }
    return { claims, summary: summarize(claims), invalidations };
  }

  async reviewClaim(session: ResearchChatSession, input: { claimId: string; state: "reviewed" | "unreviewed" }): Promise<ResearchClaim[]> {
    const claims = structuredClone(session.claims ?? []); assertResearchClaims(claims); cleanClaims(claims);
    const claim = claims.find(entry => entry.id === input.claimId);
    if (!claim) throw new Error("Claim does not belong to this session.");
    const projected = await this.project({ ...session, claims: [claim] });
    const current = projected.claims.find(entry => entry.id === input.claimId);
    if (!claim || !current) throw new Error("Claim does not belong to this session.");
    if (input.state === "reviewed" && current.freshness?.status !== "current") throw new Error("All evidence must match current sources and have no prior invalidation. Re-read and replace stale evidence before reviewing.");
    editable(claim);
    claim.history.push(version(claim)); claim.revision++; claim.updatedAt = now();
    claim.review = { state: input.state, decidedAt: claim.updatedAt, actor: "user" };
    assertResearchClaims(claims); return claims;
  }
}
