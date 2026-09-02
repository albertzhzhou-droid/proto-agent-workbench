import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Stage 16 contracts, IPC, preload, main handlers, and IPC schemas are wired", async () => {
  const [contracts, ipc, preload, main, security] = await Promise.all([
    read("src/shared/contracts.ts"), read("src/shared/ipc.ts"), read("src/preload/index.ts"), read("src/main/index.ts"), read("src/main/ipc-security.ts"),
  ]);
  for (const token of ["TransparencyWitnessCatalog", "TransparencyWitnessEntry", "TransparencyWitnessImportReceipt", "importTransparencyWitnessPack", "listTransparencyWitnessPacks"]) assert.match(contracts, new RegExp(token));
  assert.match(ipc, /harnessTransparencyWitnessImport: "harness:transparency-witness-import"/);
  assert.match(ipc, /harnessTransparencyWitnessList: "harness:transparency-witness-list"/);
  assert.match(preload, /importTransparencyWitnessPack: \(\) => invoke\(IPC\.harnessTransparencyWitnessImport\)/);
  assert.match(preload, /listTransparencyWitnessPacks: \(\) => invoke\(IPC\.harnessTransparencyWitnessList\)/);
  assert.match(main, /importTransparencyWitnessPack\(activeWorkspacePath, selected, paths\.policy, paths\.trustedRoot\)/);
  assert.match(main, /scanTransparencyWitnessPacks\(activeWorkspacePath, paths\.policy, paths\.trustedRoot\)/);
  assert.match(main, /WITNESS_POLICY\.json/);
  assert.match(security, /\[IPC\.harnessTransparencyWitnessImport\]: noArguments/);
  assert.match(security, /\[IPC\.harnessTransparencyWitnessList\]: noArguments/);
});

test("Stage 16 verifier is offline, bounded, content-addressed, and fail-closed", async () => {
  const source = await read("src/main/services/transparency-log-witness.ts");
  for (const required of [
    "tw_[a-f0-9]{24}", "maxProofHashes: 63", "anchor-checkpoint.note", "checkpoint.note", "inclusion.json", "consistency.json",
    "verifyMerkleInclusion", "verifyMerkleConsistency", "cosignature/v1", "CHECKPOINT_ROLLBACK", "CHECKPOINT_FORK",
    "WITNESS_QUORUM_UNSATISFIED", "INCLUSION_PROOF_INVALID", "CONSISTENCY_PROOF_INVALID", "nlink !== 1", "O_NOFOLLOW",
  ]) assert.equal(source.includes(required), true, `missing ${required}`);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /https?\.(?:get|request)\s*\(/);
  assert.doesNotMatch(source, /createPrivateKey|generateKeyPair|\bsign\s*\(/);
  assert.match(source, /cannot fetch a checkpoint, contact a witness, submit an entry, sign or cosign a note/);
});

test("Stage 16 release policy pins Rekor v2, TrustedRoot, checkpoint, and two public witnesses", async () => {
  const raw = await read("runtime/trust/sigstore-public-good/transparency/WITNESS_POLICY.json");
  const policy = JSON.parse(raw);
  assert.equal(policy.schema, "proto-workbench.transparency-witness-policy.v1");
  assert.equal(policy.origin, "log2025-1.rekor.sigstore.dev");
  assert.equal(policy.log.name, policy.origin);
  assert.equal(policy.quorum, 2);
  assert.deepEqual(policy.witnesses.map((item) => item.name), ["witness.stagemole.eu", "staging.witness.transparency.goog/ring-any-bells"]);
  assert.equal(policy.checkpoint.envelopeSha256, "a7b2667dc7b82f337e8b812401f744b6b057aacefa3062eeb3866d012a1564e7");
  assert.equal(policy.checkpoint.bodySha256, "9ad268597f331f72d3bcc5eb0a2849e34a6f38b31ebd8020b6d5daeee463a176");
  assert.match(policy.checkpoint.envelope, /^log2025-1\.rekor\.sigstore\.dev\n91610831\n/);
  assert.match(policy.checkpoint.envelope, /— witness\.stagemole\.eu /);
  assert.match(policy.checkpoint.envelope, /— staging\.witness\.transparency\.goog\/ring-any-bells /);
});

test("Stage 16 center exposes interactive filters, import, diagnostics, quorum, and navigation", async () => {
  const [center, decision, signatures, mock, styles] = await Promise.all([
    read("src/renderer/TransparencyLogWitnessCenter.tsx"), read("src/renderer/DecisionBundleVerificationCenter.tsx"),
    read("src/renderer/SignatureEvidenceCenter.tsx"), read("src/renderer/mock-api.ts"), read("src/renderer/styles.css"),
  ]);
  for (const text of ["Transparency Log Witness Center", "Witnessed", "Attention", "Import witness pack", "Independent transparency chain", "Checkpoint continuity", "Independent witness quorum", "Merkle inclusion", "Merkle consistency", "Split-view detection"]) assert.equal(center.includes(text), true, `missing UI copy ${text}`);
  assert.match(center, /listTransparencyWitnessPacks\(\)/);
  assert.match(center, /importTransparencyWitnessPack\(\)/);
  assert.match(center, /role="dialog"/);
  assert.match(center, /aria-modal="true"/);
  assert.match(decision, /TransparencyLogWitnessCenter/);
  assert.match(signatures, /Log witnesses/);
  assert.match(mock, /summary: \{ witnessed: 1, current: 1, rejected: 2, invalid: 0 \}/);
  assert.match(mock, /CHECKPOINT_ROLLBACK/);
  assert.match(mock, /CHECKPOINT_FORK/);
  assert.match(styles, /\.transparency-stage-chain > div \{ grid-template-columns: repeat\(6/);
  assert.match(styles, /\.transparency-witness-quorum/);
  assert.match(styles, /\.transparency-checkpoint-row/);
});

test("Stage 16 connector registry and workspace template declare the same offline boundary", async () => {
  const [rootRegistry, templateRegistry] = await Promise.all([
    read("../../connectors/proto_workbench.json"), read("runtime/workspace-template/connectors/proto_workbench.json"),
  ]);
  for (const raw of [rootRegistry, templateRegistry]) {
    const registry = JSON.parse(raw);
    const connector = registry.connectors.find((item) => item.id === "transparency_log_witness");
    assert.ok(connector);
    assert.equal(connector.status, "available");
    assert.equal(connector.artifacts.length, 6);
    assert.match(connector.purpose, /RFC 6962 inclusion and consistency proofs/);
    assert.equal(connector.safety_notes.some((item) => item.includes("cannot fetch a checkpoint")), true);
  }
});
