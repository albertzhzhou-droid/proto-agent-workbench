import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DecisionBundleVerificationDiagnostic,
  TrustPolicyCatalog,
  TrustPolicyCatalogEntry,
  TrustPolicyCatalogState,
  TrustPolicyPreview,
} from "../../shared/contracts.ts";
import { parseTrustPolicy, TRUST_POLICY_LIMITS } from "./trust-policy.ts";

export const TRUST_POLICY_CATALOG_LIMITS = {
  maxDirectories: 32,
  maxDirectoryEntries: 128,
  maxChecksumBytes: 512,
} as const;

export const TRUST_POLICY_CATALOG_BOUNDARY = "Read-only Trust Policy catalog. A valid policy is an exact rule set, not signature evidence, key material, an activated trust decision, or authorization to execute an effect.";

const DIRECTORY_PATTERN = /^tp_[a-f0-9]{24}$/;
const EXPECTED_ENTRIES = ["SHA256SUMS.txt", "trust-policy.json"] as const;

interface SafeFile {
  text: string;
  bytes: number;
  modifiedAt: string;
}

export async function scanTrustPolicies(workspaceRoot: string, issuedAt = new Date().toISOString()): Promise<TrustPolicyCatalog> {
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error("Trust Policy catalog timestamp is invalid.");
  const root = await canonicalRoot(workspaceRoot);
  const buildDirectory = await optionalCanonicalDirectory(root, "build", root);
  const policyRoot = buildDirectory ? await optionalCanonicalDirectory(buildDirectory, "trust-policies", root) : undefined;
  if (!policyRoot) return catalog([], 0, false, issuedAt);

  const discovery = await discoverPolicyDirectories(policyRoot);
  const entries: TrustPolicyCatalogEntry[] = [];
  for (const directory of discovery.directories.slice(0, TRUST_POLICY_CATALOG_LIMITS.maxDirectories)) {
    entries.push(await inspectPolicyDirectory(root, policyRoot, directory.name, directory.directoryHint));
  }
  entries.sort((left, right) => (right.observedModifiedAt ?? "").localeCompare(left.observedModifiedAt ?? "")
    || left.directoryName.localeCompare(right.directoryName));
  return catalog(entries, discovery.matchingDirectoryCount, discovery.truncated, issuedAt);
}

async function discoverPolicyDirectories(policyRoot: string): Promise<{
  directories: Array<{ name: string; directoryHint: boolean }>;
  matchingDirectoryCount: number;
  truncated: boolean;
}> {
  const directories: Array<{ name: string; directoryHint: boolean }> = [];
  let visited = 0;
  let matchingDirectoryCount = 0;
  let truncated = false;
  const directory = await opendir(policyRoot);
  for await (const entry of directory) {
    visited += 1;
    if (visited > TRUST_POLICY_CATALOG_LIMITS.maxDirectoryEntries) {
      truncated = true;
      break;
    }
    if (!DIRECTORY_PATTERN.test(entry.name)) continue;
    matchingDirectoryCount += 1;
    directories.push({ name: entry.name, directoryHint: entry.isDirectory() });
    if (matchingDirectoryCount > TRUST_POLICY_CATALOG_LIMITS.maxDirectories) {
      truncated = true;
      break;
    }
  }
  directories.sort((left, right) => left.name.localeCompare(right.name));
  return { directories, matchingDirectoryCount, truncated };
}

