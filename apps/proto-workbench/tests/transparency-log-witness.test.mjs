import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  importTransparencyWitnessPack,
  loadTransparencyWitnessPolicy,
  scanTransparencyWitnessPacks,
  verifyMerkleConsistency,
  verifyMerkleInclusion,
  verifyTransparencyWitnessPack,
} from "../src/main/services/transparency-log-witness.ts";

const FIXED_TIME = "2026-09-01T20:00:00.000Z";
const FIXED_SECONDS = BigInt(Math.floor(Date.parse(FIXED_TIME) / 1000) - 1);

test("validates RFC 6962 inclusion and consistency proofs", () => {
  const leaves = Array.from({ length: 8 }, (_, index) => Buffer.from(`leaf-${index}`, "utf8"));
  const oldRoot = treeHash(leaves.slice(0, 4));
  const newRoot = treeHash(leaves);
  const inclusion = inclusionProof(leaves, 6);
  const consistency = consistencyProof(leaves, 4, 8);
  assert.equal(verifyMerkleInclusion(leaves[6], 6n, 8n, inclusion, newRoot), true);
  assert.equal(verifyMerkleConsistency(4n, 8n, oldRoot, newRoot, consistency), true);
  const corrupted = consistency.map((item) => Buffer.from(item));
  corrupted[0][0] ^= 0xff;
  assert.equal(verifyMerkleConsistency(4n, 8n, oldRoot, newRoot, corrupted), false);
  assert.equal(verifyMerkleConsistency(4n, 4n, oldRoot, oldRoot, []), true);
  assert.equal(verifyMerkleConsistency(4n, 4n, oldRoot, newRoot, []), false);
  assert.equal(verifyMerkleConsistency(5n, 4n, oldRoot, newRoot, []), false);
  assert.equal(verifyMerkleConsistency(0n, 8n, sha256Buffer(Buffer.alloc(0)), newRoot, []), true);
  assert.equal(verifyMerkleConsistency(0n, 8n, Buffer.alloc(32, 9), newRoot, []), false);
});

test("loads a TrustedRoot-bound policy and verifies log plus witness signatures", async () => {
  const fixture = await createFixture("advance");
  const policy = await loadTransparencyWitnessPolicy(fixture.policyPath, fixture.trustedRootPath);
  assert.equal(policy.origin, fixture.origin);
  assert.equal(policy.quorum, 2);
  assert.equal(policy.checkpoint.treeSize, 4n);
  const result = await verifyTransparencyWitnessPack(policy, fixture.packFiles, new Date(FIXED_TIME));
  assert.equal(result.state, "witnessed");
  assert.equal(result.witnessQuorum?.verified, 2);
  assert.equal(result.inclusion?.logIndex, "7");
  assert.equal(result.consistency?.proofHashCount, 1);
  assert.deepEqual(result.diagnostics, []);
});

test("imports exact six-file packs immutably and reuses identical content", async () => {
  const fixture = await createFixture("advance");
  const first = await importTransparencyWitnessPack(fixture.workspace, fixture.packDirectory, fixture.policyPath, fixture.trustedRootPath, FIXED_TIME);
  const second = await importTransparencyWitnessPack(fixture.workspace, fixture.packDirectory, fixture.policyPath, fixture.trustedRootPath, FIXED_TIME);
  assert.match(first.packId, /^tw_[a-f0-9]{24}$/);
  assert.equal(first.files.length, 6);
  assert.equal(first.reused, false);
  assert.equal(second.packId, first.packId);
  assert.equal(second.reused, true);
  const catalog = await scanTransparencyWitnessPacks(fixture.workspace, fixture.policyPath, fixture.trustedRootPath, FIXED_TIME);
  assert.equal(catalog.summary.witnessed, 1);
  assert.equal(catalog.summary.rejected, 0);
  assert.equal(catalog.entries[0]?.packId, first.packId);
  assert.equal(catalog.entries[0]?.checks.every((check) => check.state === "passed"), true);
});

