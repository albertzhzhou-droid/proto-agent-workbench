import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  TrustRootLifecycleCatalog,
  TrustRootLifecycleCheck,
  TrustRootLifecycleEntry,
  TrustRootLifecycleImportReceipt,
} from "../../shared/contracts.ts";
import {
  createTrustRootLifecycleChecks,
  loadTufAnchor,
  SIGSTORE_TUF_ANCHOR_SOURCE,
  verifyOfflineTufCandidate,
} from "./tuf-offline.ts";

export const TRUST_ROOT_LIFECYCLE_LIMITS = {
  maxDirectories: 24,
  maxDirectoryEntries: 7,
  maxMetadataBytes: 512 * 1024,
  maxTargetBytes: 512 * 1024,
  maxSourceBytes: 16 * 1024,
  maxChecksumBytes: 4 * 1024,
} as const;

export const TRUST_ROOT_LIFECYCLE_BOUNDARY = "Offline review only. Candidate packs are copied immutably and checked against a pinned TUF root and checkpoint. The catalog cannot download metadata, sign a root, change the installed trust material, activate a candidate, authorize an effect, or suppress rollback, expiry, threshold, length, or hash failures.";

const CANDIDATE_DIRECTORY_PATTERN = /^tr_[a-f0-9]{24}$/;
const CANDIDATE_FILES = ["root.json", "snapshot.json", "SOURCE.json", "targets.json", "timestamp.json", "trusted_root.json"] as const;
const CHECKSUM_FILE = "SHA256SUMS.txt";
const ALL_FILES = [...CANDIDATE_FILES, CHECKSUM_FILE].sort();

interface SourceRecord {
  schema: "proto-workbench.trust-root-candidate-source.v1";
  source: string;
  commit: string;
  retrievedAt: string;
  note?: string;
}

interface CandidateFiles {
  root: Buffer;
  timestamp: Buffer;
  snapshot: Buffer;
  targets: Buffer;
  trustedRoot: Buffer;
  source: Buffer;
  checksums: Buffer;
  modifiedAt: string;
}

interface CandidateInspection {
  candidateId: string;
  files: CandidateFiles;
  fileDigests: Record<string, string>;
  sourceRecord: SourceRecord;
}