async function inspectPolicyDirectory(root: string, policyRoot: string, directoryName: string, directoryHint: boolean): Promise<TrustPolicyCatalogEntry> {
  const diagnostics: DecisionBundleVerificationDiagnostic[] = [];
  const targetDirectory = join(policyRoot, directoryName);
  let structuralFailure = false;
  let tampered = false;
  let policyFile: SafeFile | undefined;
  let checksumFile: SafeFile | undefined;
  let parsed: TrustPolicyPreview | undefined;

  if (!directoryHint) {
    diagnostics.push(diagnostic("INVALID_DIRECTORY", "Policy directory rejected", "The content-addressed locator is not a canonical directory."));
    structuralFailure = true;
  } else {
    try {
      await assertCanonicalDirectory(targetDirectory, root);
    } catch {
      diagnostics.push(diagnostic("INVALID_DIRECTORY", "Policy directory rejected", "The policy directory is linked, replaced, or outside the active workspace."));
      structuralFailure = true;
    }
  }

  if (!structuralFailure) {
    try {
      const names = (await readdir(targetDirectory)).sort();
      if (!sameEntries(names, EXPECTED_ENTRIES)) {
        diagnostics.push(diagnostic("UNEXPECTED_ENTRIES", "Policy artifact set rejected", "The directory must contain exactly trust-policy.json and SHA256SUMS.txt."));
        structuralFailure = true;
      }
    } catch {
      diagnostics.push(diagnostic("DIRECTORY_READ_FAILED", "Policy directory unavailable", "The directory could not be read during this snapshot."));
      structuralFailure = true;
    }
  }

  if (!structuralFailure) {
    try {
      policyFile = await readRegularFile(join(targetDirectory, "trust-policy.json"), TRUST_POLICY_LIMITS.maxBytes);
    } catch {
      diagnostics.push(diagnostic("POLICY_FILE_INVALID", "Policy file rejected", "The policy did not remain a bounded single-link regular file."));
      structuralFailure = true;
    }
    try {
      checksumFile = await readRegularFile(join(targetDirectory, "SHA256SUMS.txt"), TRUST_POLICY_CATALOG_LIMITS.maxChecksumBytes);
    } catch {
      diagnostics.push(diagnostic("CHECKSUM_FILE_INVALID", "Checksum file rejected", "The checksum did not remain a bounded single-link regular file."));
      structuralFailure = true;
    }
  }

  const policySha256 = policyFile ? sha256(policyFile.text) : undefined;
  const expectedPolicySha256 = checksumFile ? parseChecksum(checksumFile.text) : undefined;
  if (policyFile && checksumFile) {
    if (!expectedPolicySha256) {
      diagnostics.push(diagnostic("CHECKSUM_MALFORMED", "Checksum record rejected", "SHA256SUMS.txt must contain one lowercase SHA-256 record for trust-policy.json."));
      structuralFailure = true;
    } else if (policySha256 !== expectedPolicySha256) {
      diagnostics.push(diagnostic("CHECKSUM_MISMATCH", "Policy bytes changed", "The policy bytes no longer match the exported checksum record."));
      tampered = true;
    }
  }

  if (policyFile) {
    try {
      parsed = parseTrustPolicy(policyFile.text);
      if (parsed.policyId !== directoryName) {
        diagnostics.push(diagnostic("DIRECTORY_ID_MISMATCH", "Policy content address changed", "The policy ID does not match its enclosing directory."));
        tampered = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Trust Policy parsing failed.";
      if (/content digest|canonical/i.test(message)) {
        diagnostics.push(diagnostic("CONTENT_DIGEST_MISMATCH", "Policy content address changed", "The canonical policy payload no longer matches its content address."));
        tampered = true;
      } else {
        diagnostics.push(diagnostic("POLICY_SCHEMA_INVALID", "Policy schema rejected", "The artifact does not satisfy the supported bounded Trust Policy schema."));
        structuralFailure = true;
      }
    }
  }

  const state: TrustPolicyCatalogState = tampered ? "tampered" : structuralFailure ? "invalid" : "valid";
  const trusted = state === "valid" ? parsed : undefined;
  return {
    directoryName,
    state,
    policyId: trusted?.policyId,
    policyDigest: trusted?.policyDigest,
    policySha256,
    expectedPolicySha256,
    name: trusted?.name,
    description: trusted?.description,
    authorities: trusted?.verification.authorities,
    moduleManifestSha256: trusted?.appliesTo.moduleManifestSha256,
    relativePath: policyFile ? relative(root, join(targetDirectory, "trust-policy.json")).replaceAll("\\", "/") : undefined,
    checksumRelativePath: checksumFile ? relative(root, join(targetDirectory, "SHA256SUMS.txt")).replaceAll("\\", "/") : undefined,
    bytes: policyFile?.bytes,
    observedModifiedAt: latestTimestamp(policyFile?.modifiedAt, checksumFile?.modifiedAt),
    diagnostics,
  };
}

function catalog(entries: TrustPolicyCatalogEntry[], scannedDirectoryCount: number, truncated: boolean, issuedAt: string): TrustPolicyCatalog {
  const summary = {
    valid: entries.filter((entry) => entry.state === "valid").length,
    tampered: entries.filter((entry) => entry.state === "tampered").length,
    invalid: entries.filter((entry) => entry.state === "invalid").length,
    authorities: entries.filter((entry) => entry.state === "valid").reduce((total, entry) => total + (entry.authorities?.length ?? 0), 0),
  };
  const body = {
    schema: "proto-workbench.trust-policy-catalog.v1" as const,
    scannedDirectoryCount,
    returnedCount: entries.length,
    truncated,
    summary,
    entries,
    limits: {
      maxDirectories: TRUST_POLICY_CATALOG_LIMITS.maxDirectories,
      maxDirectoryEntries: TRUST_POLICY_CATALOG_LIMITS.maxDirectoryEntries,
      maxPolicyBytes: TRUST_POLICY_LIMITS.maxBytes,
    },
    boundary: TRUST_POLICY_CATALOG_BOUNDARY,
  };
  return { ...body, digest: sha256(stableJson(body)), issuedAt };
}

async function canonicalRoot(workspaceRoot: string): Promise<string> {
  const requested = resolve(workspaceRoot);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Trust Policy catalog requires a canonical workspace directory.");
  const canonical = await realpath(requested);
  if (!sameCanonicalPath(requested, canonical)) throw new Error("Trust Policy catalog cannot traverse a linked workspace root.");
  return canonical;
}

async function optionalCanonicalDirectory(parent: string, name: string, containmentRoot: string): Promise<string | undefined> {
  const candidate = join(parent, name);
  try {
    await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Trust Policy catalog could not inspect its directory.");
  }
  await assertCanonicalDirectory(candidate, containmentRoot);
  return candidate;
}

async function assertCanonicalDirectory(path: string, containmentRoot: string): Promise<void> {
  assertContained(containmentRoot, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Trust Policy catalog path is not a canonical directory.");
  const canonical = await realpath(path);
  assertContained(containmentRoot, canonical);
  if (!sameCanonicalPath(path, canonical)) throw new Error("Trust Policy catalog path cannot traverse links or junctions.");
}

async function readRegularFile(path: string, maximumBytes: number): Promise<SafeFile> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > maximumBytes) {
    throw new Error("Trust Policy file is not a bounded single-link regular file.");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Trust Policy file changed before it could be read.");
    }
    const text = await handle.readFile("utf8");
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("Trust Policy file changed during the read.");
    }
    return { text, bytes: Buffer.byteLength(text, "utf8"), modifiedAt: after.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

function parseChecksum(value: string): string | undefined {
  return /^([a-f0-9]{64})  trust-policy\.json\n$/.exec(value)?.[1];
}

function sameEntries(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function latestTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

function diagnostic(code: string, title: string, detail: string): DecisionBundleVerificationDiagnostic {
  return { code, title, detail };
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) return;
  throw new Error("Trust Policy catalog path is outside the active workspace.");
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
