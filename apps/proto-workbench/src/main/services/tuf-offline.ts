import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalize } from "@tufjs/canonical-json";
import { Metadata, MetadataKind, type Root, type Snapshot, type Targets, type Timestamp } from "@tufjs/models";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import type {
  TrustRootLifecycleCheck,
  TrustRootLifecycleCheckId,
  TrustRootLifecycleEntry,
  TrustRootLifecycleMode,
} from "../../shared/contracts.ts";

export const SIGSTORE_TUF_ANCHOR_SHA256 = "bc232178369634dc10c4d34df3ef64fa2ae642d5dc2c019335a1c22ba700319b";
export const SIGSTORE_TUF_ANCHOR_SOURCE = "https://github.com/sigstore/root-signing/tree/e3399e7e6f2c3f4039aa2464f95f7d8fcf57910c";

const MAX_ANCHOR_BYTES = 128 * 1024;
const MAX_CHECKPOINT_BYTES = 32 * 1024;

export interface TufCheckpoint {
  schema: "proto-workbench.sigstore-tuf-checkpoint.v1";
  source: string;
  upstreamCommit: string;
  reviewedAt: string;
  root: {
    version: number;
    sha256: string;
    upstreamSha256?: string;
    threshold: number;
    expires: string;
  };
  timestampVersion: number;
  snapshotVersion: number;
  targetsVersion: number;
  trustedRootUpstreamSha256: string;
  trustedRootPinnedSha256: string;
  updatePolicy: "offline-review-only";
}

export interface TufAnchor {
  root: Metadata<Root>;
  rootBytes: Buffer;
  checkpoint: TufCheckpoint;
}

export interface TufCandidateBytes {
  root: Buffer;
  timestamp: Buffer;
  snapshot: Buffer;
  targets: Buffer;
  trustedRoot: Buffer;
  installedTrustedRoot: Buffer;
}

export interface TufCandidateVerification {
  state: "reviewable" | "current" | "rejected";
  mode?: TrustRootLifecycleMode;
  root?: TrustRootLifecycleEntry["root"];
  timestamp?: TrustRootLifecycleEntry["timestamp"];
  snapshot?: TrustRootLifecycleEntry["snapshot"];
  targets?: TrustRootLifecycleEntry["targets"];
  trustedRoot?: TrustRootLifecycleEntry["trustedRoot"];
  checks: TrustRootLifecycleCheck[];
  diagnostics: string[];
}

export async function loadTufAnchor(rootPath: string, checkpointPath: string, expectedSha256 = SIGSTORE_TUF_ANCHOR_SHA256): Promise<TufAnchor> {
  const rootBytes = await readPinnedFile(rootPath, MAX_ANCHOR_BYTES, "TUF root anchor");
  const rootSha256 = sha256(rootBytes);
  if (rootSha256 !== expectedSha256) {
    throw new Error(`The pinned TUF root anchor digest is ${rootSha256}; expected ${expectedSha256}.`);
  }
  const root = parseMetadata<Root>(MetadataKind.Root, rootBytes, "TUF root anchor");
  root.verifyDelegate(MetadataKind.Root, root);

  const checkpointBytes = await readPinnedFile(checkpointPath, MAX_CHECKPOINT_BYTES, "TUF checkpoint");
  const checkpoint = parseCheckpoint(checkpointBytes);
  const rootRole = root.signed.roles.root;
  if (
    checkpoint.root.sha256 !== rootSha256
    || checkpoint.root.version !== root.signed.version
    || checkpoint.root.threshold !== rootRole.threshold
    || checkpoint.root.expires !== root.signed.expires
  ) {
    throw new Error("The TUF checkpoint does not bind the pinned root anchor exactly.");
  }
  return { root, rootBytes, checkpoint };
}