export async function importTrustRootCandidate(
  workspaceRoot: string,
  selectedDirectory: string,
  anchorRootPath: string,
  checkpointPath: string,
  installedTrustedRootPath: string,
  importedAt = new Date().toISOString(),
  expectedAnchorSha256?: string,
): Promise<TrustRootLifecycleImportReceipt> {
  if (!validTimestamp(importedAt)) throw new Error("Trust-root candidate import timestamp is invalid.");
  const sourceRoot = await canonicalDirectory(selectedDirectory, "Selected trust-root candidate directory");
  const inspection = await inspectCandidateDirectory(sourceRoot);
  const workspace = await canonicalDirectory(workspaceRoot, "Workspace");
  const build = await ensureDirectory(workspace, "build", workspace);
  const candidateRoot = await ensureDirectory(build, "trust-root-candidates", workspace);
  const targetDirectory = join(candidateRoot, inspection.candidateId);
  let reused = false;
  try { await mkdir(targetDirectory, { recursive: false }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; reused = true; }
  await assertCanonicalDirectory(targetDirectory, workspace);

  const content = contentByName(inspection.files);
  let createdAny = false;
  for (const name of ALL_FILES) createdAny = await writeOrVerifyImmutable(join(targetDirectory, name), content[name]!, limitFor(name)) || createdAny;
  if (!sameEntries((await readdir(targetDirectory)).sort(), ALL_FILES)) throw new Error("Imported trust-root candidate contains unexpected entries.");

  const [anchor, installed] = await Promise.all([
    loadTufAnchor(anchorRootPath, checkpointPath, expectedAnchorSha256),
    readSafeFile(installedTrustedRootPath, TRUST_ROOT_LIFECYCLE_LIMITS.maxTargetBytes),
  ]);
  await verifyOfflineTufCandidate(anchor, {
    root: inspection.files.root,
    timestamp: inspection.files.timestamp,
    snapshot: inspection.files.snapshot,
    targets: inspection.files.targets,
    trustedRoot: inspection.files.trustedRoot,
    installedTrustedRoot: installed.bytes,
  }, new Date(importedAt));

  return {
    schema: "proto-workbench.trust-root-lifecycle-import.v1",
    candidateId: inspection.candidateId,
    relativePath: relative(workspace, targetDirectory).replaceAll("\\", "/"),
    importedAt,
    reused: reused && !createdAny,
    files: ALL_FILES,
  };
}

export async function scanTrustRootCandidates(
  workspaceRoot: string,
  anchorRootPath: string,
  checkpointPath: string,
  installedTrustedRootPath: string,
  issuedAt = new Date().toISOString(),
  expectedAnchorSha256?: string,
): Promise<TrustRootLifecycleCatalog> {
  if (!validTimestamp(issuedAt)) throw new Error("Trust-root lifecycle catalog timestamp is invalid.");
  const workspace = await canonicalDirectory(workspaceRoot, "Workspace");
  const [anchor, installed] = await Promise.all([
    loadTufAnchor(anchorRootPath, checkpointPath, expectedAnchorSha256),
    readSafeFile(installedTrustedRootPath, TRUST_ROOT_LIFECYCLE_LIMITS.maxTargetBytes),
  ]);
  const build = await optionalDirectory(workspace, "build", workspace);
  const candidatesRoot = build ? await optionalDirectory(build, "trust-root-candidates", workspace) : undefined;
  if (!candidatesRoot) return catalog([], 0, false, issuedAt, anchor.checkpoint);

  const discovered = await discoverDirectories(candidatesRoot, workspace);
  const entries: TrustRootLifecycleEntry[] = [];
  for (const directoryName of discovered.names) {
    const directory = join(candidatesRoot, directoryName);
    if (!CANDIDATE_DIRECTORY_PATTERN.test(directoryName)) {
      entries.push(invalidEntry(directoryName, "Candidate directories must use the content-addressed tr_<24 lowercase hex> format."));
      continue;
    }
    try {
      const inspection = await inspectCandidateDirectory(directory);
      if (inspection.candidateId !== directoryName) {
        entries.push(invalidEntry(directoryName, `Current bytes resolve to ${inspection.candidateId}.`));
        continue;
      }
      const verification = await verifyOfflineTufCandidate(anchor, {
        root: inspection.files.root,
        timestamp: inspection.files.timestamp,
        snapshot: inspection.files.snapshot,
        targets: inspection.files.targets,
        trustedRoot: inspection.files.trustedRoot,
        installedTrustedRoot: installed.bytes,
      }, new Date(issuedAt));
      markPackChecks(verification.checks, inspection);
      entries.push({
        directoryName,
        candidateId: directoryName,
        relativePath: relative(workspace, directory).replaceAll("\\", "/"),
        source: inspection.sourceRecord.source,
        sourceCommit: inspection.sourceRecord.commit,
        importedAt: inspection.sourceRecord.retrievedAt,
        observedModifiedAt: inspection.files.modifiedAt,
        ...verification,
      });
    } catch (error) {
      entries.push(invalidEntry(directoryName, safeMessage(error)));
    }
  }
  entries.sort((left, right) => (right.observedModifiedAt ?? "").localeCompare(left.observedModifiedAt ?? "") || left.directoryName.localeCompare(right.directoryName));
  return catalog(entries, discovered.scanned, discovered.truncated, issuedAt, anchor.checkpoint);
}

async function inspectCandidateDirectory(directory: string): Promise<CandidateInspection> {
  await assertCanonicalDirectory(directory, directory);
  const names = (await readdir(directory)).sort();
  if (!sameEntries(names, ALL_FILES)) throw new Error("Trust-root candidate directory must contain the exact seven-file offline pack.");
  const [root, timestamp, snapshot, targets, trustedRoot, source, checksums] = await Promise.all([
    readSafeFile(join(directory, "root.json"), TRUST_ROOT_LIFECYCLE_LIMITS.maxMetadataBytes),
    readSafeFile(join(directory, "timestamp.json"), TRUST_ROOT_LIFECYCLE_LIMITS.maxMetadataBytes),
    readSafeFile(join(directory, "snapshot.json"), TRUST_ROOT_LIFECYCLE_LIMITS.maxMetadataBytes),
    readSafeFile(join(directory, "targets.json"), TRUST_ROOT_LIFECYCLE_LIMITS.maxMetadataBytes),
    readSafeFile(join(directory, "trusted_root.json"), TRUST_ROOT_LIFECYCLE_LIMITS.maxTargetBytes),
    readSafeFile(join(directory, "SOURCE.json"), TRUST_ROOT_LIFECYCLE_LIMITS.maxSourceBytes),
    readSafeFile(join(directory, CHECKSUM_FILE), TRUST_ROOT_LIFECYCLE_LIMITS.maxChecksumBytes),
  ]);
  const files: CandidateFiles = {
    root: root.bytes, timestamp: timestamp.bytes, snapshot: snapshot.bytes, targets: targets.bytes,
    trustedRoot: trustedRoot.bytes, source: source.bytes, checksums: checksums.bytes,
    modifiedAt: latestTimestamp(root.modifiedAt, timestamp.modifiedAt, snapshot.modifiedAt, targets.modifiedAt, trustedRoot.modifiedAt, source.modifiedAt, checksums.modifiedAt),
  };
  const sourceRecord = parseSource(source.bytes);
  const content = contentByName(files);
  const fileDigests = Object.fromEntries(CANDIDATE_FILES.map((name) => [name, digest(content[name]!) ]));
  if (checksums.bytes.toString("utf8") !== checksumManifest(fileDigests)) throw new Error("Candidate checksum manifest is non-canonical or does not match current files.");
  const candidateDigest = digest(Buffer.from(stableJson(fileDigests), "utf8"));
  return { candidateId: `tr_${candidateDigest.slice(0, 24)}`, files, fileDigests, sourceRecord };
}

function parseSource(bytes: Buffer): SourceRecord {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("SOURCE.json is not valid JSON."); }
  const record = value as Partial<SourceRecord>;
  if (
    !record || typeof record !== "object" || Array.isArray(record)
    || record.schema !== "proto-workbench.trust-root-candidate-source.v1"
    || typeof record.source !== "string" || record.source.length > 1000
    || !/^https:\/\//.test(record.source)
    || typeof record.commit !== "string" || !/^[a-f0-9]{40}$/.test(record.commit)
    || typeof record.retrievedAt !== "string" || !validTimestamp(record.retrievedAt)
    || (record.note !== undefined && (typeof record.note !== "string" || record.note.length > 500))
  ) throw new Error("SOURCE.json is malformed or exceeds its review-only bounds.");
  return record as SourceRecord;
}

