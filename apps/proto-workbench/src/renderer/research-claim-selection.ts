import { RESEARCH_CLAIM_LIMITS, type ResearchClaim, type ResearchClaimEvidenceInput, type ResearchClaimSourceBinding, type ResearchClaimSourceRead } from "../shared/research-claims.ts";

/** Source offsets follow JavaScript / DOM UTF-16 indices, without normalization. */
export interface QuoteRange { start: number; end: number; quote: string }

function boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export function sourceSelection(text: string, start: number, end: number): QuoteRange | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > text.length
      || end <= start || !boundary(text, start) || !boundary(text, end)) return undefined;
  const quote = text.slice(start, end);
  return quote.trim() ? { start, end, quote } : undefined;
}

/** Textareas normalize CRLF/CR to LF; map DOM selection offsets back to the exact source. */
export function textareaSourceSelection(source: string, displayed: string, start: number, end: number): QuoteRange | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > displayed.length) return undefined;
  const offsets = [0], characters: string[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index++];
    if (character === "\r") {
      if (source[index] === "\n") index++;
      characters.push("\n");
    } else characters.push(character);
    offsets.push(index);
  }
  if (characters.join("") !== displayed) return undefined;
  return sourceSelection(source, offsets[start], offsets[end]);
}

/** Repeated wording must be disambiguated; never silently select its first occurrence. */
export function quoteOccurrences(text: string, quote: string): { ranges: QuoteRange[]; truncated: boolean } {
  if (!quote.trim()) return { ranges: [], truncated: false };
  const ranges: QuoteRange[] = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const range = sourceSelection(text, at, at + quote.length);
    if (!range) continue;
    if (ranges.length === 100) return { ranges, truncated: true };
    ranges.push(range);
  }
  return { ranges, truncated: false };
}

export function claimScope(workspace: string, sessionId: string): string {
  return JSON.stringify([workspace, sessionId]);
}

/** Component-lifetime and request-order authority; an old scope never becomes current again. */
export function createClaimRequestGate(initialScope: string) {
  let scope = initialScope, epoch = 0, active = true;
  const generations = { read: 0, mutation: 0 };
  type Token = { scope: string; epoch: number; kind: keyof typeof generations; generation: number };
  return {
    activate(next: string) { if (!active || next !== scope) epoch++; scope = next; active = true; },
    dispose() { active = false; epoch++; },
    invalidateRead() { generations.read++; },
    begin(kind: Token["kind"]): Token { return { scope, epoch, kind, generation: ++generations[kind] }; },
    accepts(token: Token) { return active && token.scope === scope && token.epoch === epoch && token.generation === generations[token.kind]; },
  };
}

/** A source response is a bounded, partial range from the requested document revision. */
export function matchesClaimSourceRead(source: ResearchClaimSourceRead | undefined, expected: {
  documentId: string; documentRevision: number; unitIndex: number; startOffset: number;
}): source is ResearchClaimSourceRead {
  if (!source || source.documentId !== expected.documentId || source.documentRevision !== expected.documentRevision
      || source.unitIndex !== expected.unitIndex || source.textStart !== expected.startOffset
      || typeof source.readId !== "string" || !source.readId || typeof source.unitText !== "string"
      || source.unitText.length > RESEARCH_CLAIM_LIMITS.previewCharacters || !source.unitText.length
      || !Number.isSafeInteger(source.textEnd) || source.textEnd !== source.textStart + source.unitText.length
      || !Number.isSafeInteger(source.totalCharacters) || source.totalCharacters < source.textEnd
      || !Number.isSafeInteger(source.totalUnits) || source.totalUnits <= source.unitIndex
      || !source.readingScope || source.readingScope.start !== source.textStart || source.readingScope.end !== source.textEnd
      || source.readingScope.offsetUnit !== "utf16-code-units" || source.readingScope.fullDocument !== false
      || source.readingScope.meaning !== "returned-source-range-only" || !Array.isArray(source.readingScope.unitIndices) || source.readingScope.unitIndices.length !== 1
      || source.readingScope.unitIndices[0] !== source.unitIndex) return false;
  return [source.documentSha256, source.unitSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

export function claimSourceReviewState(claim: ResearchClaim): { status: "current" | "pending" | "stale" | "unavailable"; canReview: boolean } {
  if (!claim.evidence.length) return { status: "unavailable", canReview: false };
  if (claim.evidence.some(item => item.invalidated || item.freshness?.status === "stale")) return { status: "stale", canReview: false };
  if (claim.evidence.some(item => item.freshness?.status === "unavailable" && item.freshness.code !== "VERIFICATION_BUDGET")) return { status: "unavailable", canReview: false };
  if (claim.evidence.some(item => !item.freshness)) return { status: "pending", canReview: false };
  if (claim.evidence.some(item => item.freshness?.code === "VERIFICATION_BUDGET")) return { status: "pending", canReview: true };
  return { status: "current", canReview: true };
}

/** Reading the same passage twice does not produce a second independent citation. */
export function claimCitationIdentity(source: ResearchClaimSourceBinding, start: number, end: number): string {
  return JSON.stringify([source.documentId, source.documentRevision, source.documentSha256,
    source.sourcePath, source.sourceSha256, source.originalSourcePath, source.originalSourceSha256,
    source.extractionPath, source.extractionSha256, source.textArtifactPath, source.textArtifactSha256,
    source.unitIndex, source.locator, source.unitSha256, start, end]);
}

export interface PendingClaimCitation {
  key: string; input: ResearchClaimEvidenceInput; title: string; quote: string;
  bindingKey: string; needsReread?: boolean;
}
export interface ClaimDraft { id?: string; revision: number; text: string; citations: PendingClaimCitation[] }

function withoutReadTokens(draft: ClaimDraft): ClaimDraft {
  const copy = structuredClone(draft);
  for (const citation of copy.citations) if ("readId" in citation.input) {
    citation.input.readId = ""; citation.needsReread = true;
  }
  return copy;
}

/** Explicit user action only; an existing claim must never be silently rebased. */
export function continueNewClaimDraft(draft: ClaimDraft, currentRevision: number): ClaimDraft {
  if (draft.id !== undefined || !Number.isSafeInteger(currentRevision) || currentRevision <= draft.revision)
    throw new Error("Only a new claim can continue against a newer conversation revision.");
  return { ...withoutReadTokens(draft), revision: currentRevision };
}

/** Drafts are temporary UI state. Host read tokens are deliberately not restored. */
export function createClaimDraftCache(limit = 16) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("A positive draft cache limit is required.");
  const entries = new Map<string, ClaimDraft>();
  return {
    get(scope: string): ClaimDraft | undefined {
      const draft = entries.get(scope);
      if (!draft) return undefined;
      entries.delete(scope); entries.set(scope, draft);
      return structuredClone(draft);
    },
    set(scope: string, draft: ClaimDraft | undefined): boolean {
      entries.delete(scope);
      if (!draft) return false;
      const copy = withoutReadTokens(draft);
      const evicted = entries.size >= limit;
      if (evicted) entries.delete(entries.keys().next().value!);
      entries.set(scope, copy); return evicted;
    },
  };
}
