/** User-authored claims and source snapshots; these are not model-generated verdicts. */
export type ResearchClaimRelation = "supports" | "contradicts" | "context";
export type ResearchClaimReviewState = "unreviewed" | "reviewed";
export interface ResearchClaimReadingScope {
  unitIndices: number[];
  start: number; end: number;
  offsetUnit: "utf16-code-units";
  fullDocument: false;
  meaning: "returned-source-range-only";
}
export interface ResearchClaimSourceBinding {
  documentId: string; documentRevision: number; documentName: string;
  kind: "text" | "parsed";
  documentSha256: string;
  sourcePath: string | null; sourceSha256: string | null;
  originalSourcePath: string | null; originalSourceSha256: string | null;
  extractionPath: string | null; extractionSha256: string | null;
  textArtifactPath: string | null; textArtifactSha256: string | null;
  unitIndex: number; locator: string; unitSha256: string;
  totalCharacters: number; totalUnits: number;
}
export interface ResearchClaimSourceRead extends ResearchClaimSourceBinding {
  readId: string; unitText: string; textStart: number; textEnd: number;
  readingScope: ResearchClaimReadingScope;
}
export interface ResearchClaimSourceSnapshot extends ResearchClaimSourceBinding {
  excerpt: string; quoteStart: number; quoteEnd: number;
  readingScope: ResearchClaimReadingScope;
  readAt: string;
}
export interface ResearchClaimFreshness {
  status: "current" | "stale" | "unavailable";
  checkedAt: string; code: string; message: string;
}
export interface ResearchClaimInvalidation {
  observedAt: string; code: string; message: string;
}
export interface ResearchClaimEvidence {
  id: string; relation: ResearchClaimRelation; source: ResearchClaimSourceSnapshot;
  /** Sticky first observed invalidation; rereading the old bytes does not clear it. */
  invalidated?: ResearchClaimInvalidation;
  /** Disposable host projection, recomputed on get/list; never trusted from storage. */
  freshness?: ResearchClaimFreshness;
}
export interface ResearchClaimReview {
  state: ResearchClaimReviewState;
  decidedAt: string | null;
  actor: "user" | null;
  /** Host projection: the historical decision is retained but cannot certify changed sources. */
  needsReconfirmation?: boolean;
}
export interface ResearchClaimVersion {
  revision: number; text: string; evidence: ResearchClaimEvidence[];
  review: ResearchClaimReview; updatedAt: string;
}
export interface ResearchClaim extends ResearchClaimVersion {
  id: string; createdAt: string;
  history: ResearchClaimVersion[];
  freshness?: ResearchClaimFreshness;
}
export type ResearchClaimEvidenceInput =
  | { readId: string; start: number; end: number; quote: string; relation: ResearchClaimRelation }
  | { evidenceId: string; relation: ResearchClaimRelation };
export interface ResearchClaimSummary {
  total: number; reviewed: number; unreviewed: number;
  current: number; stale: number; unavailable: number;
}
export const RESEARCH_CLAIM_LIMITS = {
  claims: 16, evidence: 8, history: 10, claimCharacters: 8000,
  quoteCharacters: 2000, previewCharacters: 12000,
} as const;

/** Stored shape checks; current source authority is always recomputed by the host. */
export function assertResearchClaims(value: unknown): asserts value is ResearchClaim[] {
  const object = (entry: unknown): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry);
  const string = (entry: unknown, maximum = 4096): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= maximum;
  const integer = (entry: unknown, minimum = 0): entry is number => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= minimum;
  const digest = (entry: unknown) => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry);
  const date = (entry: unknown) => string(entry, 100) && Number.isFinite(Date.parse(entry));
  const choice = (entry: unknown, values: readonly string[]) => typeof entry === "string" && values.includes(entry);
  function reject(): never { throw new Error("Stored research claim shape, source range or review record is invalid."); }
  const review = (entry: unknown) => {
    if (!object(entry) || !choice(entry.state, ["unreviewed", "reviewed"]) || !(entry.actor === null || entry.actor === "user")
        || !(entry.decidedAt === null || date(entry.decidedAt)) || (entry.state === "reviewed" && (entry.actor !== "user" || !date(entry.decidedAt)))) reject();
  };
  const evidence = (entries: unknown) => {
    if (!Array.isArray(entries) || entries.length > RESEARCH_CLAIM_LIMITS.evidence) reject();
    const ids = new Set<string>();
    for (const entry of entries as unknown[]) {
      if (!object(entry) || !string(entry.id, 128) || ids.has(entry.id) || !choice(entry.relation, ["supports", "contradicts", "context"]) || !object(entry.source)) reject();
      ids.add(entry.id as string);
      const source = entry.source as Record<string, unknown>;
      if (!string(source.documentId, 128) || !integer(source.documentRevision, 1) || !string(source.documentName, 120)
          || !choice(source.kind, ["text", "parsed"]) || !digest(source.documentSha256) || !digest(source.unitSha256)
          || !integer(source.unitIndex) || !integer(source.totalUnits, 1) || source.unitIndex >= source.totalUnits
          || !integer(source.totalCharacters) || !string(source.locator, 1000) || !date(source.readAt)
          || !string(source.excerpt, RESEARCH_CLAIM_LIMITS.quoteCharacters) || !integer(source.quoteStart) || !integer(source.quoteEnd, 1)
          || source.quoteEnd <= source.quoteStart || source.quoteEnd > source.totalCharacters || source.excerpt.length !== source.quoteEnd - source.quoteStart
          || !object(source.readingScope)) reject();
      for (const field of ["source", "originalSource", "extraction", "textArtifact"]) {
        const path = source[`${field}Path`], sha256 = source[`${field}Sha256`];
        if (!(path === null && sha256 === null) && !(string(path) && digest(sha256))) reject();
      }
      const scope = source.readingScope as Record<string, unknown>;
      if (!Array.isArray(scope.unitIndices) || scope.unitIndices.length !== 1 || scope.unitIndices[0] !== source.unitIndex
          || scope.offsetUnit !== "utf16-code-units" || scope.fullDocument !== false || scope.meaning !== "returned-source-range-only"
          || !integer(scope.start) || !integer(scope.end) || scope.start > source.quoteStart || scope.end < source.quoteEnd || scope.end > source.totalCharacters) reject();
      if (entry.invalidated !== undefined && (!object(entry.invalidated) || !date(entry.invalidated.observedAt)
          || !string(entry.invalidated.code, 128) || !string(entry.invalidated.message, 2000))) reject();
    }
  };
  const version = (entry: unknown) => {
    if (!object(entry) || !integer(entry.revision, 1) || !string(entry.text, RESEARCH_CLAIM_LIMITS.claimCharacters) || !date(entry.updatedAt)) reject();
    evidence(entry.evidence); review(entry.review);
  };
  if (!Array.isArray(value) || value.length > RESEARCH_CLAIM_LIMITS.claims) reject();
  const ids = new Set<string>();
  for (const claim of value as unknown[]) {
    version(claim);
    if (!object(claim) || !string(claim.id, 128) || ids.has(claim.id) || !date(claim.createdAt)
        || !Array.isArray(claim.history) || claim.history.length > RESEARCH_CLAIM_LIMITS.history) reject();
    ids.add(claim.id as string);
    for (const previous of claim.history as unknown[]) version(previous);
  }
}
