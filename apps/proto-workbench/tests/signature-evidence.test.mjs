import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bundleToJSON, toMessageSignatureBundle } from "@sigstore/bundle";
import { buildDecisionBundle, serializeDecisionBundle } from "../src/main/services/decision-bundle.ts";
import { buildPolicySimulation } from "../src/main/services/policy-simulation.ts";
import {
  importSignatureEvidence,
  scanSignatureEvidence,
  SIGNATURE_EVIDENCE_BOUNDARY,
} from "../src/main/services/signature-evidence.ts";
import {
  loadPinnedTrustedRoot,
  SIGSTORE_PUBLIC_GOOD_ROOT_SHA256,
  verifyOfflineSigstore,
} from "../src/main/services/sigstore-offline.ts";
import { buildTrustPolicy, serializeTrustPolicy } from "../src/main/services/trust-policy.ts";

const TRUST_ROOT = join(process.cwd(), "runtime", "trust", "sigstore-public-good", "trusted_root.json");
const OFFICIAL_FIXTURE = join(process.cwd(), "tests", "fixtures", "sigstore");

test("pinned Sigstore root is independently digest-bound and loads without TUF or network", async () => {
  const root = await loadPinnedTrustedRoot(TRUST_ROOT);
  assert.equal(root.sha256, SIGSTORE_PUBLIC_GOOD_ROOT_SHA256);
  assert.ok(root.root.tlogs.length >= 1);
  assert.ok(root.root.ctlogs.length >= 1);
  assert.ok(root.root.certificateAuthorities.length >= 1);
});

test("official sigstore-js v0.3 fixture verifies fully offline with exact keyless identity", async () => {
  // apply_patch preserves a final LF in the fixture file; the upstream DSSE
  // payload is the same JSON without that final byte.
  const artifact = Buffer.from((await readFile(join(OFFICIAL_FIXTURE, "statement.json"), "utf8")).replace(/\n$/u, ""), "utf8");
  const serializedBundle = await readFile(join(OFFICIAL_FIXTURE, "bundleV03-intoto.sigstore"), "utf8");
  const policy = buildTrustPolicy({
    name: "sigstore-js upstream fixture",
    description: "Exact upstream identity used to prove the offline verifier against a real public-good bundle.",
    authorities: [{ kind: "keyless", name: "Upstream fixture signer", issuer: "https://github.com/login/oauth", subject: "brian@dehamer.com" }],
  });
  const result = verifyOfflineSigstore({ artifact, serializedBundle, policy, trustedRoot: await loadPinnedTrustedRoot(TRUST_ROOT) });

  assert.equal(result.state, "verified");
  assert.equal(result.artifactBinding, "passed");
  assert.equal(result.cryptographicSignature, "passed");
  assert.equal(result.trustedTime, "verified");
  assert.equal(result.trustRoot, "passed");
  assert.equal(result.authorityIdentity, "passed");
  assert.equal(result.identity.certificateIssuer, "https://github.com/login/oauth");
  assert.equal(result.identity.certificateIdentity, "brian@dehamer.com");
});

test("public-key signature remains incomplete without trusted time and rejects artifact tampering", async () => {
  const artifact = Buffer.from("offline public-key fixture\n", "utf8");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeySha256 = sha256(publicKey.export({ type: "spki", format: "der" }));
  const bundle = toMessageSignatureBundle({
    digest: createHash("sha256").update(artifact).digest(),
    signature: sign("sha256", artifact, privateKey),
    keyHint: "fixture-public-key",
  });
  const serializedBundle = `${JSON.stringify(bundleToJSON(bundle), null, 2)}\n`;
  const policy = buildTrustPolicy({
    name: "Offline public key",
    description: "Exact DER SubjectPublicKeyInfo digest with policy-required signed time.",
    authorities: [{ kind: "public-key", name: "Fixture key", publicKeySha256 }],
  });
  const trustedRoot = await loadPinnedTrustedRoot(TRUST_ROOT);

  const result = verifyOfflineSigstore({ artifact, serializedBundle, policy, trustedRoot, publicKeyPem });
  assert.equal(result.state, "incomplete");
  assert.equal(result.cryptographicSignature, "passed");
  assert.equal(result.authorityIdentity, "passed");
  assert.equal(result.trustedTime, "missing");
  assert.ok(result.diagnostics.some((item) => item.code === "SIGNED_TIME_MISSING"));

  const tampered = verifyOfflineSigstore({ artifact: Buffer.from("tampered"), serializedBundle, policy, trustedRoot, publicKeyPem });
  assert.equal(tampered.state, "rejected");
  assert.equal(tampered.artifactBinding, "failed");
  assert.equal(tampered.cryptographicSignature, "failed");
});

