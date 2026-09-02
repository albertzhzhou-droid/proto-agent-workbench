import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DecisionBundlePreview,
  DecisionBundleVerificationCatalog,
  DecisionBundleVerificationCheck,
  DecisionBundleVerificationCheckId,
  DecisionBundleVerificationDiagnostic,
  DecisionBundleVerificationEntry,
  DecisionBundleVerificationState,
} from "../../shared/contracts.ts";
import { DECISION_BUNDLE_LIMITS, parseDecisionBundle } from "./decision-bundle.ts";

export const DECISION_BUNDLE_VERIFICATION_LIMITS = {
  maxDirectories: 64,
  maxDirectoryEntries: 256,
  maxChecksumBytes: 512,
} as const;

export const DECISION_BUNDLE_VERIFICATION_BOUNDARY = "Read-only verification snapshot. It does not execute a bundle, establish publisher identity, authorize an effect, or guarantee that bytes remain unchanged after this scan.";

const DIRECTORY_PATTERN = /^db_[a-f0-9]{24}$/;
const EXPECTED_ENTRIES = ["SHA256SUMS.txt", "decision-bundle.json"] as const;
const CHECK_DEFINITIONS: Array<{ id: DecisionBundleVerificationCheckId; label: string }> = [
  { id: "directory", label: "Canonical directory" },
  { id: "entries", label: "Exact artifact set" },
  { id: "bundle-file", label: "Bounded bundle file" },
  { id: "checksum-file", label: "Bounded checksum file" },
  { id: "checksum-match", label: "Checksum match" },
  { id: "schema", label: "Supported canonical schema" },
  { id: "content-digest", label: "Content address" },
  { id: "subject-binding", label: "Simulation subject binding" },
];

interface SafeFile {
  text: string;
  bytes: number;
  modifiedAt: string;
}

export async function scanDecisionBundles(
  workspaceRoot: string,
  issuedAt = new Date().toISOString(),
): Promise<DecisionBundleVerificationCatalog> {
  if (!validTimestamp(issuedAt)) throw new Error("Decision Bundle verification timestamp is invalid.");
  const root = await canonicalRoot(workspaceRoot);
  const buildDirectory = await optionalCanonicalDirectory(root, "build", root);
  const bundleRoot = buildDirectory ? await optionalCanonicalDirectory(buildDirectory, "decision-bundles", root) : undefined;
  if (!bundleRoot) return catalog([], 0, false, issuedAt);

  const discovery = await discoverBundleDirectories(bundleRoot);
  const selected = discovery.directories.slice(0, DECISION_BUNDLE_VERIFICATION_LIMITS.maxDirectories);
  const entries: DecisionBundleVerificationEntry[] = [];
  for (const directoryEntry of selected) {
    entries.push(await inspectBundleDirectory(root, bundleRoot, directoryEntry.name, directoryEntry.directoryHint));
  }
  entries.sort((left, right) => (right.observedModifiedAt ?? "").localeCompare(left.observedModifiedAt ?? "")
    || left.directoryName.localeCompare(right.directoryName));
  return catalog(entries, discovery.matchingDirectoryCount, discovery.truncated, issuedAt);
}

async function discoverBundleDirectories(bundleRoot: string): Promise<{
  directories: Array<{ name: string; directoryHint: boolean }>;
  matchingDirectoryCount: number;
  truncated: boolean;
}> {
  const directories: Array<{ name: string; directoryHint: boolean }> = [];
  let visitedEntryCount = 0;
  let matchingDirectoryCount = 0;
  let truncated = false;
  const directory = await opendir(bundleRoot);
  for await (const entry of directory) {
    visitedEntryCount += 1;
    if (visitedEntryCount > DECISION_BUNDLE_VERIFICATION_LIMITS.maxDirectoryEntries) {
      truncated = true;
      break;
    }
    if (!DIRECTORY_PATTERN.test(entry.name)) continue;
    matchingDirectoryCount += 1;
    directories.push({ name: entry.name, directoryHint: entry.isDirectory() });
    if (matchingDirectoryCount > DECISION_BUNDLE_VERIFICATION_LIMITS.maxDirectories) {
      truncated = true;
      break;
    }
  }
  directories.sort((left, right) => left.name.localeCompare(right.name));
  return { directories, matchingDirectoryCount, truncated };
}

