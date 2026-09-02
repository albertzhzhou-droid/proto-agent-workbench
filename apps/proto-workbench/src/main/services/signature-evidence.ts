import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DecisionBundleVerificationDiagnostic,
  SignatureEvidenceCatalog,
  SignatureEvidenceCheck,
  SignatureEvidenceCheckId,
  SignatureEvidenceCheckState,
  SignatureEvidenceEntry,
  SignatureEvidenceImportReceipt,
} from "../../shared/contracts.ts";
import { DECISION_BUNDLE_LIMITS, parseDecisionBundle } from "./decision-bundle.ts";
import { parseTrustPolicy, TRUST_POLICY_LIMITS } from "./trust-policy.ts";
import {
  loadPinnedTrustedRoot,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
  SIGSTORE_PUBLIC_GOOD_ROOT_SOURCE,
  SIGSTORE_PUBLIC_GOOD_ROOT_UPDATE_POLICY,
  verifyOfflineSigstore,
  type PinnedTrustedRoot,
} from "./sigstore-offline.ts";

export const SIGNATURE_EVIDENCE_LIMITS = {
  maxDirectories: 32,
  maxDirectoryEntries: 8,
  maxArtifactBytes: DECISION_BUNDLE_LIMITS.maxBytes,
  maxPolicyBytes: TRUST_POLICY_LIMITS.maxBytes,
  maxSignatureBundleBytes: 2 * 1024 * 1024,
  maxPublicKeyBytes: 64 * 1024,
  maxChecksumBytes: 2 * 1024,
} as const;

export const SIGNATURE_EVIDENCE_BOUNDARY = "Offline, read-only verification snapshot. It never signs, generates keys, activates trust, authorizes effects, or fetches certificates, logs, timestamps, policies, or roots from the network. A result remains incomplete unless artifact binding, cryptographic signature, trusted time, independently pinned trust, and exact authority identity all pass.";

const EVIDENCE_DIRECTORY_PATTERN = /^se_[a-f0-9]{24}$/;
const REQUIRED_FILES = ["decision-bundle.json", "signature.sigstore.json", "trust-policy.json"] as const;
const OPTIONAL_FILE = "public-key.pem";
const CHECKSUM_FILE = "SHA256SUMS.txt";

interface EvidenceFiles {
  decisionBundle: Buffer;
  signatureBundle: Buffer;
  trustPolicy: Buffer;
  publicKey?: Buffer;
  checksums: Buffer;
  modifiedAt: string;
}

interface EvidenceInspection {
  evidenceId: string;
  files: EvidenceFiles;
  fileNames: string[];
  fileDigests: Record<string, string>;
}

