import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Stage 12 exposes a typed read-only Decision Bundle verification catalog", async () => {
  const contracts = await source("src/shared/contracts.ts");
  const ipc = await source("src/shared/ipc.ts");

  assert.match(contracts, /DecisionBundleVerificationState = "content-verified" \| "tampered" \| "invalid"/);
  assert.match(contracts, /schema: "proto-workbench\.decision-bundle-verification\.v1"/);
  assert.match(contracts, /identityAssurance: "not-verified"/);
  assert.match(contracts, /verifyDecisionBundles\(\): Promise<DecisionBundleVerificationCatalog>/);
  assert.match(ipc, /harnessDecisionBundleVerify: "harness:decision-bundle-verify"/);
});

test("Stage 12 scanner is bounded, canonical, handle-stable, and has no write capability", async () => {
  const scanner = await source("src/main/services/decision-bundle-verification.ts");
  const bundle = await source("src/main/services/decision-bundle.ts");

  assert.match(scanner, /maxDirectories: 64/);
  assert.match(scanner, /maxDirectoryEntries: 256/);
  assert.match(scanner, /opendir\(bundleRoot\)/);
  assert.match(scanner, /isSymbolicLink\(\)|nlink !== 1/);
  assert.match(scanner, /opened\.dev !== before\.dev|opened\.ino !== before\.ino/);
  assert.match(scanner, /sameEntries\(names, EXPECTED_ENTRIES\)/);
  assert.match(scanner, /CHECKSUM_MISMATCH/);
  assert.match(scanner, /parseDecisionBundle\(bundleFile\.text\)/);
  assert.match(bundle, /subject digest does not match its simulation binding/);
  assert.doesNotMatch(scanner, /writeFile|mkdir|unlink|rename|rm\(|O_WRONLY|O_CREAT|O_EXCL/);
  assert.doesNotMatch(scanner, /mcpClient|agentService|fetch\(|spawn\(|execFile|resolveApproval|applyApprovedPatch/);
});

test("Stage 12 main process owns the scan behind a strict no-argument IPC", async () => {
  const main = await source("src/main/index.ts");
  const preload = await source("src/preload/index.ts");
  const ipcSecurity = await source("src/main/ipc-security.ts");

  assert.match(main, /handlePrivileged\(IPC\.harnessDecisionBundleVerify, \(\) => scanDecisionBundles\(activeWorkspacePath\)\)/);
  assert.match(preload, /verifyDecisionBundles: \(\) => invoke\(IPC\.harnessDecisionBundleVerify\)/);
  assert.match(ipcSecurity, /\[IPC\.harnessDecisionBundleVerify\]: noArguments/);
});

test("Stage 12 UI separates content integrity from identity and exposes only read-only actions", async () => {
  const component = await source("src/renderer/DecisionBundleVerificationCenter.tsx");
  const app = await source("src/renderer/App.tsx");

  assert.match(component, /Verification Center/);
  assert.match(component, /Content intact/);
  assert.match(component, /Tampering detected/);
  assert.match(component, /Bundle rejected/);
  assert.match(component, /Content integrity is not publisher identity/);
  assert.match(component, /No DSSE signature, Sigstore verification material/);
  assert.match(component, /Refresh snapshot/);
  assert.match(component, /Reveal artifact/);
  assert.match(app, /verification-center-trigger/);
  assert.match(app, /Ctrl\+Shift\+V/);
  assert.doesNotMatch(component, /threads\.send|approvals\.resolve|files\.applyApprovedPatch|models\.load|harness\.exportDecisionBundle/);
});
