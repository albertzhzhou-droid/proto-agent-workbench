import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalize } from "@tufjs/canonical-json";
import {
  importTrustRootCandidate,
  scanTrustRootCandidates,
} from "../src/main/services/trust-root-lifecycle.ts";
import { loadTufAnchor, verifyOfflineTufCandidate } from "../src/main/services/tuf-offline.ts";

const RUNTIME_TRUST = join(process.cwd(), "runtime", "trust", "sigstore-public-good");
const INSTALLED_ROOT = join(RUNTIME_TRUST, "trusted_root.json");
const OFFICIAL_ANCHOR = join(RUNTIME_TRUST, "tuf", "15.root.json");
const OFFICIAL_CHECKPOINT = join(RUNTIME_TRUST, "tuf", "CHECKPOINT.json");
const NOW = "2026-08-31T23:30:00.000Z";

test("official Sigstore TUF v15 anchor is pinned, self-threshold verified, and checkpoint-bound", async () => {
  const anchor = await loadTufAnchor(OFFICIAL_ANCHOR, OFFICIAL_CHECKPOINT);
  assert.equal(anchor.root.signed.version, 15);
  assert.equal(anchor.root.signed.roles.root.threshold, 3);
  assert.equal(anchor.checkpoint.timestampVersion, 771);
  assert.equal(anchor.checkpoint.updatePolicy, "offline-review-only");
});

test("sequential dual-threshold root rotation and exact role/target bindings are reviewable offline", async () => {
  const fixture = await syntheticFixture({ rotate: true, changedTrustedRoot: false });
  const anchor = await loadTufAnchor(fixture.anchorRoot, fixture.checkpoint, fixture.anchorSha256);
  const result = await verifyOfflineTufCandidate(anchor, fixture.bytes, new Date(NOW));
  assert.equal(result.state, "reviewable");
  assert.equal(result.mode, "root-rotation");
  assert.equal(result.root?.candidateVersion, 2);
  assert.equal(result.checks.every((check) => check.state === "passed" || ["directory", "entries", "checksums", "source-record"].includes(check.id)), true);
});

test("current metadata refresh stays current while signature and rollback failures reject", async () => {
  const current = await syntheticFixture({ rotate: false, changedTrustedRoot: false });
  const anchor = await loadTufAnchor(current.anchorRoot, current.checkpoint, current.anchorSha256);
  const result = await verifyOfflineTufCandidate(anchor, current.bytes, new Date(NOW));
  assert.equal(result.state, "current");
  assert.equal(result.mode, "metadata-refresh");

  const rejectedBytes = { ...current.bytes, timestamp: Buffer.from(current.bytes.timestamp) };
  const timestamp = JSON.parse(rejectedBytes.timestamp.toString("utf8"));
  const signatureTail = timestamp.signatures[0].sig.slice(-2);
  timestamp.signatures[0].sig = `${timestamp.signatures[0].sig.slice(0, -2)}${signatureTail === "00" ? "01" : "00"}`;
  rejectedBytes.timestamp = jsonBytes(timestamp);
  const rejected = await verifyOfflineTufCandidate(anchor, rejectedBytes, new Date(NOW));
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.checks.find((check) => check.id === "timestamp-signature")?.state, "failed");
});

test("candidate import is content-addressed and catalog scanning is immutable and read-only", async () => {
  const fixture = await syntheticFixture({ rotate: true, changedTrustedRoot: true });
  const workspace = await mkdtemp(join(tmpdir(), "proto-trust-root-workspace-"));
  const receipt = await importTrustRootCandidate(workspace, fixture.pack, fixture.anchorRoot, fixture.checkpoint, INSTALLED_ROOT, NOW, fixture.anchorSha256);
  assert.match(receipt.candidateId, /^tr_[a-f0-9]{24}$/);
  assert.equal(receipt.reused, false);
  assert.deepEqual(receipt.files, ["SHA256SUMS.txt", "SOURCE.json", "root.json", "snapshot.json", "targets.json", "timestamp.json", "trusted_root.json"]);
  const second = await importTrustRootCandidate(workspace, fixture.pack, fixture.anchorRoot, fixture.checkpoint, INSTALLED_ROOT, NOW, fixture.anchorSha256);
  assert.equal(second.candidateId, receipt.candidateId);
  assert.equal(second.reused, true);

  const catalog = await scanTrustRootCandidates(workspace, fixture.anchorRoot, fixture.checkpoint, INSTALLED_ROOT, NOW, fixture.anchorSha256);
  assert.equal(catalog.summary.reviewable, 1);
  assert.equal(catalog.entries[0]?.trustedRoot?.changed, true);
  assert.equal(catalog.entries[0]?.checks.find((check) => check.id === "checksums")?.state, "passed");
  assert.match(catalog.boundary, /cannot download metadata/);
});

test("coordinated checksum edits cannot hide cryptographic tampering", async () => {
  const fixture = await syntheticFixture({ rotate: true, changedTrustedRoot: false });
  const root = JSON.parse((await readFile(join(fixture.pack, "root.json"), "utf8")));
  root.signatures = [];
  await writeFile(join(fixture.pack, "root.json"), jsonBytes(root));
  await rewriteChecksums(fixture.pack);
  const workspace = await mkdtemp(join(tmpdir(), "proto-trust-root-reject-"));
  const receipt = await importTrustRootCandidate(workspace, fixture.pack, fixture.anchorRoot, fixture.checkpoint, INSTALLED_ROOT, NOW, fixture.anchorSha256);
  const catalog = await scanTrustRootCandidates(workspace, fixture.anchorRoot, fixture.checkpoint, INSTALLED_ROOT, NOW, fixture.anchorSha256);
  assert.equal(catalog.entries.find((entry) => entry.candidateId === receipt.candidateId)?.state, "rejected");
  assert.equal(catalog.entries[0]?.checks.find((check) => check.id === "old-root-threshold")?.state, "failed");
});