async function inspectBundleDirectory(
  root: string,
  bundleRoot: string,
  directoryName: string,
  directoryHint: boolean,
): Promise<DecisionBundleVerificationEntry> {
  const checks = initialChecks();
  const diagnostics: DecisionBundleVerificationDiagnostic[] = [];
  const targetDirectory = join(bundleRoot, directoryName);
  let structuralFailure = false;
  let tampered = false;
  let bundleFile: SafeFile | undefined;
  let checksumFile: SafeFile | undefined;
  let parsed: DecisionBundlePreview | undefined;

  if (!directoryHint) {
    fail(checks, "directory", "The content-addressed entry is not a directory.");
    diagnostics.push(diagnostic("INVALID_DIRECTORY", "Directory rejected", "The bundle locator is not a canonical directory."));
    structuralFailure = true;
  } else {
    try {
      await assertCanonicalDirectory(targetDirectory, root);
      pass(checks, "directory", "The directory is canonical and remains inside the active workspace.");
    } catch {
      fail(checks, "directory", "The directory is linked, replaced, or outside the active workspace.");
      diagnostics.push(diagnostic("INVALID_DIRECTORY", "Directory rejected", "The bundle directory failed canonical containment checks."));
      structuralFailure = true;
    }
  }

  if (!structuralFailure) {
    let names: string[] = [];
    try {
      names = (await readdir(targetDirectory)).sort();
    } catch {
      diagnostics.push(diagnostic("DIRECTORY_READ_FAILED", "Directory could not be read", "The bundle directory was not readable during this verification snapshot."));
      structuralFailure = true;
    }
    if (!structuralFailure && sameEntries(names, EXPECTED_ENTRIES)) {
      pass(checks, "entries", "The directory contains exactly the bundle and checksum files.");
    } else if (!structuralFailure) {
      fail(checks, "entries", "The directory does not contain the exact two-file artifact set.");
      diagnostics.push(diagnostic("UNEXPECTED_ENTRIES", "Artifact set rejected", "Missing or additional directory entries prevent a trusted verification result."));
      structuralFailure = true;
    }
  }

  if (!structuralFailure) {
    try {
      bundleFile = await readRegularFile(join(targetDirectory, "decision-bundle.json"), DECISION_BUNDLE_LIMITS.maxBytes);
      pass(checks, "bundle-file", `${formatBytes(bundleFile.bytes)} single-link regular file.`);
    } catch {
      fail(checks, "bundle-file", "The bundle is missing, linked, oversized, or changed during the read.");
      diagnostics.push(diagnostic("BUNDLE_FILE_INVALID", "Bundle file rejected", "The JSON artifact did not remain a bounded single-link regular file."));
      structuralFailure = true;
    }
    try {
      checksumFile = await readRegularFile(join(targetDirectory, "SHA256SUMS.txt"), DECISION_BUNDLE_VERIFICATION_LIMITS.maxChecksumBytes);
      pass(checks, "checksum-file", `${formatBytes(checksumFile.bytes)} single-link regular file.`);
    } catch {
      fail(checks, "checksum-file", "The checksum is missing, linked, oversized, or changed during the read.");
      diagnostics.push(diagnostic("CHECKSUM_FILE_INVALID", "Checksum file rejected", "The checksum artifact did not remain a bounded single-link regular file."));
      structuralFailure = true;
    }
  }

  const bundleSha256 = bundleFile ? sha256(bundleFile.text) : undefined;
  const expectedBundleSha256 = checksumFile ? parseChecksum(checksumFile.text) : undefined;
  if (bundleFile && checksumFile) {
    if (!expectedBundleSha256) {
      fail(checks, "checksum-match", "The checksum record is malformed.");
      diagnostics.push(diagnostic("CHECKSUM_MALFORMED", "Checksum record rejected", "SHA256SUMS.txt must contain one lowercase SHA-256 record for decision-bundle.json."));
      structuralFailure = true;
    } else if (bundleSha256 !== expectedBundleSha256) {
      fail(checks, "checksum-match", "The JSON bytes do not match SHA256SUMS.txt.");
      diagnostics.push(diagnostic("CHECKSUM_MISMATCH", "Bundle bytes changed", "The current JSON bytes no longer match the exported checksum record."));
      tampered = true;
    } else {
      pass(checks, "checksum-match", "The JSON bytes match SHA256SUMS.txt.");
    }
  }

  if (bundleFile) {
    try {
      parsed = parseDecisionBundle(bundleFile.text);
      pass(checks, "schema", "The JSON uses the supported canonical Decision Bundle schema.");
      pass(checks, "content-digest", "The payload matches its bundle ID and content digest.");
      pass(checks, "subject-binding", "The in-toto subject digest matches the bound simulation report.");
      if (parsed.bundleId !== directoryName) {
        fail(checks, "content-digest", "The directory name does not match the content-addressed bundle ID.");
        diagnostics.push(diagnostic("DIRECTORY_ID_MISMATCH", "Content address changed", "The parsed bundle ID does not match its enclosing directory."));
        tampered = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Decision Bundle verification failed.";
      const category = verificationFailureCategory(message);
      if (category.schema) fail(checks, "schema", category.detail);
      else pass(checks, "schema", "The supported schema was parsed before a later binding check failed.");
      if (category.content) fail(checks, "content-digest", category.detail);
      if (category.subject) fail(checks, "subject-binding", category.detail);
      diagnostics.push(diagnostic(category.code, category.title, category.detail));
      tampered ||= category.tampered;
      structuralFailure ||= !category.tampered;
    }
  }

  const state: DecisionBundleVerificationState = tampered ? "tampered" : structuralFailure ? "invalid" : "content-verified";
  const relativePath = bundleFile ? relative(root, join(targetDirectory, "decision-bundle.json")).replaceAll("\\", "/") : undefined;
  const checksumRelativePath = checksumFile ? relative(root, join(targetDirectory, "SHA256SUMS.txt")).replaceAll("\\", "/") : undefined;
  return {
    directoryName,
    state,
    signatureStatus: parsed?.authentication.status ?? "unknown",
    identityAssurance: "not-verified",
    bundleId: parsed?.bundleId,
    bundleDigest: parsed?.bundleDigest,
    bundleSha256,
    expectedBundleSha256,
    sourceSimulationSha256: parsed?.attestation.predicate.simulation.digest,
    relativePath,
    checksumRelativePath,
    bytes: bundleFile?.bytes,
    observedModifiedAt: latestTimestamp(bundleFile?.modifiedAt, checksumFile?.modifiedAt),
    redaction: parsed?.redaction.profile,
    goalPreviewIncluded: parsed ? parsed.attestation.predicate.goal.preview !== null : undefined,
    scenarioCount: parsed?.attestation.predicate.simulation.scenarioCount,
    selectedScenario: parsed ? {
      id: parsed.attestation.predicate.selectedScenario.id,
      label: parsed.attestation.predicate.selectedScenario.label,
      state: parsed.attestation.predicate.selectedScenario.state,
      hypothetical: parsed.attestation.predicate.selectedScenario.hypothetical,
    } : undefined,
    producer: parsed?.attestation.predicate.producer,
    checks,
    diagnostics,
  };
}

function catalog(
  entries: DecisionBundleVerificationEntry[],
  scannedDirectoryCount: number,
  truncated: boolean,
  issuedAt: string,
): DecisionBundleVerificationCatalog {
  const summary = {
    contentVerified: entries.filter((entry) => entry.state === "content-verified").length,
    tampered: entries.filter((entry) => entry.state === "tampered").length,
    invalid: entries.filter((entry) => entry.state === "invalid").length,
    unsigned: entries.filter((entry) => entry.signatureStatus === "unsigned").length,
  };
  const body = {
    schema: "proto-workbench.decision-bundle-verification.v1" as const,
    scannedDirectoryCount,
    returnedCount: entries.length,
    truncated,
    summary,
    entries,
    limits: {
      maxDirectories: DECISION_BUNDLE_VERIFICATION_LIMITS.maxDirectories,
      maxDirectoryEntries: DECISION_BUNDLE_VERIFICATION_LIMITS.maxDirectoryEntries,
      maxBundleBytes: DECISION_BUNDLE_LIMITS.maxBytes,
    },
    boundary: DECISION_BUNDLE_VERIFICATION_BOUNDARY,
  };
  return { ...body, digest: sha256(stableJson(body)), issuedAt };
}

function initialChecks(): DecisionBundleVerificationCheck[] {
  return CHECK_DEFINITIONS.map((check) => ({ ...check, state: "not-checked", detail: "Not reached." }));
}

function pass(checks: DecisionBundleVerificationCheck[], id: DecisionBundleVerificationCheckId, detail: string): void {
  const check = checks.find((item) => item.id === id);
  if (check) Object.assign(check, { state: "passed", detail });
}

function fail(checks: DecisionBundleVerificationCheck[], id: DecisionBundleVerificationCheckId, detail: string): void {
  const check = checks.find((item) => item.id === id);
  if (check) Object.assign(check, { state: "failed", detail });
}

function diagnostic(code: string, title: string, detail: string): DecisionBundleVerificationDiagnostic {
  return { code, title, detail };
}

function verificationFailureCategory(message: string) {
  if (/subject digest|scenario matrix/i.test(message)) {
    return { code: "SUBJECT_BINDING_MISMATCH", title: "Simulation binding changed", detail: "The Statement subject no longer matches the bound simulation report.", schema: false, content: false, subject: true, tampered: true };
  }
  if (/content digest|canonical|bundle ID/i.test(message)) {
    return { code: "CONTENT_DIGEST_MISMATCH", title: "Content address changed", detail: "The canonical payload no longer matches its bundle ID or content digest.", schema: false, content: true, subject: false, tampered: true };
  }
  if (/JSON/i.test(message)) {
    return { code: "BUNDLE_JSON_INVALID", title: "JSON could not be parsed", detail: "The artifact is not valid Decision Bundle JSON.", schema: true, content: false, subject: false, tampered: false };
  }
  return { code: "BUNDLE_SCHEMA_INVALID", title: "Bundle schema rejected", detail: "The artifact does not satisfy the supported bounded Decision Bundle schema.", schema: true, content: false, subject: false, tampered: false };
}

async function canonicalRoot(workspaceRoot: string): Promise<string> {
  const requested = resolve(workspaceRoot);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Decision Bundle verification requires a canonical workspace directory.");
  const canonical = await realpath(requested);
  if (!sameCanonicalPath(requested, canonical)) throw new Error("Decision Bundle verification cannot traverse a linked workspace root.");
  return canonical;
}

async function optionalCanonicalDirectory(parent: string, name: string, containmentRoot: string): Promise<string | undefined> {
  const candidate = join(parent, name);
  try {
    await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Decision Bundle verification could not inspect its audit directory.");
  }
  await assertCanonicalDirectory(candidate, containmentRoot);
  return candidate;
}

async function assertCanonicalDirectory(path: string, containmentRoot: string): Promise<void> {
  assertContained(containmentRoot, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Decision Bundle verification path is not a canonical directory.");
  const canonical = await realpath(path);
  assertContained(containmentRoot, canonical);
  if (!sameCanonicalPath(path, canonical)) throw new Error("Decision Bundle verification path cannot traverse links or junctions.");
}

async function readRegularFile(path: string, maximumBytes: number): Promise<SafeFile> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > maximumBytes) {
    throw new Error("Decision Bundle verification file is not a bounded single-link regular file.");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Decision Bundle verification file changed before it could be read.");
    }
    const text = await handle.readFile("utf8");
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("Decision Bundle verification file changed during the read.");
    }
    return { text, bytes: Buffer.byteLength(text, "utf8"), modifiedAt: after.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

function parseChecksum(value: string): string | undefined {
  return /^([a-f0-9]{64})  decision-bundle\.json\n$/.exec(value)?.[1];
}

function sameEntries(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function latestTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

function formatBytes(bytes: number): string {
  return bytes < 1_024 ? `${bytes} B` : `${(bytes / 1_024).toFixed(1)} KiB`;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) return;
  throw new Error("Decision Bundle verification path is outside the active workspace.");
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase()
    : resolve(left) === resolve(right);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