export async function importSignatureEvidence(
  workspaceRoot: string,
  selectedDirectory: string,
  trustedRootPath: string,
  importedAt = new Date().toISOString(),
): Promise<SignatureEvidenceImportReceipt> {
  if (!validTimestamp(importedAt)) throw new Error("Signature Evidence import timestamp is invalid.");
  const sourceRoot = await canonicalDirectory(selectedDirectory, "Selected Signature Evidence directory");
  const inspection = await inspectEvidenceDirectory(sourceRoot);
  const workspace = await canonicalDirectory(workspaceRoot, "Workspace");
  const build = await ensureDirectory(workspace, "build", workspace);
  const evidenceRoot = await ensureDirectory(build, "signature-evidence", workspace);
  const targetDirectory = join(evidenceRoot, inspection.evidenceId);
  let reused = false;
  try {
    await mkdir(targetDirectory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    reused = true;
  }
  await assertCanonicalDirectory(targetDirectory, workspace);

  const contentByName = evidenceContentByName(inspection.files);
  let createdAny = false;
  for (const fileName of inspection.fileNames) {
    const content = contentByName[fileName];
    if (!content) throw new Error(`Signature Evidence import is missing ${fileName}.`);
    createdAny = await writeOrVerifyImmutable(join(targetDirectory, fileName), content, limitFor(fileName)) || createdAny;
  }
  const targetEntries = (await readdir(targetDirectory)).sort();
  if (!sameEntries(targetEntries, inspection.fileNames)) throw new Error("Imported Signature Evidence directory contains unexpected entries.");

  const trustedRoot = await loadPinnedTrustedRoot(trustedRootPath);
  const verified = await verifyInspection(inspection, trustedRoot);
  if (verified.state === "invalid") throw new Error("Imported Signature Evidence could not be parsed after immutable export.");
  return {
    schema: "proto-workbench.signature-evidence-import.v1",
    evidenceId: inspection.evidenceId,
    relativePath: relative(workspace, targetDirectory).replaceAll("\\", "/"),
    importedAt,
    reused: reused && !createdAny,
    files: inspection.fileNames,
  };
}

export async function scanSignatureEvidence(
  workspaceRoot: string,
  trustedRootPath: string,
  issuedAt = new Date().toISOString(),
): Promise<SignatureEvidenceCatalog> {
  if (!validTimestamp(issuedAt)) throw new Error("Signature Evidence catalog timestamp is invalid.");
  const workspace = await canonicalDirectory(workspaceRoot, "Workspace");
  const trustedRoot = await loadPinnedTrustedRoot(trustedRootPath);
  const build = await optionalDirectory(workspace, "build", workspace);
  const evidenceRoot = build ? await optionalDirectory(build, "signature-evidence", workspace) : undefined;
  if (!evidenceRoot) return catalog([], 0, false, issuedAt, trustedRoot);

  const discovered = await discoverDirectories(evidenceRoot, workspace);
  const entries: SignatureEvidenceEntry[] = [];
  for (const directoryName of discovered.names) {
    const directory = join(evidenceRoot, directoryName);
    if (!EVIDENCE_DIRECTORY_PATTERN.test(directoryName)) {
      entries.push(invalidEntry(directoryName, "INVALID_DIRECTORY_NAME", "Evidence directory name rejected", "Evidence directories must use the content-addressed se_<24 lowercase hex> format."));
      continue;
    }
    try {
      const inspection = await inspectEvidenceDirectory(directory);
      if (inspection.evidenceId !== directoryName) {
        entries.push(invalidEntry(directoryName, "EVIDENCE_ID_MISMATCH", "Evidence directory is not content-addressed", `Current files resolve to ${inspection.evidenceId}.`));
        continue;
      }
      const entry = await verifyInspection(inspection, trustedRoot);
      entry.relativePath = relative(workspace, directory).replaceAll("\\", "/");
      entries.push(entry);
    } catch (error) {
      entries.push(invalidEntry(directoryName, errorCode(error, "EVIDENCE_INVALID"), "Evidence pack rejected", safeMessage(error)));
    }
  }
  entries.sort((left, right) => (right.observedModifiedAt ?? "").localeCompare(left.observedModifiedAt ?? "") || left.directoryName.localeCompare(right.directoryName));
  return catalog(entries, discovered.scanned, discovered.truncated, issuedAt, trustedRoot);
}

async function verifyInspection(inspection: EvidenceInspection, trustedRoot: PinnedTrustedRoot): Promise<SignatureEvidenceEntry> {
  const checks = initialChecks();
  pass(checks, "directory", `Content-addressed evidence ID ${inspection.evidenceId}.`);
  pass(checks, "entries", `${inspection.fileNames.length} exact bounded files; no linked or unexpected entry was accepted.`);
  pass(checks, "checksums", "Every imported file matches the exact SHA-256 checksum manifest.");
  const diagnostics: DecisionBundleVerificationDiagnostic[] = [];
  let decisionBundle;
  let policy;
  try {
    decisionBundle = parseDecisionBundle(inspection.files.decisionBundle.toString("utf8"));
    pass(checks, "decision-bundle", `Canonical ${decisionBundle.bundleId} content and subject bindings passed.`);
  } catch (error) {
    fail(checks, "decision-bundle", safeMessage(error));
    diagnostics.push(diagnostic("DECISION_BUNDLE_INVALID", "Decision Bundle rejected", safeMessage(error)));
  }
  try {
    policy = parseTrustPolicy(inspection.files.trustPolicy.toString("utf8"));
    pass(checks, "trust-policy", `Canonical ${policy.policyId} exact authority policy passed.`);
  } catch (error) {
    fail(checks, "trust-policy", safeMessage(error));
    diagnostics.push(diagnostic("TRUST_POLICY_INVALID", "Trust Policy rejected", safeMessage(error)));
  }
  if (!decisionBundle || !policy) {
    markRemaining(checks, "not-checked", "Skipped because a required canonical artifact was rejected.");
    return {
      directoryName: inspection.evidenceId,
      evidenceId: inspection.evidenceId,
      state: "invalid",
      artifactSha256: inspection.fileDigests["decision-bundle.json"],
      signatureBundleSha256: inspection.fileDigests["signature.sigstore.json"],
      observedModifiedAt: inspection.files.modifiedAt,
      checks,
      diagnostics,
    };
  }

  const moduleMatch = policy.appliesTo.moduleManifestSha256 === undefined
    || policy.appliesTo.moduleManifestSha256 === decisionBundle.attestation.predicate.producer.moduleManifestSha256;
  if (moduleMatch) pass(checks, "module-manifest", policy.appliesTo.moduleManifestSha256 ? "Policy and Decision Bundle pin the same module manifest digest." : "Policy intentionally does not pin a module manifest digest.");
  else {
    fail(checks, "module-manifest", "Policy and Decision Bundle module manifest digests differ.");
    diagnostics.push(diagnostic("MODULE_MANIFEST_MISMATCH", "Module manifest policy mismatch", "The Decision Bundle producer manifest is not the manifest pinned by this Trust Policy."));
  }

  let sigstore;
  try {
    sigstore = verifyOfflineSigstore({
      artifact: inspection.files.decisionBundle,
      serializedBundle: inspection.files.signatureBundle.toString("utf8"),
      policy,
      trustedRoot,
      publicKeyPem: inspection.files.publicKey?.toString("utf8"),
    });
    pass(checks, "sigstore-bundle", `${SIGSTORE_BUNDLE_MEDIA_TYPE} parsed with exactly one supported signed-content form.`);
  } catch (error) {
    fail(checks, "sigstore-bundle", safeMessage(error));
    markRemaining(checks, "not-checked", "Skipped because the Sigstore bundle was rejected.");
    diagnostics.push(diagnostic(errorCode(error, "SIGSTORE_BUNDLE_INVALID"), "Sigstore bundle rejected", safeMessage(error)));
    return {
      directoryName: inspection.evidenceId,
      evidenceId: inspection.evidenceId,
      bundleId: decisionBundle.bundleId,
      bundleDigest: decisionBundle.bundleDigest,
      policyId: policy.policyId,
      policyDigest: policy.policyDigest,
      state: "invalid",
      artifactSha256: inspection.fileDigests["decision-bundle.json"],
      signatureBundleSha256: inspection.fileDigests["signature.sigstore.json"],
      observedModifiedAt: inspection.files.modifiedAt,
      checks,
      diagnostics,
    };
  }

  set(checks, "artifact-binding", sigstore.artifactBinding, sigstore.artifactBinding === "passed" ? "The signature binds the exact decision-bundle.json bytes." : "The signed digest or DSSE payload does not match decision-bundle.json.");
  set(checks, "cryptographic-signature", sigstore.cryptographicSignature, sigstore.cryptographicSignature === "passed" ? "The signature verifies with the certificate or policy-pinned public key." : "Cryptographic signature verification failed.");
  set(checks, "trusted-time", sigstore.trustedTime === "verified" ? "passed" : sigstore.trustedTime === "missing" ? "missing" : "failed", sigstore.trustedTime === "verified" ? "Signed time and transparency material passed offline verification." : sigstore.trustedTime === "missing" ? "No independently verifiable signed time is present." : "Signed time or transparency verification failed.");
  set(checks, "trust-root", sigstore.trustRoot === "passed" ? "passed" : sigstore.trustRoot === "missing" ? "missing" : "failed", sigstore.trustRoot === "passed" ? "Signer trust chains to the pinned root or exact policy-pinned public key." : sigstore.trustRoot === "missing" ? "Signer trust cannot be completed without trusted time." : "Signer trust did not validate against the pinned root or policy key.");
  set(checks, "authority-identity", sigstore.authorityIdentity === "passed" ? "passed" : sigstore.authorityIdentity === "not-checked" ? "not-checked" : "failed", sigstore.authorityIdentity === "passed" ? "Exact issuer and SAN, or exact public-key SPKI digest, matches policy." : "No exact Trust Policy authority matched the verified signer.");
  diagnostics.push(...sigstore.diagnostics);
  if (!moduleMatch) sigstore.state = "rejected";

  return {
    directoryName: inspection.evidenceId,
    evidenceId: inspection.evidenceId,
    bundleId: decisionBundle.bundleId,
    bundleDigest: decisionBundle.bundleDigest,
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    state: sigstore.state,
    artifactSha256: sigstore.artifactSha256,
    signatureBundleSha256: sigstore.bundleSha256,
    signatureMediaType: sigstore.mediaType,
    signatureContent: sigstore.content,
    observedModifiedAt: inspection.files.modifiedAt,
    identity: sigstore.identity,
    signedTime: {
      status: sigstore.trustedTime,
      ...sigstore.signedTime,
    },
    trustRoot: sigstore.identity?.kind === "public-key"
      ? { name: "policy-pinned-public-key", sha256: sigstore.identity.publicKeySha256!, source: `Trust Policy ${policy.policyId}` }
      : { name: "sigstore-public-good", sha256: trustedRoot.sha256, mediaType: trustedRoot.mediaType, source: SIGSTORE_PUBLIC_GOOD_ROOT_SOURCE },
    checks,
    diagnostics,
  };
}

async function inspectEvidenceDirectory(directory: string): Promise<EvidenceInspection> {
  await assertCanonicalDirectory(directory, directory);
  const entries = await readdir(directory);
  if (entries.length < 4 || entries.length > SIGNATURE_EVIDENCE_LIMITS.maxDirectoryEntries) throw new Error("Signature Evidence directory entry count is invalid.");
  const names = [...entries].sort();
  const allowed = [...REQUIRED_FILES, CHECKSUM_FILE, OPTIONAL_FILE];
  if (names.some((name) => !allowed.includes(name as any)) || REQUIRED_FILES.some((name) => !names.includes(name)) || !names.includes(CHECKSUM_FILE)) {
    throw new Error("Signature Evidence directory contains missing or unsupported entries.");
  }
  const expected = inspectionFileNames(names.includes(OPTIONAL_FILE));
  if (!sameEntries(names, expected)) throw new Error("Signature Evidence directory entry set is not exact.");

  const decisionBundle = await readSafeFile(join(directory, "decision-bundle.json"), SIGNATURE_EVIDENCE_LIMITS.maxArtifactBytes);
  const signatureBundle = await readSafeFile(join(directory, "signature.sigstore.json"), SIGNATURE_EVIDENCE_LIMITS.maxSignatureBundleBytes);
  const trustPolicy = await readSafeFile(join(directory, "trust-policy.json"), SIGNATURE_EVIDENCE_LIMITS.maxPolicyBytes);
  const checksums = await readSafeFile(join(directory, CHECKSUM_FILE), SIGNATURE_EVIDENCE_LIMITS.maxChecksumBytes);
  const publicKey = names.includes(OPTIONAL_FILE) ? await readSafeFile(join(directory, OPTIONAL_FILE), SIGNATURE_EVIDENCE_LIMITS.maxPublicKeyBytes) : undefined;
  const files: EvidenceFiles = {
    decisionBundle: decisionBundle.bytes,
    signatureBundle: signatureBundle.bytes,
    trustPolicy: trustPolicy.bytes,
    publicKey: publicKey?.bytes,
    checksums: checksums.bytes,
    modifiedAt: latestTimestamp(decisionBundle.modifiedAt, signatureBundle.modifiedAt, trustPolicy.modifiedAt, checksums.modifiedAt, publicKey?.modifiedAt),
  };
  const content = evidenceContentByName(files);
  const signedNames = expected.filter((name) => name !== CHECKSUM_FILE);
  const fileDigests = Object.fromEntries(signedNames.map((name) => [name, digest(content[name]!) ]));
  const checksumText = checksums.bytes.toString("utf8");
  const expectedChecksums = checksumManifest(fileDigests);
  if (checksumText !== expectedChecksums) throw new Error("Signature Evidence checksum manifest is non-canonical or does not match current files.");
  const evidenceDigest = digest(Buffer.from(stableJson(fileDigests), "utf8"));
  return { evidenceId: `se_${evidenceDigest.slice(0, 24)}`, files, fileNames: expected, fileDigests };
}

function evidenceContentByName(files: EvidenceFiles): Record<string, Buffer | undefined> {
  return {
    "decision-bundle.json": files.decisionBundle,
    "signature.sigstore.json": files.signatureBundle,
    "trust-policy.json": files.trustPolicy,
    ...(files.publicKey ? { [OPTIONAL_FILE]: files.publicKey } : {}),
    [CHECKSUM_FILE]: files.checksums,
  };
}

function inspectionFileNames(publicKey: boolean): string[] {
  return [...REQUIRED_FILES, ...(publicKey ? [OPTIONAL_FILE] : []), CHECKSUM_FILE].sort();
}

function checksumManifest(digests: Record<string, string>): string {
  return `${Object.keys(digests).sort().map((name) => `${digests[name]}  ${name}`).join("\n")}\n`;
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
      if (scanned > SIGNATURE_EVIDENCE_LIMITS.maxDirectories) {
        truncated = true;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { names: names.sort(), scanned: Math.min(scanned, SIGNATURE_EVIDENCE_LIMITS.maxDirectories), truncated };
}

function catalog(entries: SignatureEvidenceEntry[], scannedDirectoryCount: number, truncated: boolean, issuedAt: string, trustedRoot: PinnedTrustedRoot): SignatureEvidenceCatalog {
  const summary = {
    verified: entries.filter((entry) => entry.state === "verified").length,
    incomplete: entries.filter((entry) => entry.state === "incomplete").length,
    rejected: entries.filter((entry) => entry.state === "rejected").length,
    invalid: entries.filter((entry) => entry.state === "invalid").length,
  };
  const body = {
    schema: "proto-workbench.signature-evidence-catalog.v1" as const,
    scannedDirectoryCount,
    returnedCount: entries.length,
    truncated,
    summary,
    trustRootSnapshot: {
      name: "sigstore-public-good" as const,
      sha256: trustedRoot.sha256,
      mediaType: trustedRoot.mediaType,
      source: SIGSTORE_PUBLIC_GOOD_ROOT_SOURCE,
      updatePolicy: SIGSTORE_PUBLIC_GOOD_ROOT_UPDATE_POLICY,
    },
    entries,
    limits: {
      maxDirectories: SIGNATURE_EVIDENCE_LIMITS.maxDirectories,
      maxDirectoryEntries: SIGNATURE_EVIDENCE_LIMITS.maxDirectoryEntries,
      maxArtifactBytes: SIGNATURE_EVIDENCE_LIMITS.maxArtifactBytes,
      maxSignatureBundleBytes: SIGNATURE_EVIDENCE_LIMITS.maxSignatureBundleBytes,
    },
    boundary: SIGNATURE_EVIDENCE_BOUNDARY,
  };
  return { ...body, digest: digest(Buffer.from(stableJson(body), "utf8")), issuedAt };
}

function invalidEntry(directoryName: string, code: string, title: string, detail: string): SignatureEvidenceEntry {
  const checks = initialChecks();
  fail(checks, "directory", detail);
  markRemaining(checks, "not-checked", "Skipped after directory validation failed.");
  return { directoryName, state: "invalid", checks, diagnostics: [diagnostic(code, title, detail)] };
}

function initialChecks(): SignatureEvidenceCheck[] {
  const definitions: Array<[SignatureEvidenceCheckId, string]> = [
    ["directory", "Canonical directory"],
    ["entries", "Exact evidence set"],
    ["checksums", "SHA-256 manifest"],
    ["decision-bundle", "Decision Bundle"],
    ["trust-policy", "Trust Policy"],
    ["module-manifest", "Module manifest binding"],
    ["sigstore-bundle", "Sigstore v0.3 structure"],
    ["artifact-binding", "Artifact binding"],
    ["cryptographic-signature", "Cryptographic signature"],
    ["trusted-time", "Trusted time"],
    ["trust-root", "Trust root"],
    ["authority-identity", "Exact authority identity"],
  ];
  return definitions.map(([id, label]) => ({ id, label, state: "not-checked", detail: "Not checked yet." }));
}

function set(checks: SignatureEvidenceCheck[], id: SignatureEvidenceCheckId, state: SignatureEvidenceCheckState, detail: string): void {
  const check = checks.find((candidate) => candidate.id === id);
  if (check) Object.assign(check, { state, detail });
}

function pass(checks: SignatureEvidenceCheck[], id: SignatureEvidenceCheckId, detail: string): void { set(checks, id, "passed", detail); }
function fail(checks: SignatureEvidenceCheck[], id: SignatureEvidenceCheckId, detail: string): void { set(checks, id, "failed", detail); }
function markRemaining(checks: SignatureEvidenceCheck[], state: SignatureEvidenceCheckState, detail: string): void {
  for (const check of checks) if (check.state === "not-checked") Object.assign(check, { state, detail });
}

async function readSafeFile(path: string, maximum: number): Promise<{ bytes: Buffer; modifiedAt: string }> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maximum) throw new Error("Evidence file is not a bounded single-link regular file.");
  const canonical = await realpath(path);
  if (!samePath(path, canonical)) throw new Error("Evidence file cannot traverse a link or junction.");
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error("Evidence file changed during verification.");
    return { bytes: await readFile(handle), modifiedAt: opened.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

async function writeOrVerifyImmutable(path: string, content: Buffer, maximum: number): Promise<boolean> {
  if (content.length < 1 || content.length > maximum) throw new Error("Evidence file is outside its immutable write limit.");
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readSafeFile(path, maximum);
    if (existing.bytes.length !== content.length || !existing.bytes.equals(content)) throw new Error("Existing Signature Evidence bytes do not match the selected import.");
    return false;
  }
  try {
    await handle.writeFile(content);
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== content.length) throw new Error("Imported evidence did not remain a single-link regular file.");
  } finally {
    await handle.close();
  }
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
  await assertCanonicalDirectory(target, workspace);
  return target;
}

