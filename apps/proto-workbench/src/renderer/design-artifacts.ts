export interface DesignRunStepSummary {
  id: string;
  ok: boolean;
  required: boolean;
  skipped: boolean;
}

export interface DesignRunProvenance {
  manifestPath: string;
  runId: string;
  createdAt?: string;
  sourcePath?: string;
  partsPath?: string;
  sourceSha256?: string;
  partsSha256?: string;
  reviewStatus: string;
  ok: boolean;
  summary?: string;
  artifactPaths: string[];
  steps: DesignRunStepSummary[];
  binding: "path-only";
}

export interface DesignArtifactDigestRecord {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface DesignProvenanceStatement {
  statementPath: string;
  runId: string;
  createdAt?: string;
  subjectSha256: string;
  artifacts: DesignArtifactDigestRecord[];
}

export interface DesignArtifactDigestDeclaration {
  status: "match" | "mismatch";
  statement: DesignProvenanceStatement;
  record: DesignArtifactDigestRecord;
}

export interface DesignArtifactDigestBinding extends DesignArtifactDigestDeclaration {
  /** Every digest claim for this path, retained in deterministic order. */
  declarations: DesignArtifactDigestDeclaration[];
  /** True when provenance statements declare different digest/size pairs for the same path. */
  conflict: boolean;
}

export type DesignProvenanceInventoryCandidate =
  | { path: string; statement: DesignProvenanceStatement; error?: never }
  | { path: string; statement?: never; error: string };

export interface DesignProvenanceInventoryDiagnostic {
  path: string;
  message: string;
}

export interface DesignProvenanceInventorySummary {
  complete: boolean;
  statements: DesignProvenanceStatement[];
  diagnostics: DesignProvenanceInventoryDiagnostic[];
}

export type ParsedDesignRunManifest =
  | { ok: true; manifest: DesignRunProvenance }
  | { ok: false; error: string };

export function normalizeWorkspaceRelativePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase();
}

export function parseDesignRunManifest(value: unknown, manifestPath: string): ParsedDesignRunManifest {
  if (!isRecord(value) || value.schema_version !== "proto-agent.run.v1") {
    return { ok: false, error: "The file is not a proto-agent.run.v1 manifest." };
  }
  if (typeof value.run_id !== "string" || value.run_id.trim().length === 0) {
    return { ok: false, error: "The run manifest does not declare a valid run_id." };
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.every((item) => typeof item === "string")) {
    return { ok: false, error: "The run manifest artifact inventory is missing or malformed." };
  }
  if (!Array.isArray(value.steps)) {
    return { ok: false, error: "The run manifest step journal is missing." };
  }

  const steps: DesignRunStepSummary[] = [];
  for (const raw of value.steps) {
    if (!isRecord(raw)
      || typeof raw.id !== "string"
      || typeof raw.ok !== "boolean"
      || typeof raw.required !== "boolean"
      || typeof raw.skipped !== "boolean") {
      return { ok: false, error: "The run manifest contains a malformed workflow step." };
    }
    steps.push({ id: raw.id, ok: raw.ok, required: raw.required, skipped: raw.skipped });
  }

  const inputs = isRecord(value.inputs) ? value.inputs : undefined;
  const digests = isRecord(value.input_digests) ? value.input_digests : undefined;
  const reviewStatus = typeof value.review_status === "string" && value.review_status.trim()
    ? value.review_status
    : "not-declared";
  return {
    ok: true,
    manifest: {
      manifestPath,
      runId: value.run_id,
      createdAt: typeof value.created_at === "string" ? value.created_at : undefined,
      sourcePath: typeof inputs?.design === "string" ? inputs.design : undefined,
      partsPath: typeof inputs?.parts === "string" ? inputs.parts : undefined,
      sourceSha256: isRecord(digests?.design) && isSha256(digests.design.sha256) ? digests.design.sha256 : undefined,
      partsSha256: isRecord(digests?.parts) && isSha256(digests.parts.sha256) ? digests.parts.sha256 : undefined,
      reviewStatus,
      ok: value.ok === true,
      summary: typeof value.summary === "string" ? value.summary : undefined,
      artifactPaths: value.artifacts.map((item) => normalizeWorkspaceRelativePath(item)),
      steps,
      binding: "path-only",
    },
  };
}

export function provenanceForArtifact(
  artifactRelativePath: string,
  manifests: ReadonlyArray<DesignRunProvenance>,
) {
  const normalized = normalizeWorkspaceRelativePath(artifactRelativePath);
  return manifests.find((manifest) => manifest.artifactPaths.includes(normalized));
}

