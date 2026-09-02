import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  TransparencyWitnessCatalog,
  TransparencyWitnessCheck,
  TransparencyWitnessEntry,
  TransparencyWitnessImportReceipt,
  TransparencyWitnessSignature,
} from "../../shared/contracts.ts";

export const TRANSPARENCY_WITNESS_LIMITS = {
  maxDirectories: 24,
  maxDirectoryEntries: 6,
  maxNoteBytes: 64 * 1024,
  maxProofBytes: 512 * 1024,
  maxLeafBytes: 256 * 1024,
  maxSourceBytes: 16 * 1024,
  maxChecksumBytes: 4 * 1024,
  maxProofHashes: 63,
  maxWitnesses: 32,
} as const;

export const TRANSPARENCY_WITNESS_BOUNDARY = "Offline, read-only transparency verification. Packs are copied immutably and checked against a release-pinned Sigstore log key, checkpoint, and witness policy. The catalog cannot fetch a checkpoint, contact a witness, submit an entry, sign or cosign a note, replace policy, advance witness state, or authorize an effect.";

const PACK_DIRECTORY_PATTERN = /^tw_[a-f0-9]{24}$/;
const PACK_FILES = ["anchor-checkpoint.note", "checkpoint.note", "consistency.json", "inclusion.json", "SOURCE.json"] as const;
const CHECKSUM_FILE = "SHA256SUMS.txt";
const ALL_FILES = [...PACK_FILES, CHECKSUM_FILE].sort();
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

interface WitnessPolicyKey {
  name: string;
  publicKey: Buffer;
  keyId: Buffer;
}

export interface TransparencyWitnessPolicy {
  schema: "proto-workbench.transparency-witness-policy.v1";
  name: string;
  sha256: string;
  origin: string;
  log: WitnessPolicyKey;
  witnesses: WitnessPolicyKey[];
  quorum: number;
  maxFutureSkewSeconds: number;
  trustedRootSha256: string;
  checkpoint: ParsedCheckpointNote;
  checkpointEnvelopeSha256: string;
  retrievedAt: string;
  source: string;
}

interface PolicyDocument {
  schema: "proto-workbench.transparency-witness-policy.v1";
  name: string;
  origin: string;
  log: { name: string; publicKey: string };
  witnesses: Array<{ name: string; publicKey: string }>;
  quorum: number;
  maxFutureSkewSeconds: number;
  trustedRootSha256: string;
  checkpoint: {
    envelope: string;
    envelopeSha256: string;
    bodySha256: string;
    retrievedAt: string;
    source: string;
  };
}

interface SourceRecord {
  schema: "proto-workbench.transparency-witness-source.v1";
  source: string;
  retrievedAt: string;
  checkpointUrl?: string;
  note?: string;
}

interface PackFiles {
  anchor: Buffer;
  checkpoint: Buffer;
  consistency: Buffer;
  inclusion: Buffer;
  source: Buffer;
  checksums: Buffer;
  modifiedAt: string;
}

interface PackInspection {
  packId: string;
  files: PackFiles;
  fileDigests: Record<string, string>;
  sourceRecord: SourceRecord;
}

interface InclusionProof {
  schema: "proto-workbench.transparency-inclusion-proof.v1";
  logIndex: bigint;
  treeSize: bigint;
  leaf: Buffer;
  hashes: Buffer[];
}

interface ConsistencyProof {
  schema: "proto-workbench.transparency-consistency-proof.v1";
  oldSize: bigint;
  newSize: bigint;
  hashes: Buffer[];
}

interface NoteSignature {
  name: string;
  encoded: string;
  bytes: Buffer;
}

export interface ParsedCheckpointNote {
  envelope: string;
  body: string;
  origin: string;
  treeSize: bigint;
  rootHash: Buffer;
  bodySha256: string;
  signatures: NoteSignature[];
}

