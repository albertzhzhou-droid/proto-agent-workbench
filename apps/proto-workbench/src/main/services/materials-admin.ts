import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { MaterialsMaterializeRequest, MaterialsMaterializeResult } from "../../shared/contracts.ts";

export interface MaterialsRootPathOptions {
  configuredRoot?: string;
  isPackaged: boolean;
  documentsPath: string;
  repoRoot: string;
}

/** Resolve the shared CLI/Workbench catalogue root without embedding a user path. */
export function resolveMaterialsRootPath(options: MaterialsRootPathOptions): string {
  if (options.configuredRoot) {
    if (!isAbsolute(options.configuredRoot)) {
      throw new Error("PROTO_AGENT_MATERIALS_ROOT must be an absolute path");
    }
    return resolve(options.configuredRoot);
  }
  return options.isPackaged
    ? join(options.documentsPath, "Proto CLI Materials")
    : resolve(options.repoRoot, "..", "Proto CLI Materials");
}

/**
 * Resolve the bounded admin CLI inside PyInstaller's onedir layout.
 *
 * `build-proto-sidecar.ps1` stages the named distribution directory beneath
 * `runtime/proto-agent`, so the executable is intentionally nested one level
 * below the copied resource root.
 */
export function packagedMaterialsCliPath(resourcesPath: string): string {
  return join(
    resourcesPath,
    "runtime",
    "proto-agent",
    "proto-agent",
    "proto-agent.exe",
  );
}

const SHA256 = /^[a-f0-9]{64}$/;
const PYTHON_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const DNA_SEQUENCE = /^[ACGTUNRYKMSWBDHV]+$/;
const SUPPORTED_PART_TYPES = new Set(["promoter", "rbs", "cds", "terminator"]);
const PARTS_SCHEMA_VERSION = "proto-agent.parts-library.v1";
const PART_KEYS = [
  "description",
  "description_zh",
  "design_eligibility",
  "evidence_refs",
  "id",
  "license",
  "name",
  "resource_id",
  "review_status",
  "safety_flags",
  "safety_status",
  "sequence",
  "sequence_kind",
  "sequence_sha256",
  "source",
  "type",
] as const;
const LIBRARY_KEYS = ["chassis", "library_id", "notice", "parts", "schema_version", "version"] as const;

export interface MaterializedPartsArtifact {
  content: string;
  sha256: string;
}

/** Reproduce `MaterialsStore.materialize_parts` without trusting the sidecar receipt. */
export function materializedPartsSelectionDigest(request: MaterialsMaterializeRequest): string {
  const ids = canonicalRequestIds(request.resource_ids);
  const canonical = pythonCanonicalJson({
    snapshot_id: request.snapshot,
    chassis: request.chassis,
    ids,
  });
  return sha256(canonical);
}

/** Fail closed if the sidecar returns a selection outside its deterministic build path. */
export function validateMaterializedPartsResult(
  value: unknown,
  request: MaterialsMaterializeRequest,
): MaterialsMaterializeResult {
  const expectedDigest = materializedPartsSelectionDigest(request);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Materials materialization returned an invalid response.");
  }
  const result = value as Record<string, unknown>;
  const expectedPath = `build/materials/selections/${expectedDigest}/parts.json`;
  if (
    result.ok !== true
    || result.snapshot_id !== request.snapshot
    || result.selection_digest !== expectedDigest
    || result.parts_path !== expectedPath
    || result.part_count !== request.resource_ids.length
  ) {
    throw new Error("Materials materialization response failed its snapshot, digest, path, or count binding.");
  }
  return {
    ok: true,
    snapshot_id: request.snapshot,
    selection_digest: expectedDigest,
    parts_path: expectedPath,
    part_count: request.resource_ids.length,
  };
}

/**
 * Validate the generated library itself rather than accepting a plausible
 * sidecar receipt. The workspace reader supplies a bounded, no-follow file
 * observation; this function binds that exact observation to the request.
 */