function markPackChecks(checks: TrustRootLifecycleCheck[], inspection: CandidateInspection): void {
  set(checks, "directory", "passed", `Content-addressed candidate ID ${inspection.candidateId}.`);
  set(checks, "entries", "passed", "Exact seven-file pack; linked and unexpected entries were rejected.");
  set(checks, "checksums", "passed", "Every candidate byte matches the canonical SHA-256 manifest.");
  set(checks, "source-record", "passed", `Review-only provenance record ${inspection.sourceRecord.commit.slice(0, 12)} is structurally valid.`);
}

function catalog(entries: TrustRootLifecycleEntry[], scannedDirectoryCount: number, truncated: boolean, issuedAt: string, checkpoint: Awaited<ReturnType<typeof loadTufAnchor>>["checkpoint"]): TrustRootLifecycleCatalog {
  const summary = {
    reviewable: entries.filter((entry) => entry.state === "reviewable").length,
    current: entries.filter((entry) => entry.state === "current").length,
    rejected: entries.filter((entry) => entry.state === "rejected").length,
    invalid: entries.filter((entry) => entry.state === "invalid").length,
  };
  const body = {
    schema: "proto-workbench.trust-root-lifecycle-catalog.v1" as const,
    scannedDirectoryCount,
    returnedCount: entries.length,
    truncated,
    summary,
    anchor: {
      name: "sigstore-public-good" as const,
      rootVersion: checkpoint.root.version,
      rootSha256: checkpoint.root.sha256,
      rootExpires: checkpoint.root.expires,
      rootThreshold: checkpoint.root.threshold,
      timestampVersion: checkpoint.timestampVersion,
      snapshotVersion: checkpoint.snapshotVersion,
      targetsVersion: checkpoint.targetsVersion,
      trustedRootSha256: checkpoint.trustedRootPinnedSha256,
      source: checkpoint.source || SIGSTORE_TUF_ANCHOR_SOURCE,
      updatePolicy: "offline-review-only" as const,
    },
    entries,
    limits: {
      maxDirectories: TRUST_ROOT_LIFECYCLE_LIMITS.maxDirectories,
      maxDirectoryEntries: TRUST_ROOT_LIFECYCLE_LIMITS.maxDirectoryEntries,
      maxMetadataBytes: TRUST_ROOT_LIFECYCLE_LIMITS.maxMetadataBytes,
      maxTargetBytes: TRUST_ROOT_LIFECYCLE_LIMITS.maxTargetBytes,
    },
    boundary: TRUST_ROOT_LIFECYCLE_BOUNDARY,
  };
  return { ...body, digest: digest(Buffer.from(stableJson(body), "utf8")), issuedAt };
}

function invalidEntry(directoryName: string, detail: string): TrustRootLifecycleEntry {
  const checks = createTrustRootLifecycleChecks();
  set(checks, "directory", "failed", detail);
  return { directoryName, state: "invalid", checks, diagnostics: [detail] };
}