test("classifies an identical checkpoint as current with an empty consistency proof", async () => {
  const fixture = await createFixture("current");
  const policy = await loadTransparencyWitnessPolicy(fixture.policyPath, fixture.trustedRootPath);
  const result = await verifyTransparencyWitnessPack(policy, fixture.packFiles, new Date(FIXED_TIME));
  assert.equal(result.state, "current");
  assert.equal(result.consistency?.proofHashCount, 0);
  assert.equal(result.checkpoint?.rootHash, result.anchor?.rootHash);
});

test("retains rollback and equal-size fork evidence as rejected diagnostics", async () => {
  const rollbackFixture = await createFixture("rollback");
  const rollbackPolicy = await loadTransparencyWitnessPolicy(rollbackFixture.policyPath, rollbackFixture.trustedRootPath);
  const rollback = await verifyTransparencyWitnessPack(rollbackPolicy, rollbackFixture.packFiles, new Date(FIXED_TIME));
  assert.equal(rollback.state, "rejected");
  assert.equal(rollback.diagnostics.some((item) => item.startsWith("CHECKPOINT_ROLLBACK:")), true);
  assert.equal(stateOf(rollback.checks, "rollback-protection"), "failed");

  const forkFixture = await createFixture("fork");
  const forkPolicy = await loadTransparencyWitnessPolicy(forkFixture.policyPath, forkFixture.trustedRootPath);
  const fork = await verifyTransparencyWitnessPack(forkPolicy, forkFixture.packFiles, new Date(FIXED_TIME));
  assert.equal(fork.state, "rejected");
  assert.equal(fork.diagnostics.some((item) => item.startsWith("CHECKPOINT_FORK:")), true);
  assert.equal(stateOf(fork.checks, "fork-detection"), "failed");
  assert.equal(stateOf(fork.checks, "consistency-proof"), "failed");
});

test("fails closed for a missing witness quorum and a tampered inclusion path", async () => {
  const missingFixture = await createFixture("advance", { omitWitness: true });
  const missingPolicy = await loadTransparencyWitnessPolicy(missingFixture.policyPath, missingFixture.trustedRootPath);
  const missing = await verifyTransparencyWitnessPack(missingPolicy, missingFixture.packFiles, new Date(FIXED_TIME));
  assert.equal(missing.state, "rejected");
  assert.equal(stateOf(missing.checks, "witness-quorum"), "failed");

  const tamperedFixture = await createFixture("advance", { tamperInclusion: true });
  const tamperedPolicy = await loadTransparencyWitnessPolicy(tamperedFixture.policyPath, tamperedFixture.trustedRootPath);
  const tampered = await verifyTransparencyWitnessPack(tamperedPolicy, tamperedFixture.packFiles, new Date(FIXED_TIME));
  assert.equal(tampered.state, "rejected");
  assert.equal(stateOf(tampered.checks, "inclusion-proof"), "failed");
  assert.equal(tampered.diagnostics.some((item) => item.startsWith("INCLUSION_PROOF_INVALID:")), true);
});

test("rejects policy drift from the installed TrustedRoot and release digest", async () => {
  const fixture = await createFixture("advance");
  await assert.rejects(() => loadTransparencyWitnessPolicy(fixture.policyPath, fixture.trustedRootPath, "0".repeat(64)), /expected release digest/i);
  const trusted = JSON.parse(await readFile(fixture.trustedRootPath, "utf8"));
  trusted.tlogs[0].publicKey.rawBytes = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 7)]).toString("base64");
  await writeFile(fixture.trustedRootPath, `${JSON.stringify(trusted, null, 2)}\n`);
  await assert.rejects(() => loadTransparencyWitnessPolicy(fixture.policyPath, fixture.trustedRootPath), /installed TrustedRoot bytes/i);
});