export async function importTransparencyWitnessPack(
  workspaceRoot: string,
  selectedDirectory: string,
  policyPath: string,
  trustedRootPath: string,
  importedAt = new Date().toISOString(),
  expectedPolicySha256?: string,
): Promise<TransparencyWitnessImportReceipt> {
  if (!validTimestamp(importedAt)) throw new Error("Transparency witness import timestamp is invalid.");
  const sourceRoot = await canonicalDirectory(selectedDirectory, "Selected transparency witness directory");
  const inspection = await inspectPackDirectory(sourceRoot);
  const policy = await loadTransparencyWitnessPolicy(policyPath, trustedRootPath, expectedPolicySha256);
  const workspace = await canonicalDirectory(workspaceRoot, "Workspace");
  const build = await ensureDirectory(workspace, "build", workspace);
  const witnessRoot = await ensureDirectory(build, "transparency-witness", workspace);
  const targetDirectory = join(witnessRoot, inspection.packId);
  let reused = false;
  try { await mkdir(targetDirectory, { recursive: false }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; reused = true; }
  await assertCanonicalDirectory(targetDirectory, workspace);

  const content = contentByName(inspection.files);
  let createdAny = false;
  for (const name of ALL_FILES) createdAny = await writeOrVerifyImmutable(join(targetDirectory, name), content[name]!, limitFor(name)) || createdAny;
  if (!sameEntries((await readdir(targetDirectory)).sort(), ALL_FILES)) throw new Error("Imported transparency witness pack contains unexpected entries.");

  await verifyTransparencyWitnessPack(policy, inspection.files, new Date(importedAt));
  return {
    schema: "proto-workbench.transparency-witness-import.v1",
    packId: inspection.packId,
    relativePath: relative(workspace, targetDirectory).replaceAll("\\", "/"),
    importedAt,
    reused: reused && !createdAny,
    files: ALL_FILES,
  };
}

export async function scanTransparencyWitnessPacks(
  workspaceRoot: string,
  policyPath: string,
  trustedRootPath: string,
  issuedAt = new Date().toISOString(),
  expectedPolicySha256?: string,
): Promise<TransparencyWitnessCatalog> {
  if (!validTimestamp(issuedAt)) throw new Error("Transparency witness catalog timestamp is invalid.");
  const workspace = await canonicalDirectory(workspaceRoot, "Workspace");
  const policy = await loadTransparencyWitnessPolicy(policyPath, trustedRootPath, expectedPolicySha256);
  const build = await optionalDirectory(workspace, "build", workspace);
  const witnessRoot = build ? await optionalDirectory(build, "transparency-witness", workspace) : undefined;
  if (!witnessRoot) return catalog([], 0, false, issuedAt, policy);

  const discovered = await discoverDirectories(witnessRoot, workspace);
  const entries: TransparencyWitnessEntry[] = [];
  for (const directoryName of discovered.names) {
    const directory = join(witnessRoot, directoryName);
    if (!PACK_DIRECTORY_PATTERN.test(directoryName)) {
      entries.push(invalidEntry(directoryName, "Pack directories must use the content-addressed tw_<24 lowercase hex> format."));
      continue;
    }
    try {
      const inspection = await inspectPackDirectory(directory);
      if (inspection.packId !== directoryName) {
        entries.push(invalidEntry(directoryName, `Current bytes resolve to ${inspection.packId}.`));
        continue;
      }
      const verification = await verifyTransparencyWitnessPack(policy, inspection.files, new Date(issuedAt));
      markPackChecks(verification.checks, inspection);
      entries.push({
        directoryName,
        packId: directoryName,
        relativePath: relative(workspace, directory).replaceAll("\\", "/"),
        source: inspection.sourceRecord.source,
        retrievedAt: inspection.sourceRecord.retrievedAt,
        observedModifiedAt: inspection.files.modifiedAt,
        ...verification,
      });
    } catch (error) {
      entries.push(invalidEntry(directoryName, safeMessage(error)));
    }
  }
  entries.sort((left, right) => (right.observedModifiedAt ?? "").localeCompare(left.observedModifiedAt ?? "") || left.directoryName.localeCompare(right.directoryName));
  return catalog(entries, discovered.scanned, discovered.truncated, issuedAt, policy);
}

export async function loadTransparencyWitnessPolicy(
  policyPath: string,
  trustedRootPath: string,
  expectedPolicySha256?: string,
): Promise<TransparencyWitnessPolicy> {
  const [policyFile, trustedRootFile] = await Promise.all([
    readSafeFile(policyPath, TRANSPARENCY_WITNESS_LIMITS.maxProofBytes),
    readSafeFile(trustedRootPath, TRANSPARENCY_WITNESS_LIMITS.maxProofBytes),
  ]);
  const policySha256 = digest(policyFile.bytes);
  if (expectedPolicySha256 && policySha256 !== expectedPolicySha256) throw new Error("Transparency witness policy does not match the expected release digest.");
  const document = parsePolicyDocument(policyFile.bytes);
  const trustedRootSha256 = digest(trustedRootFile.bytes);
  if (document.trustedRootSha256 !== trustedRootSha256) throw new Error("Transparency witness policy is not bound to the installed TrustedRoot bytes.");

  const trustedLogKey = trustedRootLogKey(trustedRootFile.bytes, document.origin);
  const configuredLogKey = parsePolicyKey(document.log, 0x01);
  if (document.log.name !== document.origin) throw new Error("Transparency log key name must match the checkpoint origin.");
  if (!configuredLogKey.publicKey.equals(trustedLogKey)) throw new Error("Transparency log key does not match the installed TrustedRoot.");
  const witnesses = document.witnesses.map((key) => parsePolicyKey(key, 0x04));
  if (new Set(witnesses.map((key) => key.name)).size !== witnesses.length) throw new Error("Transparency witness names must be unique.");

  const checkpoint = parseCheckpointNote(document.checkpoint.envelope);
  if (digest(Buffer.from(document.checkpoint.envelope, "utf8")) !== document.checkpoint.envelopeSha256) throw new Error("Pinned checkpoint envelope digest does not match policy.");
  if (checkpoint.bodySha256 !== document.checkpoint.bodySha256) throw new Error("Pinned checkpoint body digest does not match policy.");
  if (checkpoint.origin !== document.origin) throw new Error("Pinned checkpoint origin does not match policy.");

  const policy: TransparencyWitnessPolicy = {
    schema: document.schema,
    name: document.name,
    sha256: policySha256,
    origin: document.origin,
    log: configuredLogKey,
    witnesses,
    quorum: document.quorum,
    maxFutureSkewSeconds: document.maxFutureSkewSeconds,
    trustedRootSha256,
    checkpoint,
    checkpointEnvelopeSha256: document.checkpoint.envelopeSha256,
    retrievedAt: document.checkpoint.retrievedAt,
    source: document.checkpoint.source,
  };
  if (!verifyLogSignature(checkpoint, policy.log)) throw new Error("Pinned checkpoint log signature is invalid.");
  const anchorWitnesses = verifyWitnessSignatures(checkpoint, policy, new Date(document.checkpoint.retrievedAt));
  if (anchorWitnesses.filter((item) => item.state === "verified").length < policy.quorum || anchorWitnesses.some((item) => item.state === "rejected")) {
    throw new Error("Pinned checkpoint does not satisfy the configured witness quorum.");
  }
  return policy;
}

export async function verifyTransparencyWitnessPack(
  policy: TransparencyWitnessPolicy,
  files: Pick<PackFiles, "anchor" | "checkpoint" | "consistency" | "inclusion">,
  observedAt = new Date(),
): Promise<Omit<TransparencyWitnessEntry, "directoryName">> {
  const checks = createTransparencyWitnessChecks();
  const diagnostics: string[] = [];
  set(checks, "policy-anchor", "passed", `Release-pinned policy ${shortHash(policy.sha256)} is bound to the installed TrustedRoot.`);

  let anchor: ParsedCheckpointNote;
  let checkpoint: ParsedCheckpointNote;
  try {
    anchor = parseCheckpointNote(files.anchor.toString("utf8"));
    checkpoint = parseCheckpointNote(files.checkpoint.toString("utf8"));
    set(checks, "checkpoint-format", "passed", "Both C2SP checkpoint notes are canonical, bounded, and contain 32-byte Merkle roots.");
  } catch (error) {
    reject(checks, diagnostics, "checkpoint-format", "CHECKPOINT_FORMAT_INVALID", safeMessage(error));
    return { state: "rejected", checks, diagnostics };
  }

  const anchorSnapshot = checkpointSnapshot(anchor);
  const checkpointSnapshotValue = checkpointSnapshot(checkpoint);
  const exactAnchor = digest(files.anchor) === policy.checkpointEnvelopeSha256
    && anchor.bodySha256 === policy.checkpoint.bodySha256
    && anchor.treeSize === policy.checkpoint.treeSize
    && anchor.rootHash.equals(policy.checkpoint.rootHash);
  if (exactAnchor) set(checks, "anchor-checkpoint", "passed", `Pack starts from pinned tree size ${anchor.treeSize.toString()}.`);
  else reject(checks, diagnostics, "anchor-checkpoint", "ANCHOR_CHECKPOINT_MISMATCH", "Pack anchor is not the exact release-pinned checkpoint envelope.");

  if (checkpoint.origin !== policy.origin) reject(checks, diagnostics, "checkpoint-format", "CHECKPOINT_ORIGIN_MISMATCH", `Expected ${policy.origin}; received ${checkpoint.origin}.`);
  const logSignatureValid = verifyLogSignature(checkpoint, policy.log);
  if (logSignatureValid) set(checks, "log-signature", "passed", `Checkpoint carries a valid ${policy.log.keyId.toString("hex")} Ed25519 log signature.`);
  else reject(checks, diagnostics, "log-signature", "LOG_SIGNATURE_INVALID", "No valid signature from the TrustedRoot-bound log key was found.");

  const witnesses = verifyWitnessSignatures(checkpoint, policy, observedAt);
  const verifiedWitnesses = witnesses.filter((item) => item.state === "verified").length;
  const rejectedWitnesses = witnesses.filter((item) => item.state === "rejected");
  if (verifiedWitnesses >= policy.quorum && rejectedWitnesses.length === 0) {
    set(checks, "witness-quorum", "passed", `${verifiedWitnesses}-of-${policy.witnesses.length} configured witnesses verified; policy requires ${policy.quorum}.`);
  } else {
    reject(checks, diagnostics, "witness-quorum", "WITNESS_QUORUM_UNSATISFIED", `${verifiedWitnesses}-of-${policy.witnesses.length} configured witnesses verified; policy requires ${policy.quorum}.`);
  }
  if (rejectedWitnesses.length === 0) set(checks, "witness-time", "passed", "All accepted cosignatures carry non-zero timestamps within the configured future-skew bound.");
  else reject(checks, diagnostics, "witness-time", "WITNESS_SIGNATURE_REJECTED", rejectedWitnesses.map((item) => `${item.name}: ${item.detail}`).join("; "));

  const rollback = checkpoint.treeSize < anchor.treeSize;
  const sameSizeFork = checkpoint.treeSize === anchor.treeSize && !checkpoint.rootHash.equals(anchor.rootHash);
  if (!rollback) set(checks, "rollback-protection", "passed", `Candidate tree size ${checkpoint.treeSize.toString()} is not below pinned size ${anchor.treeSize.toString()}.`);
  else reject(checks, diagnostics, "rollback-protection", "CHECKPOINT_ROLLBACK", `Candidate tree size ${checkpoint.treeSize.toString()} is below pinned size ${anchor.treeSize.toString()}.`);
  if (!sameSizeFork) set(checks, "fork-detection", "passed", checkpoint.treeSize === anchor.treeSize ? "Equal-size checkpoint has the exact pinned root." : "Candidate advances beyond the pinned checkpoint; consistency proof is required.");
  else reject(checks, diagnostics, "fork-detection", "CHECKPOINT_FORK", "Candidate reuses the pinned tree size with a different Merkle root.");

  let inclusion: InclusionProof | undefined;
  try {
    inclusion = parseInclusionProof(files.inclusion);
    if (inclusion.treeSize !== checkpoint.treeSize) throw new Error("Inclusion treeSize does not match the verified checkpoint.");
    if (inclusion.logIndex >= inclusion.treeSize) throw new Error("Inclusion logIndex is outside the verified tree.");
    set(checks, "inclusion-structure", "passed", `${inclusion.hashes.length} bounded inclusion hashes target leaf ${inclusion.logIndex.toString()} at tree size ${inclusion.treeSize.toString()}.`);
    set(checks, "leaf-binding", "passed", `Exact leaf bytes hash to ${shortHash(digest(inclusion.leaf))}.`);
    if (verifyMerkleInclusion(inclusion.leaf, inclusion.logIndex, inclusion.treeSize, inclusion.hashes, checkpoint.rootHash)) {
      set(checks, "inclusion-proof", "passed", "RFC 6962 inclusion path reconstructs the root from the verified checkpoint.");
    } else reject(checks, diagnostics, "inclusion-proof", "INCLUSION_PROOF_INVALID", "Inclusion path does not reconstruct the verified checkpoint root.");
  } catch (error) {
    reject(checks, diagnostics, "inclusion-structure", "INCLUSION_PROOF_MALFORMED", safeMessage(error));
  }

  let consistency: ConsistencyProof | undefined;
  try {
    consistency = parseConsistencyProof(files.consistency);
    if (consistency.oldSize !== anchor.treeSize || consistency.newSize !== checkpoint.treeSize) throw new Error("Consistency proof sizes do not match the pinned and candidate checkpoints.");
    set(checks, "consistency-structure", "passed", `${consistency.hashes.length} bounded consistency hashes cover ${consistency.oldSize.toString()} → ${consistency.newSize.toString()}.`);
    if (verifyMerkleConsistency(anchor.treeSize, checkpoint.treeSize, anchor.rootHash, checkpoint.rootHash, consistency.hashes)) {
      set(checks, "consistency-proof", "passed", checkpoint.treeSize === anchor.treeSize ? "Equal-size checkpoint is identical and carries an empty proof." : "RFC 6962 consistency path proves an append-only extension from the pinned checkpoint.");
    } else reject(checks, diagnostics, "consistency-proof", "CONSISTENCY_PROOF_INVALID", "Consistency path does not prove the candidate is an append-only extension of the pinned checkpoint.");
  } catch (error) {
    reject(checks, diagnostics, "consistency-structure", "CONSISTENCY_PROOF_MALFORMED", safeMessage(error));
  }

  const failed = checks.some((check) => check.state === "failed");
  const current = checkpoint.treeSize === anchor.treeSize && checkpoint.rootHash.equals(anchor.rootHash);
  return {
    state: failed ? "rejected" : current ? "current" : "witnessed",
    anchor: anchorSnapshot,
    checkpoint: checkpointSnapshotValue,
    logKeyId: policy.log.keyId.toString("hex"),
    witnessQuorum: { required: policy.quorum, verified: verifiedWitnesses, configured: policy.witnesses.length },
    witnesses,
    inclusion: inclusion ? { logIndex: inclusion.logIndex.toString(), treeSize: inclusion.treeSize.toString(), leafSha256: digest(inclusion.leaf), proofHashCount: inclusion.hashes.length } : undefined,
    consistency: consistency ? { oldSize: consistency.oldSize.toString(), newSize: consistency.newSize.toString(), proofHashCount: consistency.hashes.length } : undefined,
    checks,
    diagnostics,
  };
}

export function parseCheckpointNote(envelope: string): ParsedCheckpointNote {
  if (!envelope || Buffer.byteLength(envelope, "utf8") > TRANSPARENCY_WITNESS_LIMITS.maxNoteBytes || envelope.includes("\r") || !envelope.endsWith("\n")) {
    throw new Error("Checkpoint note is empty, oversized, non-LF, or missing its final newline.");
  }
  const separator = envelope.indexOf("\n\n");
  if (separator < 0) throw new Error("Checkpoint note is missing the signed-note separator.");
  const body = envelope.slice(0, separator + 1);
  const bodyLines = body.slice(0, -1).split("\n");
  if (bodyLines.length < 3 || bodyLines.length > 19) throw new Error("Checkpoint body must contain origin, size, root, and at most sixteen extension lines.");
  const [origin, sizeText, rootText] = bodyLines;
  if (!origin || origin.length > 300 || /\s|:\/\//u.test(origin)) throw new Error("Checkpoint origin is not a bounded schema-less identifier.");
  const treeSize = decimalBigInt(sizeText, "checkpoint tree size");
  const rootHash = decodeBase64(rootText, "checkpoint root hash", 32);
  const signatureLines = envelope.slice(separator + 2).split("\n").filter(Boolean);
  if (!signatureLines.length || signatureLines.length > 64) throw new Error("Checkpoint note must contain between one and sixty-four signature lines.");
  const signatures = signatureLines.map((line) => {
    const match = /^— ([^\s]{1,300}) ([A-Za-z0-9+/]+={0,2})$/u.exec(line);
    if (!match) throw new Error("Checkpoint contains a malformed signed-note signature line.");
    return { name: match[1]!, encoded: match[2]!, bytes: decodeBase64(match[2]!, "checkpoint signature") };
  });
  return { envelope, body, origin, treeSize, rootHash, bodySha256: digest(Buffer.from(body, "utf8")), signatures };
}

export function verifyMerkleInclusion(leaf: Buffer, logIndex: bigint, treeSize: bigint, proof: Buffer[], expectedRoot: Buffer): boolean {
  if (treeSize <= 0n || logIndex < 0n || logIndex >= treeSize || proof.length > TRANSPARENCY_WITNESS_LIMITS.maxProofHashes || expectedRoot.length !== 32) return false;
  if (proof.some((hash) => hash.length !== 32)) return false;
  let node = leafHash(leaf);
  let fn = logIndex;
  let sn = treeSize - 1n;
  for (const hash of proof) {
    if ((fn & 1n) === 1n || fn === sn) {
      node = nodeHash(hash, node);
      while (fn !== 0n && (fn & 1n) === 0n) { fn >>= 1n; sn >>= 1n; }
    } else node = nodeHash(node, hash);
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && node.equals(expectedRoot);
}

export function verifyMerkleConsistency(oldSize: bigint, newSize: bigint, oldRoot: Buffer, newRoot: Buffer, proof: Buffer[]): boolean {
  if (oldSize < 0n || newSize < oldSize || newSize <= 0n || oldRoot.length !== 32 || newRoot.length !== 32) return false;
  if (proof.length > TRANSPARENCY_WITNESS_LIMITS.maxProofHashes || proof.some((hash) => hash.length !== 32)) return false;
  if (oldSize === 0n) return proof.length === 0 && oldRoot.equals(createHash("sha256").update(Buffer.alloc(0)).digest());
  if (oldSize === newSize) return proof.length === 0 && oldRoot.equals(newRoot);
  if (!proof.length) return false;

  let fn = oldSize - 1n;
  let sn = newSize - 1n;
  while ((fn & 1n) === 1n) { fn >>= 1n; sn >>= 1n; }
  let index = 0;
  let oldAccumulator: Buffer;
  let newAccumulator: Buffer;
  if (fn === 0n) {
    oldAccumulator = oldRoot;
    newAccumulator = oldRoot;
  } else {
    oldAccumulator = proof[0]!;
    newAccumulator = proof[0]!;
    index = 1;
  }
  for (; index < proof.length; index += 1) {
    const hash = proof[index]!;
    if ((fn & 1n) === 1n || fn === sn) {
      oldAccumulator = nodeHash(hash, oldAccumulator);
      newAccumulator = nodeHash(hash, newAccumulator);
      while (fn !== 0n && (fn & 1n) === 0n) { fn >>= 1n; sn >>= 1n; }
    } else newAccumulator = nodeHash(newAccumulator, hash);
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && oldAccumulator.equals(oldRoot) && newAccumulator.equals(newRoot);
}

function parsePolicyDocument(bytes: Buffer): PolicyDocument {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Transparency witness policy is not valid JSON."); }
  const document = value as Partial<PolicyDocument>;
  if (
    !document || typeof document !== "object" || Array.isArray(document)
    || document.schema !== "proto-workbench.transparency-witness-policy.v1"
    || typeof document.name !== "string" || !document.name.trim() || document.name.length > 160
    || typeof document.origin !== "string" || !document.origin || document.origin.length > 300 || /\s|:\/\//u.test(document.origin)
    || !document.log || typeof document.log.name !== "string" || typeof document.log.publicKey !== "string"
    || !Array.isArray(document.witnesses) || document.witnesses.length < 1 || document.witnesses.length > TRANSPARENCY_WITNESS_LIMITS.maxWitnesses
    || !document.witnesses.every((key) => key && typeof key.name === "string" && typeof key.publicKey === "string")
    || !Number.isInteger(document.quorum) || document.quorum! < 1 || document.quorum! > document.witnesses.length
    || !Number.isInteger(document.maxFutureSkewSeconds) || document.maxFutureSkewSeconds! < 0 || document.maxFutureSkewSeconds! > 3600
    || typeof document.trustedRootSha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.trustedRootSha256)
    || !document.checkpoint || typeof document.checkpoint.envelope !== "string"
    || typeof document.checkpoint.envelopeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.checkpoint.envelopeSha256)
    || typeof document.checkpoint.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.checkpoint.bodySha256)
    || typeof document.checkpoint.retrievedAt !== "string" || !validTimestamp(document.checkpoint.retrievedAt)
    || typeof document.checkpoint.source !== "string" || !/^https:\/\//.test(document.checkpoint.source) || document.checkpoint.source.length > 1000
  ) throw new Error("Transparency witness policy is malformed or outside its release bounds.");
  return document as PolicyDocument;
}

function trustedRootLogKey(bytes: Buffer, origin: string): Buffer {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Installed TrustedRoot is not valid JSON."); }
  const tlogs = (value as { tlogs?: unknown }).tlogs;
  if (!Array.isArray(tlogs)) throw new Error("Installed TrustedRoot does not contain transparency logs.");
  const baseUrl = `https://${origin}`;
  const match = tlogs.find((item) => {
    const record = item as { baseUrl?: unknown; publicKey?: { keyDetails?: unknown; rawBytes?: unknown } };
    return record?.baseUrl === baseUrl && record.publicKey?.keyDetails === "PKIX_ED25519" && typeof record.publicKey.rawBytes === "string";
  }) as { publicKey: { rawBytes: string } } | undefined;
  if (!match) throw new Error(`Installed TrustedRoot has no Ed25519 key for ${origin}.`);
  const spki = decodeBase64(match.publicKey.rawBytes, "TrustedRoot log public key");
  if (spki.length !== ED25519_SPKI_PREFIX.length + 32 || !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) throw new Error("TrustedRoot log key is not canonical Ed25519 SPKI.");
  return spki.subarray(ED25519_SPKI_PREFIX.length);
}

function parsePolicyKey(value: { name: string; publicKey: string }, signatureType: number): WitnessPolicyKey {
  if (!value.name || value.name.length > 300 || /\s/u.test(value.name)) throw new Error("Transparency policy key name is invalid.");
  const publicKey = decodeBase64(value.publicKey, `${value.name} public key`, 32);
  const keyId = createHash("sha256").update(Buffer.concat([Buffer.from(`${value.name}\n`, "utf8"), Buffer.from([signatureType]), publicKey])).digest().subarray(0, 4);
  return { name: value.name, publicKey, keyId };
}

function verifyLogSignature(note: ParsedCheckpointNote, key: WitnessPolicyKey): boolean {
  const matches = note.signatures.filter((signature) => signature.name === key.name && signature.bytes.length >= 4 && signature.bytes.subarray(0, 4).equals(key.keyId));
  if (!matches.length) return false;
  return matches.every((signature) => signature.bytes.length === 68 && verifyEd25519(Buffer.from(note.body, "utf8"), key.publicKey, signature.bytes.subarray(4)));
}

function verifyWitnessSignatures(note: ParsedCheckpointNote, policy: TransparencyWitnessPolicy, observedAt: Date): TransparencyWitnessSignature[] {
  const maximumTimestamp = BigInt(Math.floor(observedAt.getTime() / 1000) + policy.maxFutureSkewSeconds);
  return policy.witnesses.map((key) => {
    const matches = note.signatures.filter((signature) => signature.name === key.name && signature.bytes.length >= 4 && signature.bytes.subarray(0, 4).equals(key.keyId));
    if (!matches.length) return { name: key.name, keyId: key.keyId.toString("hex"), state: "missing", detail: "No matching cosignature is present." };
    let signedAt: string | undefined;
    for (const signature of matches) {
      if (signature.bytes.length !== 76) return { name: key.name, keyId: key.keyId.toString("hex"), state: "rejected", detail: "Cosignature length is invalid." };
      const timestamp = signature.bytes.readBigUInt64BE(4);
      if (timestamp === 0n || timestamp > 0x7fffffffffffffffn || timestamp > maximumTimestamp) return { name: key.name, keyId: key.keyId.toString("hex"), state: "rejected", detail: "Cosignature timestamp is zero, outside signed range, or in the future." };
      const message = Buffer.from(`cosignature/v1\ntime ${timestamp.toString()}\n${note.body}`, "utf8");
      if (!verifyEd25519(message, key.publicKey, signature.bytes.subarray(12))) return { name: key.name, keyId: key.keyId.toString("hex"), state: "rejected", detail: "Cosignature bytes do not verify against the configured witness key." };
      signedAt = new Date(Number(timestamp) * 1000).toISOString();
    }
    return { name: key.name, keyId: key.keyId.toString("hex"), state: "verified", signedAt, detail: "Timestamped cosignature verified." };
  });
}

function verifyEd25519(message: Buffer, rawPublicKey: Buffer, signature: Buffer): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]), format: "der", type: "spki" });
    return verifySignature(null, message, publicKey, signature);
  } catch { return false; }
}

