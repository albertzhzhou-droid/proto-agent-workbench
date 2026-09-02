import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  TrustPolicyAuthority,
  TrustPolicyAuthorityInput,
  TrustPolicyExportReceipt,
  TrustPolicyPreview,
} from "../../shared/contracts.ts";

export const TRUST_POLICY_LIMITS = {
  maxBytes: 64 * 1024,
  maxAuthorities: 8,
  maxNameBytes: 96,
  maxDescriptionBytes: 512,
} as const;

export const TRUST_POLICY_BOUNDARY = "Policy artifact only. Rules are evaluated only after cryptographic signature, certificate or key, trusted-time, and artifact-digest verification succeeds. This policy cannot sign a bundle, create a key, trust an identity, authorize an effect, or fetch verification material from the network.";

export interface TrustPolicyBuildOptions {
  name: string;
  description: string;
  authorities: TrustPolicyAuthorityInput[];
  moduleManifestSha256?: string;
}

export function buildTrustPolicy(options: TrustPolicyBuildOptions): TrustPolicyPreview {
  const name = boundedText(options.name, "Trust Policy name", 1, TRUST_POLICY_LIMITS.maxNameBytes);
  const description = boundedText(options.description, "Trust Policy description", 1, TRUST_POLICY_LIMITS.maxDescriptionBytes);
  if (!Array.isArray(options.authorities) || options.authorities.length < 1 || options.authorities.length > TRUST_POLICY_LIMITS.maxAuthorities) {
    throw new Error(`Trust Policies require between 1 and ${TRUST_POLICY_LIMITS.maxAuthorities} authorities.`);
  }
  if (options.moduleManifestSha256 !== undefined) sha(options.moduleManifestSha256, "module manifest digest");
  const authorities = normalizeAuthorities(options.authorities);
  const content = {
    schema: "proto-workbench.trust-policy.v1" as const,
    mediaType: "application/vnd.proto-workbench.trust-policy+json" as const,
    fileName: "trust-policy.json" as const,
    name,
    description,
    appliesTo: {
      bundleMediaType: "application/vnd.proto-workbench.decision-bundle+json" as const,
      statementType: "https://in-toto.io/Statement/v1" as const,
      predicateType: "urn:proto-workbench:attestation:policy-simulation:v1" as const,
      producerName: "Proto Workbench" as const,
      ...(options.moduleManifestSha256 ? { moduleManifestSha256: options.moduleManifestSha256 } : {}),
    },
    verification: {
      authorityMode: "any-of" as const,
      authorities,
      requireArtifactDigest: true as const,
      requireSignedTimeEvidence: true as const,
      allowNetworkFetch: false as const,
    },
    authentication: {
      status: "policy-only" as const,
      assurance: "no-signature-evaluated" as const,
      detail: "This content-addressed policy defines exact authority constraints. It is not verification evidence and does not activate trust by itself.",
    },
    boundary: TRUST_POLICY_BOUNDARY,
  };
  const policyDigest = sha256(stableJson(content));
  const policy: TrustPolicyPreview = {
    ...content,
    policyId: `tp_${policyDigest.slice(0, 24)}`,
    policyDigest,
  };
  if (Buffer.byteLength(serializeTrustPolicy(policy), "utf8") > TRUST_POLICY_LIMITS.maxBytes) {
    throw new Error("Trust Policy exceeds its serialized size limit.");
  }
  return policy;
}

