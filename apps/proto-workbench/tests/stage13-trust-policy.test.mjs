import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Stage 13 exposes typed content-addressed Trust Policy artifacts and catalogs", async () => {
  const contracts = await source("src/shared/contracts.ts");
  const ipc = await source("src/shared/ipc.ts");

  assert.match(contracts, /schema: "proto-workbench\.trust-policy\.v1"/);
  assert.match(contracts, /authorityMode: "any-of"/);
  assert.match(contracts, /requireSignedTimeEvidence: true/);
  assert.match(contracts, /allowNetworkFetch: false/);
  assert.match(contracts, /authentication:[\s\S]*status: "policy-only"/);
  assert.match(contracts, /previewTrustPolicy\(input: TrustPolicyRequest\)/);
  assert.match(contracts, /exportTrustPolicy\(input: TrustPolicyExportRequest\)/);
  assert.match(contracts, /listTrustPolicies\(\): Promise<TrustPolicyCatalog>/);
  assert.match(ipc, /harnessTrustPolicyPreview: "harness:trust-policy-preview"/);
  assert.match(ipc, /harnessTrustPolicyExport: "harness:trust-policy-export"/);
});

test("Stage 13 Trust Policy service is exact-match, immutable, and non-authorizing", async () => {
  const policy = await source("src/main/services/trust-policy.ts");

  assert.match(policy, /maxAuthorities: 8/);
  assert.match(policy, /certificateIssuer/);
  assert.match(policy, /certificateIdentity/);
  assert.match(policy, /publicKeySha256/);
  assert.match(policy, /fsConstants\.O_EXCL/);
  assert.match(policy, /nlink !== 1/);
  assert.match(policy, /expected content|does not match the requested content/i);
  assert.match(policy, /cannot sign a bundle, create a key, trust an identity, authorize an effect/);
  assert.doesNotMatch(policy, /issuerRegExp|subjectRegExp|privateKey|secretKey|spawn\(|execFile|fetch\(/);
});

test("Stage 13 Trust Policy catalog is bounded, handle-stable, and read-only", async () => {
  const catalog = await source("src/main/services/trust-policy-catalog.ts");

  assert.match(catalog, /maxDirectories: 32/);
  assert.match(catalog, /maxDirectoryEntries: 128/);
  assert.match(catalog, /opendir\(policyRoot\)/);
  assert.match(catalog, /opened\.dev !== before\.dev|opened\.ino !== before\.ino/);
  assert.match(catalog, /sameEntries\(names, EXPECTED_ENTRIES\)/);
  assert.match(catalog, /parseTrustPolicy\(policyFile\.text\)/);
  assert.doesNotMatch(catalog, /writeFile|mkdir|unlink|rename|rm\(|O_WRONLY|O_CREAT|O_EXCL/);
  assert.doesNotMatch(catalog, /fetch\(|spawn\(|execFile|mcpClient|agentService|resolveApproval|applyApprovedPatch/);
});

test("Stage 13 main process owns policy preview, digest-CAS export, and strict IPC schemas", async () => {
  const main = await source("src/main/index.ts");
  const preload = await source("src/preload/index.ts");
  const ipcSecurity = await source("src/main/ipc-security.ts");

  assert.match(main, /handlePrivileged\(IPC\.harnessTrustPolicyPreview/);
  assert.match(main, /handlePrivileged\(IPC\.harnessTrustPolicyExport/);
  assert.match(main, /policy\.policyDigest !== input\.expectedPolicyDigest/);
  assert.match(main, /handlePrivileged\(IPC\.harnessTrustPolicyList, \(\) => scanTrustPolicies\(activeWorkspacePath\)\)/);
  assert.match(preload, /boundedTrustAuthorities/);
  assert.match(preload, /expectedPolicyDigest: sha256Digest/);
  assert.match(ipcSecurity, /TRUST_POLICY_REQUEST/);
  assert.match(ipcSecurity, /z\.discriminatedUnion\("kind"/);
  assert.match(ipcSecurity, /\[IPC\.harnessTrustPolicyList\]: noArguments/);
});

test("Stage 13 UI keeps policy, evidence, activation, and identity conclusions separate", async () => {
  const center = await source("src/renderer/TrustPolicyCenter.tsx");
  const verification = await source("src/renderer/DecisionBundleVerificationCenter.tsx");

  assert.match(center, /Trust Policy Center/);
  assert.match(center, /Define exact identities after cryptographic verification/);
  assert.match(center, /No trust activated/);
  assert.match(center, /A policy is not proof of identity/);
  assert.match(center, /Signature bundle/);
  assert.match(center, /Trusted root & time/);
  assert.match(center, /Preview policy/);
  assert.match(center, /Export immutable policy/);
  assert.match(center, /Reveal policy/);
  assert.match(verification, /Trust policies/);
  assert.doesNotMatch(center, /threads\.send|approvals\.resolve|files\.applyApprovedPatch|models\.load|harness\.exportDecisionBundle/);
});