async function discoverDirectories(root: string, workspace: string): Promise<{ names: string[]; scanned: number; truncated: boolean }> {
  await assertCanonicalDirectory(root, workspace);
  const directory = await opendir(root);
  const names: string[] = [];
  let scanned = 0;
  let truncated = false;
  try {
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > TRUST_ROOT_LIFECYCLE_LIMITS.maxDirectories) { truncated = true; break; }
      names.push(entry.name);
    }
  } finally { await directory.close().catch(() => undefined); }
  return { names: names.sort(), scanned: Math.min(scanned, TRUST_ROOT_LIFECYCLE_LIMITS.maxDirectories), truncated };
}

async function readSafeFile(path: string, maximum: number): Promise<{ bytes: Buffer; modifiedAt: string }> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maximum) throw new Error("Candidate file is not a bounded single-link regular file.");
  const canonical = await realpath(path);
  if (!samePath(path, canonical)) throw new Error("Candidate file cannot traverse a link or junction.");
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error("Candidate file changed during verification.");
    return { bytes: await readFile(handle), modifiedAt: opened.mtime.toISOString() };
  } finally { await handle.close(); }
}

async function writeOrVerifyImmutable(path: string, content: Buffer, maximum: number): Promise<boolean> {
  if (content.length < 1 || content.length > maximum) throw new Error("Candidate file is outside its immutable write limit.");
  let handle;
  try { handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readSafeFile(path, maximum);
    if (!existing.bytes.equals(content)) throw new Error("Existing candidate bytes do not match the selected import.");
    return false;
  }
  try {
    await handle.writeFile(content); await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== content.length) throw new Error("Imported candidate did not remain a single-link regular file.");
  } finally { await handle.close(); }
  return true;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const requested = resolve(path);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a canonical directory.`);
  const canonical = await realpath(requested);
  if (!samePath(requested, canonical)) throw new Error(`${label} cannot traverse a link or junction.`);
  return canonical;
}

async function ensureDirectory(parent: string, name: string, workspace: string): Promise<string> {
  const target = join(parent, name);
  try { await mkdir(target, { recursive: false }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await assertCanonicalDirectory(target, workspace); return target;
}

async function optionalDirectory(parent: string, name: string, workspace: string): Promise<string | undefined> {
  const target = join(parent, name);
  try { await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  await assertCanonicalDirectory(target, workspace); return target;
}

async function assertCanonicalDirectory(path: string, containmentRoot: string): Promise<void> {
  assertContained(containmentRoot, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Trust-root candidate path is not a canonical directory.");
  const canonical = await realpath(path);
  assertContained(containmentRoot, canonical);
  if (!samePath(path, canonical)) throw new Error("Trust-root candidate path cannot traverse links or junctions.");
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))) return;
  throw new Error("Trust-root candidate path is outside the allowed root.");
}

function contentByName(files: CandidateFiles): Record<string, Buffer | undefined> {
  return { "root.json": files.root, "timestamp.json": files.timestamp, "snapshot.json": files.snapshot, "targets.json": files.targets, "trusted_root.json": files.trustedRoot, "SOURCE.json": files.source, [CHECKSUM_FILE]: files.checksums };
}
function checksumManifest(digests: Record<string, string>): string { return `${Object.keys(digests).sort().map((name) => `${digests[name]}  ${name}`).join("\n")}\n`; }
function limitFor(name: string): number { return name === "trusted_root.json" ? TRUST_ROOT_LIFECYCLE_LIMITS.maxTargetBytes : name === "SOURCE.json" ? TRUST_ROOT_LIFECYCLE_LIMITS.maxSourceBytes : name === CHECKSUM_FILE ? TRUST_ROOT_LIFECYCLE_LIMITS.maxChecksumBytes : TRUST_ROOT_LIFECYCLE_LIMITS.maxMetadataBytes; }
function set(checks: TrustRootLifecycleCheck[], id: TrustRootLifecycleCheck["id"], state: TrustRootLifecycleCheck["state"], detail: string): void { const check = checks.find((item) => item.id === id); if (check) Object.assign(check, { state, detail }); }
function sameEntries(actual: string[], expected: string[]): boolean { return actual.length === expected.length && actual.every((value, index) => value === expected[index]); }
function latestTimestamp(...timestamps: string[]): string { return [...timestamps].sort().at(-1) ?? new Date(0).toISOString(); }
function validTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function safeMessage(error: unknown): string { const value = error instanceof Error ? error.message : String(error); return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) || "Candidate verification failed closed."; }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`; }
  return JSON.stringify(value) ?? "null";
}