async function createFixture(kind, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "proto-transparency-witness-"));
  const workspace = join(root, "workspace");
  const packDirectory = join(root, "pack");
  await mkdir(workspace);
  await mkdir(packDirectory);

  const origin = "log.fixture.example/transparency";
  const log = keyPair(origin, 0x01);
  const witnesses = [keyPair("witness.fixture.example/one", 0x04), keyPair("witness.fixture.example/two", 0x04)];
  const leaves = Array.from({ length: 8 }, (_, index) => Buffer.from(`fixture-leaf-${index}`, "utf8"));
  const anchorLeaves = leaves.slice(0, 4);
  const anchorRoot = treeHash(anchorLeaves);
  const anchorEnvelope = checkpointNote(origin, 4, anchorRoot, log, witnesses);

  let candidateLeaves;
  if (kind === "advance") candidateLeaves = leaves;
  else if (kind === "current") candidateLeaves = anchorLeaves;
  else if (kind === "rollback") candidateLeaves = leaves.slice(0, 3);
  else if (kind === "fork") candidateLeaves = [anchorLeaves[0], anchorLeaves[1], Buffer.from("forked-leaf", "utf8"), anchorLeaves[3]];
  else throw new Error(`Unknown fixture kind ${kind}`);
  const candidateRoot = treeHash(candidateLeaves);
  const candidateWitnesses = options.omitWitness ? witnesses.slice(0, 1) : witnesses;
  const checkpointEnvelope = checkpointNote(origin, candidateLeaves.length, candidateRoot, log, candidateWitnesses);
  const inclusionIndex = candidateLeaves.length - 1;
  const inclusionHashes = inclusionProof(candidateLeaves, inclusionIndex).map((hash) => Buffer.from(hash));
  if (options.tamperInclusion && inclusionHashes.length) inclusionHashes[0][0] ^= 0xff;
  const consistencyHashes = kind === "advance" ? consistencyProof(leaves, 4, 8) : [];

  const trustedRoot = {
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    tlogs: [{ baseUrl: `https://${origin}`, publicKey: { keyDetails: "PKIX_ED25519", rawBytes: log.spki.toString("base64") } }],
  };
  const trustedRootBytes = Buffer.from(`${JSON.stringify(trustedRoot, null, 2)}\n`, "utf8");
  const trustedRootPath = join(root, "trusted_root.json");
  await writeFile(trustedRootPath, trustedRootBytes);
  const policy = {
    schema: "proto-workbench.transparency-witness-policy.v1",
    name: "Fixture offline witness policy",
    origin,
    log: { name: origin, publicKey: log.raw.toString("base64") },
    witnesses: witnesses.map((key) => ({ name: key.name, publicKey: key.raw.toString("base64") })),
    quorum: 2,
    maxFutureSkewSeconds: 300,
    trustedRootSha256: sha256(trustedRootBytes),
    checkpoint: {
      envelope: anchorEnvelope,
      envelopeSha256: sha256(Buffer.from(anchorEnvelope, "utf8")),
      bodySha256: sha256(Buffer.from(noteBody(origin, 4, anchorRoot), "utf8")),
      retrievedAt: FIXED_TIME,
      source: "https://log.fixture.example/transparency/checkpoint",
    },
  };
  const policyPath = join(root, "WITNESS_POLICY.json");
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

  const inclusion = {
    schema: "proto-workbench.transparency-inclusion-proof.v1",
    logIndex: String(inclusionIndex),
    treeSize: String(candidateLeaves.length),
    leaf: candidateLeaves[inclusionIndex].toString("base64"),
    hashes: inclusionHashes.map((hash) => hash.toString("base64")),
  };
  const consistency = {
    schema: "proto-workbench.transparency-consistency-proof.v1",
    oldSize: "4",
    newSize: String(candidateLeaves.length),
    hashes: consistencyHashes.map((hash) => hash.toString("base64")),
  };
  const source = {
    schema: "proto-workbench.transparency-witness-source.v1",
    source: "https://log.fixture.example/transparency",
    retrievedAt: FIXED_TIME,
    checkpointUrl: "https://log.fixture.example/transparency/checkpoint",
    note: "Offline test fixture generated without network access.",
  };
  const files = {
    "anchor-checkpoint.note": Buffer.from(anchorEnvelope, "utf8"),
    "checkpoint.note": Buffer.from(checkpointEnvelope, "utf8"),
    "consistency.json": Buffer.from(`${JSON.stringify(consistency, null, 2)}\n`, "utf8"),
    "inclusion.json": Buffer.from(`${JSON.stringify(inclusion, null, 2)}\n`, "utf8"),
    "SOURCE.json": Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8"),
  };
  const checksums = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]));
  const checksumBytes = Buffer.from(`${Object.keys(checksums).sort().map((name) => `${checksums[name]}  ${name}`).join("\n")}\n`, "utf8");
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(packDirectory, name), bytes);
  await writeFile(join(packDirectory, "SHA256SUMS.txt"), checksumBytes);
  return {
    root,
    workspace,
    packDirectory,
    policyPath,
    trustedRootPath,
    origin,
    packFiles: { anchor: files["anchor-checkpoint.note"], checkpoint: files["checkpoint.note"], consistency: files["consistency.json"], inclusion: files["inclusion.json"] },
  };
}