export function validateMaterializedPartsArtifact(
  artifact: MaterializedPartsArtifact,
  request: MaterialsMaterializeRequest,
  receipt: MaterialsMaterializeResult,
): MaterialsMaterializeResult {
  const expectedIds = canonicalRequestIds(request.resource_ids);
  const expectedDigest = materializedPartsSelectionDigest(request);
  if (
    receipt.selection_digest !== expectedDigest
    || receipt.snapshot_id !== request.snapshot
    || receipt.parts_path !== `build/materials/selections/${expectedDigest}/parts.json`
    || receipt.part_count !== expectedIds.length
  ) {
    throw new Error("Materials materialization artifact received an unbound receipt.");
  }
  if (!SHA256.test(artifact.sha256) || sha256(artifact.content) !== artifact.sha256) {
    throw new Error("Materials materialization artifact failed its file hash binding.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.content);
  } catch {
    throw new Error("Materials materialization artifact is not valid JSON.");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, LIBRARY_KEYS)) {
    throw new Error("Materials materialization artifact has an invalid parts-library schema.");
  }
  // Python emits sorted-key, compact UTF-8 JSON plus one trailing newline. This
  // also rejects duplicate JSON keys and any ambiguous alternative encoding.
  if (artifact.content !== `${pythonCanonicalJson(parsed)}\n`) {
    throw new Error("Materials materialization artifact is not canonical JSON.");
  }
  if (
    parsed.schema_version !== PARTS_SCHEMA_VERSION
    || parsed.library_id !== `selection:${expectedDigest}`
    || parsed.version !== request.snapshot
    || parsed.chassis !== request.chassis
    || typeof parsed.notice !== "string"
    || !parsed.notice.includes("Human review required")
    || !Array.isArray(parsed.parts)
    || parsed.parts.length !== expectedIds.length
  ) {
    throw new Error("Materials materialization artifact failed its snapshot, chassis, digest, or count binding.");
  }

  for (let index = 0; index < expectedIds.length; index += 1) {
    validateMaterializedPart(parsed.parts[index], expectedIds[index]);
  }
  return receipt;
}

function validateMaterializedPart(value: unknown, expectedId: string): void {
  if (!isRecord(value) || !hasExactKeys(value, PART_KEYS)) {
    throw new Error(`Materialized part ${expectedId} has an invalid schema.`);
  }
  if (
    value.id !== expectedId
    || value.resource_id !== expectedId
    || typeof value.type !== "string"
    || !SUPPORTED_PART_TYPES.has(value.type)
    || typeof value.name !== "string"
    || !value.name
    || typeof value.description !== "string"
    || typeof value.description_zh !== "string"
    || value.sequence_kind !== "DNA"
    || typeof value.sequence !== "string"
    || !DNA_SEQUENCE.test(value.sequence)
    || typeof value.sequence_sha256 !== "string"
    || !SHA256.test(value.sequence_sha256)
    || sha256(value.sequence) !== value.sequence_sha256
    || value.review_status !== "DESIGN_ELIGIBLE"
    || value.safety_status !== "NO_FLAG"
    || !Array.isArray(value.safety_flags)
    || value.safety_flags.length !== 0
    || value.design_eligibility !== true
    || !Array.isArray(value.evidence_refs)
    || value.evidence_refs.some((reference) => typeof reference !== "string" || !reference)
    || !isRecord(value.source)
    || value.source.sequence_sha256 !== value.sequence_sha256
    || typeof value.source.content_sha256 !== "string"
    || !SHA256.test(value.source.content_sha256)
    || !isRecord(value.license)
    || value.license.redistribution_status !== "REDISTRIBUTABLE"
  ) {
    throw new Error(`Materialized part ${expectedId} failed its identity, eligibility, or sequence hash binding.`);
  }
}

function canonicalRequestIds(resourceIds: string[]): string[] {
  if (resourceIds.length < 1 || resourceIds.length > 50) {
    throw new Error("Materials materialization must contain between 1 and 50 resource IDs.");
  }
  const seen = new Set<string>();
  const ids = resourceIds.map((resourceId) => {
    if (
      !PYTHON_RESOURCE_ID.test(resourceId)
      || !resourceId.includes(":")
      || resourceId.endsWith("/")
      || resourceId.includes("//")
      || resourceId.includes("/.")
      || resourceId.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      || [".", ".."].includes(resourceId.split(":", 1)[0])
    ) {
      throw new Error("Materials materialization contains a resource ID rejected by the Python catalogue boundary.");
    }
    const folded = resourceId.toLowerCase();
    if (seen.has(folded)) {
      throw new Error("Materials materialization contains a duplicate resource ID.");
    }
    seen.add(folded);
    return resourceId;
  });
  return ids.sort((left, right) => {
    const foldedLeft = left.toLowerCase();
    const foldedRight = right.toLowerCase();
    if (foldedLeft < foldedRight) return -1;
    if (foldedLeft > foldedRight) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function pythonCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Unable to canonicalize materialized parts JSON.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(pythonCanonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${pythonCanonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unable to canonicalize materialized parts JSON.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