function parseInclusionProof(bytes: Buffer): InclusionProof {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("inclusion.json is not valid JSON."); }
  const record = value as Record<string, unknown>;
  if (!record || Array.isArray(record) || record.schema !== "proto-workbench.transparency-inclusion-proof.v1" || typeof record.logIndex !== "string" || typeof record.treeSize !== "string" || typeof record.leaf !== "string" || !Array.isArray(record.hashes) || !record.hashes.every((item) => typeof item === "string") || record.hashes.length > TRANSPARENCY_WITNESS_LIMITS.maxProofHashes) throw new Error("inclusion.json is malformed or exceeds proof bounds.");
  return {
    schema: record.schema,
    logIndex: decimalBigInt(record.logIndex, "inclusion logIndex"),
    treeSize: decimalBigInt(record.treeSize, "inclusion treeSize"),
    leaf: decodeBase64(record.leaf, "inclusion leaf", undefined, TRANSPARENCY_WITNESS_LIMITS.maxLeafBytes),
    hashes: record.hashes.map((item) => decodeBase64(item as string, "inclusion proof hash", 32)),
  };
}

function parseConsistencyProof(bytes: Buffer): ConsistencyProof {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("consistency.json is not valid JSON."); }
  const record = value as Record<string, unknown>;
  if (!record || Array.isArray(record) || record.schema !== "proto-workbench.transparency-consistency-proof.v1" || typeof record.oldSize !== "string" || typeof record.newSize !== "string" || !Array.isArray(record.hashes) || !record.hashes.every((item) => typeof item === "string") || record.hashes.length > TRANSPARENCY_WITNESS_LIMITS.maxProofHashes) throw new Error("consistency.json is malformed or exceeds proof bounds.");
  return {
    schema: record.schema,
    oldSize: decimalBigInt(record.oldSize, "consistency oldSize"),
    newSize: decimalBigInt(record.newSize, "consistency newSize"),
    hashes: record.hashes.map((item) => decodeBase64(item as string, "consistency proof hash", 32)),
  };
}