async function optionalDirectory(parent: string, name: string, workspace: string): Promise<string | undefined> {
  const target = join(parent, name);
  try { await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  await assertCanonicalDirectory(target, workspace);
  return target;
}

async function assertCanonicalDirectory(path: string, containmentRoot: string): Promise<void> {
  assertContained(containmentRoot, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Signature Evidence path is not a canonical directory.");
  const canonical = await realpath(path);
  assertContained(containmentRoot, canonical);
  if (!samePath(path, canonical)) throw new Error("Signature Evidence path cannot traverse links or junctions.");
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))) return;
  throw new Error("Signature Evidence path is outside the allowed root.");
}

function sameEntries(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function latestTimestamp(...timestamps: Array<string | undefined>): string {
  return timestamps.filter((value): value is string => Boolean(value)).sort().at(-1) ?? new Date(0).toISOString();
}

function limitFor(name: string): number {
  if (name === "decision-bundle.json") return SIGNATURE_EVIDENCE_LIMITS.maxArtifactBytes;
  if (name === "trust-policy.json") return SIGNATURE_EVIDENCE_LIMITS.maxPolicyBytes;
  if (name === "signature.sigstore.json") return SIGNATURE_EVIDENCE_LIMITS.maxSignatureBundleBytes;
  if (name === OPTIONAL_FILE) return SIGNATURE_EVIDENCE_LIMITS.maxPublicKeyBytes;
  return SIGNATURE_EVIDENCE_LIMITS.maxChecksumBytes;
}

function diagnostic(code: string, title: string, detail: string): DecisionBundleVerificationDiagnostic { return { code, title, detail }; }
function errorCode(error: unknown, fallback: string): string {
  const value = (error as { code?: unknown })?.code;
  return typeof value === "string" && /^[A-Z0-9_]{3,64}$/.test(value) ? value : fallback;
}
function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length > 320 ? `${normalized.slice(0, 319)}…` : normalized || "Evidence verification failed closed.";
}
function validTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase() : resolve(left) === resolve(right);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
