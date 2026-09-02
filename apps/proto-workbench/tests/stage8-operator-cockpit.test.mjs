import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const source = (path) => readFile(resolve(root, path), "utf8");

test("main process owns the bounded Operator Cockpit projection", async () => {
  const [main, service, ipc, preload, security] = await Promise.all([
    source("src/main/index.ts"),
    source("src/main/services/operator-cockpit.ts"),
    source("src/shared/ipc.ts"),
    source("src/preload/index.ts"),
    source("src/main/ipc-security.ts"),
  ]);
  assert.match(ipc, /runsCockpit: "runs:cockpit"/);
  assert.match(security, /\[IPC\.runsCockpit\]: noArguments/);
  assert.match(preload, /cockpit: \(\) => invoke\(IPC\.runsCockpit\)/);
  assert.match(main, /handlePrivileged\(IPC\.runsCockpit/);
  assert.match(main, /filter\(\(run\) => agentService\.canAccessRun\(run\.runId\)\)/);
  assert.match(main, /slice\(0, OPERATOR_COCKPIT_LIMITS\.runScan\)/);
  assert.match(main, /buildOperatorCockpit\(details\)/);
  assert.match(service, /snapshotRevision: detail\.revision/);
  assert.match(service, /attentionItems: 24/);
  assert.doesNotMatch(service, /approvePatch\(|applyApprovedPatch\(|resumePatchValidation\(/);
});

test("Launchpad consumes the trusted projection and mission recipes prepare drafts only", async () => {
  const [store, page, mock, styles] = await Promise.all([
    source("src/renderer/store.ts"),
    source("src/renderer/OperationalPages.tsx"),
    source("src/renderer/mock-api.ts"),
    source("src/renderer/styles.css"),
  ]);
  assert.match(store, /api\.runs\.cockpit\(\)/);
  assert.match(store, /refreshOperatorCockpit/);
  assert.match(page, /Operator cockpit/);
  assert.match(page, /Attention inbox/);
  assert.match(page, /Mission library/);
  assert.match(page, /await beginNewRun\(mission\.mode\);\s*setPrompt\(mission\.goal\);/);
  assert.match(page, /await selectRun\(item\.runId\)/);
  assert.match(page, /Mission recipes create an unsent draft and always require a fresh Mission Preflight/);
  assert.doesNotMatch(page, /startGuided/);
  assert.doesNotMatch(page, /threads\.send|applyApprovedPatch|resumePatchValidation\(item/);
  assert.match(mock, /function previewOperatorCockpit/);
  assert.match(mock, /Saved task recipe · fresh preflight required before launch/);
  assert.match(styles, /\.operator-cockpit\s*\{/);
  assert.match(styles, /\.attention-filters\s*\{/);
  assert.match(styles, /\.mission-library-list article\s*\{/);
});