export function verifyTrustPolicy(value: unknown): asserts value is TrustPolicyPreview {
  const policy = record(value, "Trust Policy");
  exactKeys(policy, ["schema", "mediaType", "policyId", "policyDigest", "fileName", "name", "description", "appliesTo", "verification", "authentication", "boundary"], "Trust Policy");
  exact(policy.schema, "proto-workbench.trust-policy.v1", "schema");
  exact(policy.mediaType, "application/vnd.proto-workbench.trust-policy+json", "media type");
  pattern(policy.policyId, /^tp_[a-f0-9]{24}$/, "policy ID");
  sha(policy.policyDigest, "policy digest");
  exact(policy.fileName, "trust-policy.json", "file name");
  boundedText(policy.name, "Trust Policy name", 1, TRUST_POLICY_LIMITS.maxNameBytes);
  boundedText(policy.description, "Trust Policy description", 1, TRUST_POLICY_LIMITS.maxDescriptionBytes);

  const appliesTo = record(policy.appliesTo, "appliesTo");
  exactKeys(appliesTo, ["bundleMediaType", "statementType", "predicateType", "producerName", ...(appliesTo.moduleManifestSha256 === undefined ? [] : ["moduleManifestSha256"])], "appliesTo");
  exact(appliesTo.bundleMediaType, "application/vnd.proto-workbench.decision-bundle+json", "bundle media type");
  exact(appliesTo.statementType, "https://in-toto.io/Statement/v1", "Statement type");
  exact(appliesTo.predicateType, "urn:proto-workbench:attestation:policy-simulation:v1", "predicate type");
  exact(appliesTo.producerName, "Proto Workbench", "producer name");
  if (appliesTo.moduleManifestSha256 !== undefined) sha(appliesTo.moduleManifestSha256, "module manifest digest");

  const verification = record(policy.verification, "verification");
  exactKeys(verification, ["authorityMode", "authorities", "requireArtifactDigest", "requireSignedTimeEvidence", "allowNetworkFetch"], "verification");
  exact(verification.authorityMode, "any-of", "authority mode");
  exact(verification.requireArtifactDigest, true, "artifact digest requirement");
  exact(verification.requireSignedTimeEvidence, true, "signed time requirement");
  exact(verification.allowNetworkFetch, false, "network fetch boundary");
  if (!Array.isArray(verification.authorities) || verification.authorities.length < 1 || verification.authorities.length > TRUST_POLICY_LIMITS.maxAuthorities) {
    throw new Error("Trust Policy authority count is invalid.");
  }
  const normalized = normalizeAuthorities(verification.authorities as TrustPolicyAuthority[]);
  if (stableJson(normalized) !== stableJson(verification.authorities)) {
    throw new Error("Trust Policy authorities are not in canonical order.");
  }

  const authentication = record(policy.authentication, "authentication");
  exactKeys(authentication, ["status", "assurance", "detail"], "authentication");
  exact(authentication.status, "policy-only", "authentication status");
  exact(authentication.assurance, "no-signature-evaluated", "authentication assurance");
  boundedText(authentication.detail, "authentication detail", 1, 1_024);
  exact(policy.boundary, TRUST_POLICY_BOUNDARY, "policy boundary");

  const { policyId: _policyId, policyDigest: _policyDigest, ...content } = policy;
  const computed = sha256(stableJson(content));
  if (computed !== policy.policyDigest || policy.policyId !== `tp_${computed.slice(0, 24)}`) {
    throw new Error("Trust Policy content digest does not match its payload.");
  }
}

export function parseTrustPolicy(serialized: string): TrustPolicyPreview {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > TRUST_POLICY_LIMITS.maxBytes) {
    throw new Error("Trust Policy exceeds its serialized size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Trust Policy JSON is invalid.");
  }
  verifyTrustPolicy(parsed);
  if (`${JSON.stringify(parsed, null, 2)}\n` !== serialized) {
    throw new Error("Trust Policy serialization is not canonical.");
  }
  return parsed;
}