export async function verifyOfflineTufCandidate(
  anchor: TufAnchor,
  bytes: TufCandidateBytes,
  referenceTime = new Date(),
): Promise<TufCandidateVerification> {
  const checks = createTrustRootLifecycleChecks();
  const diagnostics: string[] = [];
  pass(checks, "anchor-root", `Pinned root v${anchor.root.signed.version} is self-signed at threshold ${anchor.root.signed.roles.root.threshold}.`);

  let candidateRoot: Metadata<Root>;
  let timestamp: Metadata<Timestamp>;
  let snapshot: Metadata<Snapshot>;
  let targets: Metadata<Targets>;
  try {
    candidateRoot = parseMetadata(MetadataKind.Root, bytes.root, "candidate root.json");
    timestamp = parseMetadata(MetadataKind.Timestamp, bytes.timestamp, "timestamp.json");
    snapshot = parseMetadata(MetadataKind.Snapshot, bytes.snapshot, "snapshot.json");
    targets = parseMetadata(MetadataKind.Targets, bytes.targets, "targets.json");
  } catch (error) {
    fail(checks, "root-version", safeMessage(error));
    diagnostics.push(safeMessage(error));
    return { state: "rejected", checks, diagnostics };
  }

  const anchorCanonical = canonicalSha256(anchor.root.toJSON());
  const candidateCanonical = canonicalSha256(candidateRoot.toJSON());
  const sameRoot = candidateRoot.signed.version === anchor.root.signed.version && candidateCanonical === anchorCanonical;
  const sequentialRotation = candidateRoot.signed.version === anchor.root.signed.version + 1;
  const mode: TrustRootLifecycleMode | undefined = sameRoot ? "metadata-refresh" : sequentialRotation ? "root-rotation" : undefined;

  if (mode) {
    pass(checks, "root-version", mode === "root-rotation"
      ? `Candidate root advances exactly from v${anchor.root.signed.version} to v${candidateRoot.signed.version}.`
      : `Candidate root is byte-independent but canonically identical to pinned v${anchor.root.signed.version}.`);
  } else {
    fail(checks, "root-version", `Candidate root v${candidateRoot.signed.version} is neither the exact current root nor v${anchor.root.signed.version + 1}.`);
  }

  verifyThreshold(checks, "old-root-threshold", () => anchor.root.verifyDelegate(MetadataKind.Root, candidateRoot), `Old root threshold ${anchor.root.signed.roles.root.threshold} authorizes the candidate.`);
  verifyThreshold(checks, "new-root-threshold", () => candidateRoot.verifyDelegate(MetadataKind.Root, candidateRoot), `Candidate root self-threshold ${candidateRoot.signed.roles.root.threshold} is satisfied.`);
  if (candidateRoot.signed.isExpired(referenceTime)) {
    fail(checks, "root-expiry", `Candidate root expired at ${candidateRoot.signed.expires}.`);
  } else {
    pass(checks, "root-expiry", `Candidate root remains valid through ${candidateRoot.signed.expires}.`);
  }

  verifyThreshold(checks, "timestamp-signature", () => candidateRoot.verifyDelegate(MetadataKind.Timestamp, timestamp), `timestamp.json v${timestamp.signed.version} satisfies the candidate root role.`);
  checkExpiry(checks, "timestamp-freshness", timestamp.signed.expires, referenceTime, "timestamp.json");
  verifyMetaBinding(checks, "snapshot-binding", timestamp.signed.snapshotMeta, bytes.snapshot, snapshot.signed.version, "snapshot.json");
  verifyThreshold(checks, "snapshot-signature", () => candidateRoot.verifyDelegate(MetadataKind.Snapshot, snapshot), `snapshot.json v${snapshot.signed.version} satisfies the candidate root role.`);
  checkExpiry(checks, "snapshot-freshness", snapshot.signed.expires, referenceTime, "snapshot.json");

  const targetsMeta = snapshot.signed.meta["targets.json"];
  if (!targetsMeta) {
    fail(checks, "targets-binding", "snapshot.json does not bind targets.json.");
  } else {
    verifyMetaBinding(checks, "targets-binding", targetsMeta, bytes.targets, targets.signed.version, "targets.json");
  }
  verifyThreshold(checks, "targets-signature", () => candidateRoot.verifyDelegate(MetadataKind.Targets, targets), `targets.json v${targets.signed.version} satisfies the candidate root role.`);
  checkExpiry(checks, "targets-freshness", targets.signed.expires, referenceTime, "targets.json");

  const target = targets.signed.targets["trusted_root.json"];
  if (!target) {
    fail(checks, "trusted-root-binding", "targets.json does not bind trusted_root.json.");
  } else {
    verifyTargetBinding(checks, target.length, target.hashes, bytes.trustedRoot);
  }

  let trustedRootSummary: TrustRootLifecycleEntry["trustedRoot"] | undefined;
  try {
    const parsed = parseObject(bytes.trustedRoot, "trusted_root.json");
    const decoded = TrustedRoot.fromJSON(parsed);
    if (!decoded.mediaType || decoded.tlogs.length === 0 || decoded.certificateAuthorities.length === 0) {
      throw new Error("trusted_root.json is missing required Sigstore trust material.");
    }
    const installed = parseObject(bytes.installedTrustedRoot, "installed trusted_root.json");
    const semanticSha256 = canonicalSha256(parsed);
    const installedSemanticSha256 = canonicalSha256(installed);
    trustedRootSummary = {
      sha256: sha256(bytes.trustedRoot),
      semanticSha256,
      installedSemanticSha256,
      changed: semanticSha256 !== installedSemanticSha256,
      tlogCount: decoded.tlogs.length,
      ctlogCount: decoded.ctlogs.length,
      certificateAuthorityCount: decoded.certificateAuthorities.length,
      timestampAuthorityCount: decoded.timestampAuthorities.length,
    };
    pass(checks, "trusted-root-structure", `${decoded.tlogs.length} transparency logs, ${decoded.certificateAuthorities.length} certificate authorities, and ${decoded.timestampAuthorities.length} timestamp authorities parsed.`);
  } catch (error) {
    fail(checks, "trusted-root-structure", safeMessage(error));
    diagnostics.push(safeMessage(error));
  }

  const rollback = timestamp.signed.version >= anchor.checkpoint.timestampVersion
    && snapshot.signed.version >= anchor.checkpoint.snapshotVersion
    && targets.signed.version >= anchor.checkpoint.targetsVersion;
  if (rollback) {
    pass(checks, "rollback-protection", `Role versions do not roll back checkpoint ${anchor.checkpoint.timestampVersion}/${anchor.checkpoint.snapshotVersion}/${anchor.checkpoint.targetsVersion}.`);
  } else {
    fail(checks, "rollback-protection", `Candidate role versions ${timestamp.signed.version}/${snapshot.signed.version}/${targets.signed.version} roll back the pinned checkpoint.`);
  }

  const hasNewMetadata = timestamp.signed.version > anchor.checkpoint.timestampVersion
    || snapshot.signed.version > anchor.checkpoint.snapshotVersion
    || targets.signed.version > anchor.checkpoint.targetsVersion;
  const hasChange = mode === "root-rotation" || hasNewMetadata || Boolean(trustedRootSummary?.changed);
  if (hasChange) {
    pass(checks, "change-classification", "The candidate contains a signed root, metadata, or trust-material change for human review.");
  } else {
    pass(checks, "change-classification", "The candidate is cryptographically current with the pinned checkpoint; no activation is needed.");
  }

  const failed = checks.some((check) => check.state === "failed");
  if (failed) diagnostics.push(...checks.filter((check) => check.state === "failed").map((check) => check.detail));
  return {
    state: failed ? "rejected" : hasChange ? "reviewable" : "current",
    mode,
    root: {
      currentVersion: anchor.root.signed.version,
      candidateVersion: candidateRoot.signed.version,
      currentThreshold: anchor.root.signed.roles.root.threshold,
      candidateThreshold: candidateRoot.signed.roles.root.threshold,
      sha256: sha256(bytes.root),
      expires: candidateRoot.signed.expires,
    },
    timestamp: roleSnapshot(timestamp, bytes.timestamp),
    snapshot: roleSnapshot(snapshot, bytes.snapshot),
    targets: roleSnapshot(targets, bytes.targets),
    trustedRoot: trustedRootSummary,
    checks,
    diagnostics: unique(diagnostics),
  };
}