async function inspectPackDirectory(directory: string): Promise<PackInspection> {
  await assertCanonicalDirectory(directory, directory);
  const names = (await readdir(directory)).sort();
  if (!sameEntries(names, ALL_FILES)) throw new Error("Transparency witness directory must contain the exact six-file offline pack.");
  const [anchor, checkpoint, consistency, inclusion, source, checksums] = await Promise.all([
    readSafeFile(join(directory, "anchor-checkpoint.note"), TRANSPARENCY_WITNESS_LIMITS.maxNoteBytes),
    readSafeFile(join(directory, "checkpoint.note"), TRANSPARENCY_WITNESS_LIMITS.maxNoteBytes),
    readSafeFile(join(directory, "consistency.json"), TRANSPARENCY_WITNESS_LIMITS.maxProofBytes),
    readSafeFile(join(directory, "inclusion.json"), TRANSPARENCY_WITNESS_LIMITS.maxProofBytes),
    readSafeFile(join(directory, "SOURCE.json"), TRANSPARENCY_WITNESS_LIMITS.maxSourceBytes),
    readSafeFile(join(directory, CHECKSUM_FILE), TRANSPARENCY_WITNESS_LIMITS.maxChecksumBytes),
  ]);
  const files: PackFiles = {
    anchor: anchor.bytes, checkpoint: checkpoint.bytes, consistency: consistency.bytes, inclusion: inclusion.bytes,
    source: source.bytes, checksums: checksums.bytes,
    modifiedAt: latestTimestamp(anchor.modifiedAt, checkpoint.modifiedAt, consistency.modifiedAt, inclusion.modifiedAt, source.modifiedAt, checksums.modifiedAt),
  };
  const sourceRecord = parseSourceRecord(source.bytes);
  const content = contentByName(files);
  const fileDigests = Object.fromEntries(PACK_FILES.map((name) => [name, digest(content[name]!) ]));
  if (checksums.bytes.toString("utf8") !== checksumManifest(fileDigests)) throw new Error("Transparency witness checksum manifest is non-canonical or does not match current files.");
  const packDigest = digest(Buffer.from(stableJson(fileDigests), "utf8"));
  return { packId: `tw_${packDigest.slice(0, 24)}`, files, fileDigests, sourceRecord };
}