export function parseDesignProvenanceStatement(value: unknown, statementPath: string):
  | { ok: true; statement: DesignProvenanceStatement }
  | { ok: false; error: string } {
  if (!isRecord(value) || value.schema_version !== "proto-agent.provenance.v1") {
    return { ok: false, error: "The file is not a proto-agent.provenance.v1 statement." };
  }
  if (typeof value.run_id !== "string" || !value.run_id.trim()) {
    return { ok: false, error: "The provenance statement does not declare a valid run_id." };
  }
  if (!isRecord(value.subject) || !isSha256(value.subject.sha256)) {
    return { ok: false, error: "The provenance subject digest is missing or malformed." };
  }
  if (!Array.isArray(value.artifacts)) {
    return { ok: false, error: "The provenance artifact digest inventory is missing." };
  }
  const artifacts: DesignArtifactDigestRecord[] = [];
  for (const raw of value.artifacts) {
    if (!isRecord(raw)
      || typeof raw.path !== "string"
      || !isSha256(raw.sha256)
      || typeof raw.size !== "number"
      || !Number.isSafeInteger(raw.size)
      || raw.size < 0) {
      return { ok: false, error: "The provenance statement contains a malformed artifact digest record." };
    }
    artifacts.push({ path: normalizeBuildRelativePath(raw.path), sha256: raw.sha256.toLocaleLowerCase(), sizeBytes: raw.size });
  }
  return {
    ok: true,
    statement: {
      statementPath,
      runId: value.run_id,
      createdAt: typeof value.created_at === "string" ? value.created_at : undefined,
      subjectSha256: value.subject.sha256.toLocaleLowerCase(),
      artifacts,
    },
  };
}

export function digestBindingForArtifact(
  artifactRelativePath: string,
  sha256: string,
  sizeBytes: number,
  statements: ReadonlyArray<DesignProvenanceStatement>,
): DesignArtifactDigestBinding | undefined {
  const key = normalizeBuildRelativePath(artifactRelativePath);
  const normalizedSha256 = sha256.toLocaleLowerCase();
  const declarations: DesignArtifactDigestDeclaration[] = [];
  for (const statement of statements) {
    for (const record of statement.artifacts) {
      if (record.path !== key) continue;
      declarations.push({
        status: record.sha256 === normalizedSha256 && record.sizeBytes === sizeBytes ? "match" : "mismatch",
        statement,
        record,
      });
    }
  }
  if (declarations.length === 0) return undefined;
  declarations.sort(compareDigestDeclarations);
  const distinctClaims = new Set(declarations.map(({ record }) => `${record.sha256}:${record.sizeBytes}`));
  const conflict = distinctClaims.size > 1;
  const status = conflict || declarations.some((declaration) => declaration.status === "mismatch")
    ? "mismatch"
    : "match";
  const representative = declarations.find((declaration) => declaration.status === status) ?? declarations[0];
  return { ...representative, status, declarations, conflict };
}

/**
 * Preserve every failed provenance candidate so callers can distinguish an
 * actually unlinked artifact from an inventory that could not be verified.
 */
export function summarizeDesignProvenanceInventory(
  candidates: ReadonlyArray<DesignProvenanceInventoryCandidate>,
): DesignProvenanceInventorySummary {
  const statements: DesignProvenanceStatement[] = [];
  const diagnostics: DesignProvenanceInventoryDiagnostic[] = [];
  for (const candidate of candidates) {
    if (candidate.statement) {
      statements.push(candidate.statement);
      continue;
    }
    diagnostics.push({
      path: candidate.path,
      message: candidate.error.trim() || "The provenance statement could not be verified.",
    });
  }
  return { complete: diagnostics.length === 0, statements, diagnostics };
}

function normalizeBuildRelativePath(value: string) {
  const normalized = normalizeWorkspaceRelativePath(value);
  return normalized.startsWith("build/") ? normalized.slice("build/".length) : normalized;
}

function compareDigestDeclarations(left: DesignArtifactDigestDeclaration, right: DesignArtifactDigestDeclaration): number {
  const leftKey = `${normalizeWorkspaceRelativePath(left.statement.statementPath)}\0${left.statement.runId}\0${left.record.sha256}\0${left.record.sizeBytes}`;
  const rightKey = `${normalizeWorkspaceRelativePath(right.statement.statementPath)}\0${right.statement.runId}\0${right.record.sha256}\0${right.record.sizeBytes}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