function parseMetadata<T extends Root | Timestamp | Snapshot | Targets>(kind: MetadataKind, bytes: Buffer, label: string): Metadata<T> {
  const parsed = parseObject(bytes, label);
  return Metadata.fromJSON(kind as never, parsed as never) as Metadata<T>;
}

function parseObject(bytes: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

function parseCheckpoint(bytes: Buffer): TufCheckpoint {
  const value = parseObject(bytes, "TUF checkpoint") as unknown as TufCheckpoint;
  if (
    value.schema !== "proto-workbench.sigstore-tuf-checkpoint.v1"
    || value.updatePolicy !== "offline-review-only"
    || !value.root || !positive(value.root.version) || !positive(value.root.threshold)
    || !sha(value.root.sha256) || !sha(value.trustedRootPinnedSha256)
    || !positive(value.timestampVersion) || !positive(value.snapshotVersion) || !positive(value.targetsVersion)
  ) throw new Error("The pinned TUF checkpoint is malformed.");
  return value;
}

async function readPinnedFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const requested = resolve(path);
  const [stat, canonical] = await Promise.all([lstat(requested), realpath(requested)]);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maxBytes || !samePath(requested, canonical)) {
    throw new Error(`${label} is not a bounded single-link regular file.`);
  }
  const handle = await open(requested, "r");
  try {
    const before = await handle.stat();
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`${label} changed while it was being read.`);
    return bytes;
  } finally { await handle.close(); }
}