function parseSourceRecord(bytes: Buffer): SourceRecord {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("SOURCE.json is not valid JSON."); }
  const record = value as Partial<SourceRecord>;
  if (
    !record || typeof record !== "object" || Array.isArray(record)
    || record.schema !== "proto-workbench.transparency-witness-source.v1"
    || typeof record.source !== "string" || !/^https:\/\//.test(record.source) || record.source.length > 1000
    || typeof record.retrievedAt !== "string" || !validTimestamp(record.retrievedAt)
    || (record.checkpointUrl !== undefined && (typeof record.checkpointUrl !== "string" || !/^https:\/\//.test(record.checkpointUrl) || record.checkpointUrl.length > 1000))
    || (record.note !== undefined && (typeof record.note !== "string" || record.note.length > 500))
  ) throw new Error("SOURCE.json is malformed or exceeds its review-only bounds.");
  return record as SourceRecord;
}

export function createTransparencyWitnessChecks(): TransparencyWitnessCheck[] {
  const definitions: Array<[TransparencyWitnessCheck["id"], string]> = [
    ["directory", "Canonical directory"], ["entries", "Exact six-file pack"], ["checksums", "SHA-256 manifest"], ["source-record", "Source record"],
    ["policy-anchor", "Pinned witness policy"], ["anchor-checkpoint", "Pinned checkpoint"], ["checkpoint-format", "C2SP checkpoint format"], ["log-signature", "Transparency log signature"],
    ["witness-quorum", "Witness quorum"], ["witness-time", "Witness timestamps"], ["leaf-binding", "Exact leaf binding"], ["inclusion-structure", "Inclusion structure"],
    ["inclusion-proof", "Merkle inclusion"], ["consistency-structure", "Consistency structure"], ["consistency-proof", "Merkle consistency"],
    ["rollback-protection", "Rollback protection"], ["fork-detection", "Split-view detection"],
  ];
  return definitions.map(([id, label]) => ({ id, label, state: "not-checked", detail: "Not checked." }));
}

function markPackChecks(checks: TransparencyWitnessCheck[], inspection: PackInspection): void {
  set(checks, "directory", "passed", `Content-addressed pack ID ${inspection.packId}.`);
  set(checks, "entries", "passed", "Exact six-file pack; linked and unexpected entries were rejected.");
  set(checks, "checksums", "passed", "Every pack byte matches the canonical SHA-256 manifest.");
  set(checks, "source-record", "passed", `Bounded source record retrieved ${inspection.sourceRecord.retrievedAt}.`);
}

function catalog(entries: TransparencyWitnessEntry[], scannedDirectoryCount: number, truncated: boolean, issuedAt: string, policy: TransparencyWitnessPolicy): TransparencyWitnessCatalog {
  const summary = {
    witnessed: entries.filter((entry) => entry.state === "witnessed").length,
    current: entries.filter((entry) => entry.state === "current").length,
    rejected: entries.filter((entry) => entry.state === "rejected").length,
    invalid: entries.filter((entry) => entry.state === "invalid").length,
  };
  const body = {
    schema: "proto-workbench.transparency-witness-catalog.v1" as const,
    scannedDirectoryCount,
    returnedCount: entries.length,
    truncated,
    summary,
    policy: {
      name: policy.name,
      sha256: policy.sha256,
      origin: policy.origin,
      logKeyId: policy.log.keyId.toString("hex"),
      witnessQuorum: policy.quorum,
      witnessCount: policy.witnesses.length,
      anchorTreeSize: policy.checkpoint.treeSize.toString(),
      anchorRootHash: policy.checkpoint.rootHash.toString("base64"),
      anchorBodySha256: policy.checkpoint.bodySha256,
      retrievedAt: policy.retrievedAt,
      trustedRootSha256: policy.trustedRootSha256,
      source: policy.source,
      updatePolicy: "offline-reviewed-release" as const,
    },
    entries,
    limits: {
      maxDirectories: TRANSPARENCY_WITNESS_LIMITS.maxDirectories,
      maxDirectoryEntries: TRANSPARENCY_WITNESS_LIMITS.maxDirectoryEntries,
      maxNoteBytes: TRANSPARENCY_WITNESS_LIMITS.maxNoteBytes,
      maxProofBytes: TRANSPARENCY_WITNESS_LIMITS.maxProofBytes,
      maxLeafBytes: TRANSPARENCY_WITNESS_LIMITS.maxLeafBytes,
    },
    boundary: TRANSPARENCY_WITNESS_BOUNDARY,
  };
  return { ...body, digest: digest(Buffer.from(stableJson(body), "utf8")), issuedAt };
}

function invalidEntry(directoryName: string, detail: string): TransparencyWitnessEntry {
  const checks = createTransparencyWitnessChecks();
  set(checks, "directory", "failed", detail);
  return { directoryName, state: "invalid", checks, diagnostics: [detail] };
}

function checkpointSnapshot(note: ParsedCheckpointNote) {
  return { origin: note.origin, treeSize: note.treeSize.toString(), rootHash: note.rootHash.toString("base64"), bodySha256: note.bodySha256 };
}

function reject(checks: TransparencyWitnessCheck[], diagnostics: string[], id: TransparencyWitnessCheck["id"], code: string, detail: string): void {
  set(checks, id, "failed", detail);
  diagnostics.push(`${code}: ${detail}`);
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
      if (scanned > TRANSPARENCY_WITNESS_LIMITS.maxDirectories) { truncated = true; break; }
      names.push(entry.name);
    }
  } finally { await directory.close().catch(() => undefined); }
  return { names: names.sort(), scanned: Math.min(scanned, TRANSPARENCY_WITNESS_LIMITS.maxDirectories), truncated };
}