test("user-selected evidence pack imports immutably and scans as incomplete rather than verified", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "proto-signature-workspace-"));
  const source = await mkdtemp(join(tmpdir(), "proto-signature-source-"));
  context.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(source, { recursive: true, force: true })]));
  const fixture = publicKeyEvidenceFixture();
  await writeEvidenceSource(source, fixture);

  const receipt = await importSignatureEvidence(workspace, source, TRUST_ROOT, "2026-08-31T23:55:00.000Z");
  assert.match(receipt.evidenceId, /^se_[a-f0-9]{24}$/);
  assert.equal(receipt.reused, false);
  assert.deepEqual((await readdir(join(workspace, receipt.relativePath))).sort(), ["SHA256SUMS.txt", "decision-bundle.json", "public-key.pem", "signature.sigstore.json", "trust-policy.json"]);

  const second = await importSignatureEvidence(workspace, source, TRUST_ROOT, "2026-08-31T23:56:00.000Z");
  assert.equal(second.evidenceId, receipt.evidenceId);
  assert.equal(second.reused, true);
  const catalog = await scanSignatureEvidence(workspace, TRUST_ROOT, "2026-08-31T23:57:00.000Z");
  assert.equal(catalog.summary.incomplete, 1);
  assert.equal(catalog.summary.verified, 0);
  assert.equal(catalog.entries[0].state, "incomplete");
  assert.equal(catalog.entries[0].checks.find((item) => item.id === "trusted-time").state, "missing");
  assert.equal(catalog.trustRootSnapshot.sha256, SIGSTORE_PUBLIC_GOOD_ROOT_SHA256);
  assert.match(catalog.boundary, /never signs|never.*fetches/i);
});

test("scanner is read-only and checksum tampering fails closed", async (context) => {
  const empty = await mkdtemp(join(tmpdir(), "proto-signature-empty-"));
  const workspace = await mkdtemp(join(tmpdir(), "proto-signature-tampered-"));
  const source = await mkdtemp(join(tmpdir(), "proto-signature-tampered-source-"));
  context.after(() => Promise.all([empty, workspace, source].map((path) => rm(path, { recursive: true, force: true }))));
  const catalog = await scanSignatureEvidence(empty, TRUST_ROOT);
  assert.equal(catalog.returnedCount, 0);
  assert.deepEqual(await readdir(empty), []);

  await writeEvidenceSource(source, publicKeyEvidenceFixture());
  const receipt = await importSignatureEvidence(workspace, source, TRUST_ROOT);
  await writeFile(join(workspace, receipt.relativePath, "decision-bundle.json"), "changed", "utf8");
  const tampered = await scanSignatureEvidence(workspace, TRUST_ROOT);
  assert.equal(tampered.entries[0].state, "invalid");
  assert.match(tampered.entries[0].diagnostics[0].detail, /checksum|canonical|match/i);
  assert.match(SIGNATURE_EVIDENCE_BOUNDARY, /read-only/i);
});

function publicKeyEvidenceFixture() {
  const decisionBundle = buildDecisionBundle(simulation(), {
    selectedScenarioId: "current",
    redaction: "metadata-only",
    attachmentCount: 0,
    producerVersion: "1.0.0-test",
    moduleManifestSha256: "a".repeat(64),
  });
  const artifact = Buffer.from(serializeDecisionBundle(decisionBundle), "utf8");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeySha256 = sha256(publicKey.export({ type: "spki", format: "der" }));
  const policy = buildTrustPolicy({
    name: "Fixture offline release key",
    description: "A cryptographically valid public-key signature that intentionally has no signed time.",
    authorities: [{ kind: "public-key", name: "Fixture key", publicKeySha256 }],
    moduleManifestSha256: "a".repeat(64),
  });
  const signatureBundle = `${JSON.stringify(bundleToJSON(toMessageSignatureBundle({
    digest: createHash("sha256").update(artifact).digest(),
    signature: sign("sha256", artifact, privateKey),
    keyHint: "fixture-public-key",
  })), null, 2)}\n`;
  return {
    "decision-bundle.json": artifact,
    "public-key.pem": Buffer.from(publicKeyPem, "utf8"),
    "signature.sigstore.json": Buffer.from(signatureBundle, "utf8"),
    "trust-policy.json": Buffer.from(serializeTrustPolicy(policy), "utf8"),
  };
}

async function writeEvidenceSource(directory, fixture) {
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(fixture)) await writeFile(join(directory, name), bytes);
  const sums = `${Object.keys(fixture).sort().map((name) => `${sha256(fixture[name])}  ${name}`).join("\n")}\n`;
  await writeFile(join(directory, "SHA256SUMS.txt"), sums, "utf8");
}

function simulation() {
  return buildPolicySimulation({
    thread: { id: "thread-signature", workspacePath: "C:\\workspace", title: "Signature evidence", mode: "plan", createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" },
    content: "Review a local evidence bundle without effects.", attachments: [],
    runtime: { available: true, backend: "cuda", detail: "Ready" },
    moduleIntegrity: { ok: true, enforced: true, manifestPath: "module-manifest.json", manifestSha256: "a".repeat(64), checkedAt: "2026-08-31T00:00:00.000Z", modules: [] },
    visionModuleEnabled: false,
    workspaceUri: "file:///C:/workspace",
    capabilities: { workspace: "file:///C:/workspace", execution: { mode: "disabled", available: false, configured: false, provider_visible: false, smoke_verified: false, image_digest_pinned: false, reason: "Disabled" }, networkPaths: [], networkEnabled: false, networkAuthorization: "per-call-hmac-capability", filesystemSafety: { relativePathsOnly: true, reparsePointsAllowed: false, atomicReplace: true, windowsResidualSameUserRenameRace: true } },
    toolNames: [],
  }, ["current"]);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
