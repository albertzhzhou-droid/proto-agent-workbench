import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const source = (path) => readFile(resolve(root, path), "utf8");

test("main process owns a bounded, redacted Global Evidence projection", async () => {
  const [main, service, ipc, preload, security] = await Promise.all([
    source("src/main/index.ts"),
    source("src/main/services/global-evidence.ts"),
    source("src/shared/ipc.ts"),
    source("src/preload/index.ts"),
    source("src/main/ipc-security.ts"),
  ]);
  assert.match(ipc, /runsSearchEvidence: "runs:search-evidence"/);
  assert.match(preload, /searchEvidence: \(input: GlobalEvidenceSearchRequest\) => invoke\(IPC\.runsSearchEvidence/);
  assert.match(security, /\[IPC\.runsSearchEvidence\]: z\.tuple/);
  assert.match(main, /handlePrivileged\(IPC\.runsSearchEvidence/);
  assert.match(main, /filter\(\(run\) => agentService\.canAccessRun\(run\.runId\)\)/);
  assert.match(main, /slice\(0, GLOBAL_EVIDENCE_LIMITS\.runScan\)/);
  assert.match(main, /buildGlobalEvidenceSearch\(details, input\)/);
  assert.match(service, /eventsPerRun: 250/);
  assert.match(service, /arguments redacted from the global index/);
  assert.doesNotMatch(service, /approval\.arguments[),\]}]/);
  assert.doesNotMatch(service, /messages\.map\(.*content/);
  assert.doesNotMatch(service, /approvePatch\(|applyApprovedPatch\(|resumePatchValidation\(|threads\.send/);
});

test("Global Evidence UI provides search, facets, keyboard containment, and navigation-only targets", async () => {
  const [app, component, store, evidenceViews, styles, mock] = await Promise.all([
    source("src/renderer/App.tsx"),
    source("src/renderer/GlobalEvidenceSearch.tsx"),
    source("src/renderer/store.ts"),
    source("src/renderer/RunEvidenceViews.tsx"),
    source("src/renderer/styles.css"),
    source("src/renderer/mock-api.ts"),
  ]);
  assert.match(app, /global-evidence-trigger/);
  assert.match(app, /event\.shiftKey && event\.key\.toLocaleLowerCase\(\) === "f"/);
  assert.match(component, /Search global evidence/);
  assert.match(component, /All search words must match · exact IDs rank first/);
  assert.match(component, /arguments stay redacted/);
  assert.match(component, /event\.key === "ArrowDown"/);
  assert.match(component, /event\.key !== "Tab"/);
  assert.match(component, /workbenchApi\(\)\.runs\.searchEvidence/);
  assert.match(store, /async openGlobalEvidenceHit\(hit\)/);
  assert.match(store, /No effect was executed/);
  assert.match(store, /evidenceTab: hit\.target\.evidenceTab \?\? "timeline"/);
  assert.match(evidenceViews, /state\.evidenceTab/);
  assert.match(styles, /\.global-evidence-dialog\s*\{/);
  assert.match(styles, /\.global-evidence-result\.is-active/);
  assert.match(mock, /function previewGlobalEvidenceSearch/);
  assert.doesNotMatch(component, /applyApprovedPatch|resolveToolApproval|threads\.send/);
});