async function readSafeFile(path: string, maximum: number): Promise<{ bytes: Buffer; modifiedAt: string }> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maximum) throw new Error("Transparency witness file is not a bounded single-link regular file.");
  const canonical = await realpath(path);
  if (!samePath(path, canonical)) throw new Error("Transparency witness file cannot traverse a link or junction.");
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error("Transparency witness file changed during verification.");
    return { bytes: await readFile(handle), modifiedAt: opened.mtime.toISOString() };
  } finally { await handle.close(); }
}

async function writeOrVerifyImmutable(path: string, content: Buffer, maximum: number): Promise<boolean> {
  if (content.length < 1 || content.length > maximum) throw new Error("Transparency witness file is outside its immutable write limit.");
  let handle;
  try { handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readSafeFile(path, maximum);
    if (!existing.bytes.equals(content)) throw new Error("Existing transparency witness bytes do not match the selected import.");
    return false;
  }
  try {
    await handle.writeFile(content); await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== content.length) throw new Error("Imported transparency witness file did not remain a single-link regular file.");
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
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Transparency witness path is not a canonical directory.");
  const canonical = await realpath(path);
  assertContained(containmentRoot, canonical);
  if (!samePath(path, canonical)) throw new Error("Transparency witness path cannot traverse links or junctions.");
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))) return;
  throw new Error("Transparency witness path is outside the allowed root.");
}