export function serializeTrustPolicy(policy: TrustPolicyPreview): string {
  verifyTrustPolicy(policy);
  const serialized = `${JSON.stringify(policy, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > TRUST_POLICY_LIMITS.maxBytes) {
    throw new Error("Trust Policy exceeds its serialized size limit.");
  }
  return serialized;
}

export async function exportTrustPolicy(workspaceRoot: string, policy: TrustPolicyPreview): Promise<TrustPolicyExportReceipt> {
  verifyTrustPolicy(policy);
  const root = await canonicalRoot(workspaceRoot);
  const buildDirectory = await ensureCanonicalDirectory(root, "build");
  const policiesRoot = await ensureCanonicalDirectory(buildDirectory, "trust-policies", root);
  const targetDirectory = join(policiesRoot, policy.policyId);
  let reused = false;
  try {
    await mkdir(targetDirectory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    reused = true;
  }
  await assertCanonicalDirectory(targetDirectory, root);

  const serialized = serializeTrustPolicy(policy);
  const policySha256 = sha256(serialized);
  const checksum = `${policySha256}  ${policy.fileName}\n`;
  const policyPath = join(targetDirectory, policy.fileName);
  const checksumPath = join(targetDirectory, "SHA256SUMS.txt");
  const wrotePolicy = await writeOrVerifyImmutable(policyPath, serialized, TRUST_POLICY_LIMITS.maxBytes);
  const wroteChecksum = await writeOrVerifyImmutable(checksumPath, checksum, 512);
  const entries = (await readdir(targetDirectory)).sort();
  if (entries.length !== 2 || entries[0] !== "SHA256SUMS.txt" || entries[1] !== policy.fileName) {
    throw new Error("Trust Policy directory contains unexpected entries and cannot be trusted.");
  }
  return {
    schema: "proto-workbench.trust-policy-receipt.v1",
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    policySha256,
    relativePath: relative(root, policyPath).replaceAll("\\", "/"),
    checksumRelativePath: relative(root, checksumPath).replaceAll("\\", "/"),
    bytes: Buffer.byteLength(serialized, "utf8"),
    exportedAt: new Date().toISOString(),
    reused: reused && !wrotePolicy && !wroteChecksum,
  };
}

function normalizeAuthorities(authorities: Array<TrustPolicyAuthorityInput | TrustPolicyAuthority>): TrustPolicyAuthority[] {
  const names = new Set<string>();
  const constraints = new Set<string>();
  const normalized = authorities.map((authority, index): TrustPolicyAuthority => {
    const item = record(authority, `authority ${index + 1}`);
    if (item.kind !== "keyless" && item.kind !== "public-key") throw new Error("Trust Policy authority kind is invalid.");
    const name = boundedText(item.name, "authority name", 1, 64);
    const nameKey = name.toLocaleLowerCase();
    if (names.has(nameKey)) throw new Error("Trust Policy authority names must be unique.");
    names.add(nameKey);
    if (item.kind === "keyless") {
      const issuer = boundedIdentity(item.certificateIssuer ?? item.issuer, "certificate issuer", 512);
      validateHttpsIssuer(issuer);
      const subject = boundedIdentity(item.certificateIdentity ?? item.subject, "certificate identity", 512);
      const constraint = `keyless\0${issuer}\0${subject}`;
      if (constraints.has(constraint)) throw new Error("Trust Policy authority constraints must be unique.");
      constraints.add(constraint);
      return {
        kind: "keyless",
        name,
        certificateIssuer: issuer,
        certificateIdentity: subject,
        trustRoot: "sigstore-public-good",
        requireTransparencyLog: true,
      };
    }
    const publicKeySha256 = item.publicKeySha256;
    sha(publicKeySha256, "public key digest");
    const constraint = `public-key\0${publicKeySha256}`;
    if (constraints.has(constraint)) throw new Error("Trust Policy authority constraints must be unique.");
    constraints.add(constraint);
    return { kind: "public-key", name, publicKeySha256 };
  });
  return normalized.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

async function canonicalRoot(workspaceRoot: string): Promise<string> {
  const requested = resolve(workspaceRoot);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Trust Policy export requires a canonical workspace directory.");
  const canonical = await realpath(requested);
  if (!sameCanonicalPath(requested, canonical)) throw new Error("Trust Policy export cannot traverse a linked workspace root.");
  return canonical;
}

async function ensureCanonicalDirectory(parent: string, name: string, containmentRoot = parent): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error("Trust Policy directory name is invalid.");
  const candidate = join(parent, name);
  try {
    await mkdir(candidate, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertCanonicalDirectory(candidate, containmentRoot);
  return candidate;
}

async function assertCanonicalDirectory(path: string, containmentRoot: string): Promise<void> {
  assertContained(containmentRoot, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Trust Policy export path is not a canonical directory.");
  const canonical = await realpath(path);
  assertContained(containmentRoot, canonical);
  if (!sameCanonicalPath(path, canonical)) throw new Error("Trust Policy export path cannot traverse links or junctions.");
}

async function writeOrVerifyImmutable(path: string, content: string, maxBytes: number): Promise<boolean> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) throw new Error("Trust Policy artifact exceeds its write limit.");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readImmutable(path, maxBytes);
    if (existing !== content) throw new Error("An existing Trust Policy artifact does not match the requested content.");
    return false;
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== bytes) throw new Error("Trust Policy artifact did not remain a single-link regular file.");
  } finally {
    await handle.close();
  }
  return true;
}

async function readImmutable(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > maxBytes) {
    throw new Error("Existing Trust Policy artifact is not a bounded single-link regular file.");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== info.size || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error("Existing Trust Policy artifact changed during verification.");
    }
    return await readFile(handle, "utf8");
  } finally {
    await handle.close();
  }
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, any>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function exact<T>(value: unknown, expected: T, label: string): asserts value is T {
  if (value !== expected) throw new Error(`Trust Policy ${label} is invalid.`);
}

function pattern(value: unknown, expected: RegExp, label: string): asserts value is string {
  if (typeof value !== "string" || !expected.test(value)) throw new Error(`Trust Policy ${label} is invalid.`);
}

function sha(value: unknown, label: string): asserts value is string {
  pattern(value, /^[a-f0-9]{64}$/, label);
}

function boundedText(value: unknown, label: string, minBytes: number, maxBytes: number): string {
  if (typeof value !== "string" || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid.`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minBytes || bytes > maxBytes) throw new Error(`${label} is outside its size limit.`);
  return value;
}

function boundedIdentity(value: unknown, label: string, maxBytes: number): string {
  const identity = boundedText(value, label, 3, maxBytes);
  if (/\s/u.test(identity)) throw new Error(`Trust Policy ${label} must be an exact whitespace-free value.`);
  return identity;
}

function validateHttpsIssuer(value: string): void {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new Error("Trust Policy certificate issuer must be an absolute HTTPS URL.");
  }
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash) {
    throw new Error("Trust Policy certificate issuer must be an absolute HTTPS URL without credentials or a fragment.");
  }
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) return;
  throw new Error("Trust Policy path is outside the active workspace.");
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
