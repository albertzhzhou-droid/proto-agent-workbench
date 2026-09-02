import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Stage 11 exposes a typed, unsigned, content-addressed Decision Bundle", async () => {
  const contracts = await source("src/shared/contracts.ts");
  const ipc = await source("src/shared/ipc.ts");

  assert.match(contracts, /schema: "proto-workbench\.decision-bundle\.v1"/);
  assert.match(contracts, /_type: "https:\/\/in-toto\.io\/Statement\/v1"/);
  assert.match(contracts, /status: "unsigned"/);
  assert.match(contracts, /assurance: "content-digest-only"/);
  assert.match(contracts, /previewDecisionBundle\(input: DecisionBundleRequest\)/);
  assert.match(contracts, /exportDecisionBundle\(input: DecisionBundleExportRequest\)/);
  assert.match(ipc, /harnessDecisionBundlePreview: "harness:decision-bundle-preview"/);
  assert.match(ipc, /harnessDecisionBundleExport: "harness:decision-bundle-export"/);
});

test("Stage 11 main process reissues trusted simulation and CAS-checks both digests", async () => {
  const main = await source("src/main/index.ts");
  const preload = await source("src/preload/index.ts");
  const ipcSecurity = await source("src/main/ipc-security.ts");

  assert.match(main, /handlePrivileged\(IPC\.harnessDecisionBundlePreview/);
  assert.match(main, /handlePrivileged\(IPC\.harnessDecisionBundleExport/);
  assert.match(main, /validateSelectedAttachments\(/);
  assert.match(main, /report\.digest !== input\.expectedSimulationDigest/);
  assert.match(main, /bundle\.bundleDigest !== input\.expectedBundleDigest/);
  assert.match(main, /manifestSha256/);
  assert.match(preload, /sha256Digest\(input\.expectedSimulationDigest/);
  assert.match(preload, /sha256Digest\(input\.expectedBundleDigest/);
  assert.match(ipcSecurity, /DECISION_BUNDLE_REDACTION/);
});

test("Stage 11 export service is immutable, workspace-bounded, and non-authorizing", async () => {
  const service = await source("src/main/services/decision-bundle.ts");

  assert.match(service, /build\/decision-bundles|"decision-bundles"/);
  assert.match(service, /O_EXCL/);
  assert.match(service, /single-link regular file/);
  assert.match(service, /publisher identity is not established/);
  assert.match(service, /cannot start a model, call a tool, resolve an approval, replay a decision/);
  assert.doesNotMatch(service, /mcpClient\.call|agentService\.|resolveApproval|applyApprovedPatch|fetch\(/);
});

test("Stage 11 UI previews redaction before one explicit audit export", async () => {
  const component = await source("src/renderer/DecisionLab.tsx");

  assert.match(component, /Decision Bundle/);
  assert.match(component, /Metadata only/);
  assert.match(component, /Include goal preview/);
  assert.match(component, /No file is created during preview/);
  assert.match(component, /Export audit artifact/);
  assert.match(component, /build\/decision-bundles/);
  assert.doesNotMatch(component, /threads\.send|approvals\.resolve|files\.applyApprovedPatch|models\.load/);
});
