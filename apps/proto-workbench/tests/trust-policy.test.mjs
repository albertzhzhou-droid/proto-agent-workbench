import assert from "node:assert/strict";
import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildTrustPolicy,
  exportTrustPolicy,
  parseTrustPolicy,
  serializeTrustPolicy,
} from "../src/main/services/trust-policy.ts";
import { scanTrustPolicies } from "../src/main/services/trust-policy-catalog.ts";

function options(authorities = [
  {
    kind: "keyless",
    name: "Release workflow",
    issuer: "https://token.actions.githubusercontent.com",
    subject: "https://github.com/example/proto-workbench/.github/workflows/release.yml@refs/heads/main",
  },
  {
    kind: "public-key",
    name: "Offline release key",
    publicKeySha256: "b".repeat(64),
  },
]) {
  return {
    name: "Proto Workbench release policy",
    description: "Require one exact release authority after cryptographic verification succeeds.",
    authorities,
    moduleManifestSha256: "a".repeat(64),
  };
}

test("Trust Policy is content-addressed, exact-match only, and stable across authority input order", () => {
  const first = buildTrustPolicy(options());
  const second = buildTrustPolicy(options([...options().authorities].reverse()));

  assert.equal(first.policyDigest, second.policyDigest);
  assert.equal(first.policyId, `tp_${first.policyDigest.slice(0, 24)}`);
  assert.equal(first.verification.authorityMode, "any-of");
  assert.equal(first.verification.allowNetworkFetch, false);
  assert.equal(first.verification.requireSignedTimeEvidence, true);
  assert.equal(first.authentication.status, "policy-only");
  assert.match(first.boundary, /cannot sign|cannot.*trust an identity/i);
  assert.doesNotMatch(JSON.stringify(first), /RegExp|privateKey|secret/i);
});

test("Trust Policy rejects unsafe issuer URLs, duplicate authorities, and malformed key digests", () => {
  assert.throws(() => buildTrustPolicy(options([{
    kind: "keyless",
    name: "Unsafe issuer",
    issuer: "http://issuer.example.test",
    subject: "release@example.test",
  }])), /HTTPS URL/i);
  assert.throws(() => buildTrustPolicy(options([
    { kind: "public-key", name: "First", publicKeySha256: "c".repeat(64) },
    { kind: "public-key", name: "Second", publicKeySha256: "c".repeat(64) },
  ])), /constraints must be unique/i);
  assert.throws(() => buildTrustPolicy(options([{
    kind: "public-key",
    name: "Bad key",
    publicKeySha256: "not-a-digest",
  }])), /public key digest/i);
});

test("Trust Policy parser requires canonical JSON and rejects payload tampering", () => {
  const policy = buildTrustPolicy(options());
  const serialized = serializeTrustPolicy(policy);
  assert.deepEqual(parseTrustPolicy(serialized), policy);
  assert.throws(() => parseTrustPolicy(JSON.stringify(policy)), /canonical/i);

  const changed = JSON.parse(serialized);
  changed.name = "Changed policy";
  assert.throws(() => parseTrustPolicy(`${JSON.stringify(changed, null, 2)}\n`), /content digest/i);
});

test("Trust Policy export is immutable and reuses exact content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-trust-policy-export-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = buildTrustPolicy(options());

  const first = await exportTrustPolicy(root, policy);
  const second = await exportTrustPolicy(root, policy);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.policySha256, second.policySha256);
  assert.match(first.relativePath, /^build\/trust-policies\/tp_[a-f0-9]{24}\/trust-policy\.json$/);

  await writeFile(join(root, first.relativePath), "changed", "utf8");
  await assert.rejects(() => exportTrustPolicy(root, policy), /does not match the requested content/i);
});

test("Trust Policy catalog separates valid, tampered, and invalid artifacts", async (context) => {
  const validRoot = await mkdtemp(join(tmpdir(), "proto-trust-policy-valid-"));
  context.after(() => rm(validRoot, { recursive: true, force: true }));
  const validReceipt = await exportTrustPolicy(validRoot, buildTrustPolicy(options()));
  const valid = await scanTrustPolicies(validRoot, "2026-08-31T23:30:00.000Z");
  assert.equal(valid.summary.valid, 1);
  assert.equal(valid.entries[0].state, "valid");
  assert.equal(valid.entries[0].authorities.length, 2);
  assert.equal(valid.entries[0].policySha256, validReceipt.policySha256);

  const tamperedRoot = await mkdtemp(join(tmpdir(), "proto-trust-policy-tampered-"));
  context.after(() => rm(tamperedRoot, { recursive: true, force: true }));
  const tamperedReceipt = await exportTrustPolicy(tamperedRoot, buildTrustPolicy(options()));
  const tamperedPath = join(tamperedRoot, tamperedReceipt.relativePath);
  const parsed = JSON.parse(await readFile(tamperedPath, "utf8"));
  parsed.name = "Altered policy";
  await writeFile(tamperedPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  const tampered = await scanTrustPolicies(tamperedRoot);
  assert.equal(tampered.entries[0].state, "tampered");
  assert.ok(tampered.entries[0].diagnostics.some((item) => item.code === "CHECKSUM_MISMATCH"));

  const invalidRoot = await mkdtemp(join(tmpdir(), "proto-trust-policy-invalid-"));
  context.after(() => rm(invalidRoot, { recursive: true, force: true }));
  const invalidReceipt = await exportTrustPolicy(invalidRoot, buildTrustPolicy(options()));
  await writeFile(join(dirname(join(invalidRoot, invalidReceipt.relativePath)), "unexpected.txt"), "x", "utf8");
  const invalid = await scanTrustPolicies(invalidRoot);
  assert.equal(invalid.entries[0].state, "invalid");
  assert.ok(invalid.entries[0].diagnostics.some((item) => item.code === "UNEXPECTED_ENTRIES"));
});

test("Trust Policy scanner is read-only and rejects hardlinked policy bytes", async (context) => {
  const emptyRoot = await mkdtemp(join(tmpdir(), "proto-trust-policy-empty-"));
  context.after(() => rm(emptyRoot, { recursive: true, force: true }));
  const empty = await scanTrustPolicies(emptyRoot);
  assert.equal(empty.returnedCount, 0);
  assert.deepEqual(await readdir(emptyRoot), []);

  const linkedRoot = await mkdtemp(join(tmpdir(), "proto-trust-policy-linked-"));
  context.after(() => rm(linkedRoot, { recursive: true, force: true }));
  const receipt = await exportTrustPolicy(linkedRoot, buildTrustPolicy(options()));
  await link(join(linkedRoot, receipt.relativePath), join(linkedRoot, "policy-copy.json"));
  const linked = await scanTrustPolicies(linkedRoot);
  assert.equal(linked.entries[0].state, "invalid");
  assert.ok(linked.entries[0].diagnostics.some((item) => item.code === "POLICY_FILE_INVALID"));
});