async function syntheticFixture({ rotate, changedTrustedRoot }) {
  const rootDir = await mkdtemp(join(tmpdir(), "proto-tuf-fixture-"));
  const pack = join(rootDir, "pack");
  await mkdir(pack);
  const oldKey = keyPair("old-root");
  const newKey = keyPair("new-root");
  const roleKey = rotate ? newKey : oldKey;
  const anchorSigned = rootSigned(1, oldKey, oldKey);
  const anchor = signedMetadata(anchorSigned, [oldKey]);
  const candidateSigned = rotate ? rootSigned(2, newKey, roleKey, oldKey) : anchorSigned;
  const candidate = rotate ? signedMetadata(candidateSigned, [oldKey, newKey]) : anchor;
  const anchorBytes = jsonBytes(anchor);
  const anchorRoot = join(rootDir, "anchor.root.json");
  await writeFile(anchorRoot, anchorBytes);

  const installedBytes = await readFile(INSTALLED_ROOT);
  const trustedObject = JSON.parse(installedBytes.toString("utf8"));
  if (changedTrustedRoot) trustedObject.tlogs = trustedObject.tlogs.slice(0, 1);
  const trustedRoot = jsonBytes(trustedObject);
  const targetsSigned = {
    _type: "targets", spec_version: "1.0", version: 1, expires: "2035-01-01T00:00:00Z",
    targets: { "trusted_root.json": { length: trustedRoot.length, hashes: { sha256: hash(trustedRoot) } } },
  };
  const targets = jsonBytes(signedMetadata(targetsSigned, [roleKey]));
  const snapshotSigned = {
    _type: "snapshot", spec_version: "1.0", version: 1, expires: "2035-01-01T00:00:00Z",
    meta: { "targets.json": { version: 1, length: targets.length, hashes: { sha256: hash(targets) } } },
  };
  const snapshot = jsonBytes(signedMetadata(snapshotSigned, [roleKey]));
  const timestampSigned = {
    _type: "timestamp", spec_version: "1.0", version: 1, expires: "2035-01-01T00:00:00Z",
    meta: { "snapshot.json": { version: 1, length: snapshot.length, hashes: { sha256: hash(snapshot) } } },
  };
  const timestamp = jsonBytes(signedMetadata(timestampSigned, [roleKey]));
  const root = jsonBytes(candidate);
  const source = jsonBytes({
    schema: "proto-workbench.trust-root-candidate-source.v1",
    source: "https://github.com/example/offline-tuf-fixture",
    commit: "a".repeat(40),
    retrievedAt: NOW,
    note: "Synthetic software-only test fixture.",
  });
  await Promise.all([
    writeFile(join(pack, "root.json"), root), writeFile(join(pack, "timestamp.json"), timestamp),
    writeFile(join(pack, "snapshot.json"), snapshot), writeFile(join(pack, "targets.json"), targets),
    writeFile(join(pack, "trusted_root.json"), trustedRoot), writeFile(join(pack, "SOURCE.json"), source),
  ]);
  await rewriteChecksums(pack);
  const checkpoint = join(rootDir, "CHECKPOINT.json");
  await writeFile(checkpoint, jsonBytes({
    schema: "proto-workbench.sigstore-tuf-checkpoint.v1",
    source: "https://github.com/example/offline-tuf-fixture",
    upstreamCommit: "b".repeat(40), reviewedAt: NOW,
    root: { version: 1, sha256: hash(anchorBytes), threshold: 1, expires: "2035-01-01T00:00:00Z" },
    timestampVersion: 1, snapshotVersion: 1, targetsVersion: 1,
    trustedRootUpstreamSha256: hash(installedBytes), trustedRootPinnedSha256: hash(installedBytes),
    updatePolicy: "offline-review-only",
  }));
  return {
    pack, anchorRoot, checkpoint, anchorSha256: hash(anchorBytes),
    bytes: { root, timestamp, snapshot, targets, trustedRoot, installedTrustedRoot: installedBytes },
  };
}

function keyPair(label) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const publicHex = Buffer.from(der).subarray(-32).toString("hex");
  return { id: hash(Buffer.from(`${label}:${publicHex}`)), publicHex, privateKey };
}

function rootSigned(version, rootKey, roleKey, retainedKey) {
  const keys = Object.fromEntries([rootKey, roleKey, retainedKey].filter(Boolean).map((key) => [key.id, {
    keytype: "ed25519", scheme: "ed25519", keyval: { public: key.publicHex },
  }]));
  return {
    _type: "root", spec_version: "1.0", version, expires: "2035-01-01T00:00:00Z", consistent_snapshot: true,
    keys,
    roles: {
      root: { keyids: [rootKey.id], threshold: 1 },
      timestamp: { keyids: [roleKey.id], threshold: 1 },
      snapshot: { keyids: [roleKey.id], threshold: 1 },
      targets: { keyids: [roleKey.id], threshold: 1 },
    },
  };
}

function signedMetadata(signed, keys) {
  const bytes = Buffer.from(canonicalize(signed));
  return { signatures: keys.map((key) => ({ keyid: key.id, sig: sign(null, bytes, key.privateKey).toString("hex") })), signed };
}

async function rewriteChecksums(directory) {
  const names = ["root.json", "snapshot.json", "SOURCE.json", "targets.json", "timestamp.json", "trusted_root.json"].sort();
  const lines = [];
  for (const name of names) lines.push(`${hash(await readFile(join(directory, name)))}  ${name}`);
  await writeFile(join(directory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