function verifyThreshold(checks: TrustRootLifecycleCheck[], id: TrustRootLifecycleCheckId, fn: () => void, success: string): void {
  try { fn(); pass(checks, id, success); } catch (error) { fail(checks, id, safeMessage(error)); }
}

function checkExpiry(checks: TrustRootLifecycleCheck[], id: TrustRootLifecycleCheckId, expires: string, referenceTime: Date, label: string): void {
  const time = new Date(expires);
  if (!Number.isFinite(time.getTime()) || referenceTime >= time) fail(checks, id, `${label} expired at ${expires}.`);
  else pass(checks, id, `${label} remains valid through ${expires}.`);
}

function verifyMetaBinding(checks: TrustRootLifecycleCheck[], id: TrustRootLifecycleCheckId, meta: { version: number; verify(data: Buffer): void }, bytes: Buffer, version: number, label: string): void {
  try {
    if (version !== meta.version) throw new Error(`${label} version ${version} does not match bound version ${meta.version}.`);
    meta.verify(bytes);
    pass(checks, id, `${label} exact bytes match the signed version, length, and hashes.`);
  } catch (error) { fail(checks, id, safeMessage(error)); }
}

function verifyTargetBinding(checks: TrustRootLifecycleCheck[], length: number, hashes: Record<string, string>, bytes: Buffer): void {
  try {
    if (bytes.length !== length) throw new Error(`trusted_root.json length ${bytes.length} does not match ${length}.`);
    for (const [algorithm, expected] of Object.entries(hashes)) {
      const observed = createHash(algorithm).update(bytes).digest("hex");
      if (observed !== expected) throw new Error(`trusted_root.json ${algorithm} digest does not match targets.json.`);
    }
    pass(checks, "trusted-root-binding", "trusted_root.json exact bytes match targets.json length and hashes.");
  } catch (error) { fail(checks, "trusted-root-binding", safeMessage(error)); }
}

function roleSnapshot(metadata: Metadata<Root | Timestamp | Snapshot | Targets>, bytes: Buffer) {
  return { version: metadata.signed.version, expires: metadata.signed.expires, sha256: sha256(bytes) };
}

export function createTrustRootLifecycleChecks(): TrustRootLifecycleCheck[] {
  const definitions: Array<[TrustRootLifecycleCheckId, string]> = [
    ["directory", "Candidate directory"], ["entries", "Exact entries"], ["checksums", "Pack checksums"], ["source-record", "Source record"],
    ["anchor-root", "Pinned anchor"], ["root-version", "Sequential root"], ["old-root-threshold", "Old-root threshold"], ["new-root-threshold", "New-root threshold"], ["root-expiry", "Root expiry"],
    ["timestamp-signature", "Timestamp signature"], ["timestamp-freshness", "Timestamp freshness"], ["snapshot-binding", "Snapshot binding"], ["snapshot-signature", "Snapshot signature"], ["snapshot-freshness", "Snapshot freshness"],
    ["targets-binding", "Targets binding"], ["targets-signature", "Targets signature"], ["targets-freshness", "Targets freshness"], ["trusted-root-binding", "Trust material binding"], ["trusted-root-structure", "Trust material structure"],
    ["rollback-protection", "Rollback protection"], ["change-classification", "Change classification"],
  ];
  return definitions.map(([id, label]) => ({ id, label, state: "not-checked", detail: "Not checked." }));
}

function set(checks: TrustRootLifecycleCheck[], id: TrustRootLifecycleCheckId, state: TrustRootLifecycleCheck["state"], detail: string): void {
  const check = checks.find((item) => item.id === id); if (check) { check.state = state; check.detail = detail; }
}
function pass(checks: TrustRootLifecycleCheck[], id: TrustRootLifecycleCheckId, detail: string): void { set(checks, id, "passed", detail); }
function fail(checks: TrustRootLifecycleCheck[], id: TrustRootLifecycleCheckId, detail: string): void { set(checks, id, "failed", detail); }
function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalSha256(value: unknown): string { return sha256(canonicalize(value)); }
function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function samePath(left: string, right: string): boolean { return resolve(left).toLowerCase() === resolve(right).toLowerCase(); }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 500) : "Verification failed."; }
function unique(values: string[]): string[] { return [...new Set(values)].slice(0, 24); }