function contentByName(files: PackFiles): Record<string, Buffer | undefined> {
  return { "anchor-checkpoint.note": files.anchor, "checkpoint.note": files.checkpoint, "consistency.json": files.consistency, "inclusion.json": files.inclusion, "SOURCE.json": files.source, [CHECKSUM_FILE]: files.checksums };
}

function decimalBigInt(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error(`${label} is not a canonical uint64 decimal.`);
  const parsed = BigInt(value);
  if (parsed > 0xffffffffffffffffn) throw new Error(`${label} exceeds uint64.`);
  return parsed;
}

function decodeBase64(value: string, label: string, exactLength?: number, maximumLength?: number): Buffer {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`${label} is not canonical base64.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical base64.`);
  if (exactLength !== undefined && bytes.length !== exactLength) throw new Error(`${label} must be ${exactLength} bytes.`);
  if (maximumLength !== undefined && (bytes.length < 1 || bytes.length > maximumLength)) throw new Error(`${label} exceeds its byte bound.`);
  return bytes;
}

function leafHash(value: Buffer): Buffer { return createHash("sha256").update(Buffer.concat([Buffer.from([0x00]), value])).digest(); }
function nodeHash(left: Buffer, right: Buffer): Buffer { return createHash("sha256").update(Buffer.concat([Buffer.from([0x01]), left, right])).digest(); }
function checksumManifest(digests: Record<string, string>): string { return `${Object.keys(digests).sort().map((name) => `${digests[name]}  ${name}`).join("\n")}\n`; }
function limitFor(name: string): number { return name.endsWith(".note") ? TRANSPARENCY_WITNESS_LIMITS.maxNoteBytes : name === "SOURCE.json" ? TRANSPARENCY_WITNESS_LIMITS.maxSourceBytes : name === CHECKSUM_FILE ? TRANSPARENCY_WITNESS_LIMITS.maxChecksumBytes : TRANSPARENCY_WITNESS_LIMITS.maxProofBytes; }
function set(checks: TransparencyWitnessCheck[], id: TransparencyWitnessCheck["id"], state: TransparencyWitnessCheck["state"], detail: string): void { const check = checks.find((item) => item.id === id); if (check) Object.assign(check, { state, detail }); }
function sameEntries(actual: string[], expected: string[]): boolean { return actual.length === expected.length && actual.every((value, index) => value === expected[index]); }
function latestTimestamp(...timestamps: string[]): string { return [...timestamps].sort().at(-1) ?? new Date(0).toISOString(); }
function validTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function shortHash(value: string): string { return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value; }
function safeMessage(error: unknown): string { const value = error instanceof Error ? error.message : String(error); return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) || "Transparency witness verification failed closed."; }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`; }
  return JSON.stringify(value) ?? "null";
}