function keyPair(name, type) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const raw = spki.subarray(spki.length - 32);
  const keyId = createHash("sha256").update(Buffer.concat([Buffer.from(`${name}\n`, "utf8"), Buffer.from([type]), raw])).digest().subarray(0, 4);
  return { name, privateKey, spki, raw, keyId };
}

function checkpointNote(origin, size, root, log, witnesses) {
  const body = noteBody(origin, size, root);
  const logSignature = Buffer.concat([log.keyId, sign(null, Buffer.from(body, "utf8"), log.privateKey)]).toString("base64");
  const lines = [`— ${log.name} ${logSignature}`];
  for (const witness of witnesses) {
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigUInt64BE(FIXED_SECONDS);
    const message = Buffer.from(`cosignature/v1\ntime ${FIXED_SECONDS.toString()}\n${body}`, "utf8");
    const signature = Buffer.concat([witness.keyId, timestamp, sign(null, message, witness.privateKey)]).toString("base64");
    lines.push(`— ${witness.name} ${signature}`);
  }
  return `${body}\n${lines.join("\n")}\n`;
}

function noteBody(origin, size, root) { return `${origin}\n${size}\n${root.toString("base64")}\n`; }
function leafHash(value) { return createHash("sha256").update(Buffer.concat([Buffer.from([0x00]), value])).digest(); }
function nodeHash(left, right) { return createHash("sha256").update(Buffer.concat([Buffer.from([0x01]), left, right])).digest(); }

function treeHash(leaves) {
  if (!leaves.length) return sha256Buffer(Buffer.alloc(0));
  if (leaves.length === 1) return leafHash(leaves[0]);
  const split = largestPowerOfTwoLessThan(leaves.length);
  return nodeHash(treeHash(leaves.slice(0, split)), treeHash(leaves.slice(split)));
}

function inclusionProof(leaves, index) {
  if (leaves.length === 1) return [];
  const split = largestPowerOfTwoLessThan(leaves.length);
  if (index < split) return [...inclusionProof(leaves.slice(0, split), index), treeHash(leaves.slice(split))];
  return [...inclusionProof(leaves.slice(split), index - split), treeHash(leaves.slice(0, split))];
}

function consistencyProof(leaves, oldSize, newSize) {
  return subproof(leaves.slice(0, newSize), oldSize, true);
}

function subproof(leaves, oldSize, complete) {
  if (oldSize === leaves.length) return complete ? [] : [treeHash(leaves)];
  const split = largestPowerOfTwoLessThan(leaves.length);
  if (oldSize <= split) return [...subproof(leaves.slice(0, split), oldSize, complete), treeHash(leaves.slice(split))];
  return [...subproof(leaves.slice(split), oldSize - split, false), treeHash(leaves.slice(0, split))];
}

function largestPowerOfTwoLessThan(value) {
  let power = 1;
  while (power * 2 < value) power *= 2;
  return power;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sha256Buffer(value) { return createHash("sha256").update(value).digest(); }
function stateOf(checks, id) { return checks.find((check) => check.id === id)?.state; }
