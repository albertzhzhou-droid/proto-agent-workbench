import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const source = (path) => readFile(resolve(root, path), "utf8");

test("main process captures Mission Recipes and CAS-rechecks Resume Contracts", async () => {
  const [main, checkpoints, service] = await Promise.all([
    source("src/main/index.ts"),
    source("src/main/services/run-checkpoints.ts"),
    source("src/main/services/resume-contract.ts"),
  ]);
  assert.match(main, /buildMissionRecipe\(\{/);
  assert.match(main, /database\.createRunCheckpoint\(\{ runId, missionRecipe, createdAt \}\)/);
  assert.match(main, /IPC\.runsPreviewResume/);
  assert.match(main, /const resumeContract = await issueResumeContract\(checkpoint\.id\)/);
  assert.match(main, /resumeContract\.digest !== input\.expectedResumeContractDigest/);
  assert.match(main, /if \(!resumeContract\.launchable\)/);
  assert.match(checkpoints, /missionRecipe: input\.missionRecipe/);
  assert.match(checkpoints, /expectedResumeContractDigest/);
  assert.match(checkpoints, /resumeContractDigest: input\.expectedResumeContractDigest/);
  assert.match(service, /currentCapabilityDigest: currentCapabilities\.digest/);
  assert.match(service, /checkpointSnapshotDigest: checkpoint\.snapshotDigest/);
  assert.doesNotMatch(service, /issuedAt[\s\S]{0,300}digestPayload/);
});

test("renderer requires a visible resume review before creating a child task", async () => {
  const [store, views, preload] = await Promise.all([
    source("src/renderer/store.ts"),
    source("src/renderer/RunEvidenceViews.tsx"),
    source("src/preload/index.ts"),
  ]);
  const reviewStart = store.indexOf("async reviewTaskResume(checkpointId)");
  const forkStart = store.indexOf("async forkTaskCheckpoint(checkpointId");
  assert.notEqual(reviewStart, -1);
  assert.notEqual(forkStart, -1);
  const review = store.slice(reviewStart, forkStart);
  assert.match(review, /workbenchApi\(\)\.runs\.previewResume\(checkpointId\)/);
  assert.doesNotMatch(review, /threads\.send|files\.|models\.(?:load|unload)/);
  assert.match(store.slice(forkStart), /expectedResumeContractDigest/);
  assert.match(views, /role="dialog" aria-modal="true"/);
  assert.match(views, /Capability drift needs review/);
  assert.match(views, /resumeContract\.drift\.map/);
  assert.match(views, /Creating a child task does not start the model, restore files, or approve later effects\./);
  assert.match(preload, /expectedResumeContractDigest: sha256Digest/);
});

test("resume UI exposes the full trust surface and keyboard containment", async () => {
  const [app, views, styles, mock] = await Promise.all([
    source("src/renderer/App.tsx"),
    source("src/renderer/RunEvidenceViews.tsx"),
    source("src/renderer/styles.css"),
    source("src/renderer/mock-api.ts"),
  ]);
  for (const label of [
    "Workspace identity",
    "Module integrity",
    "Model identity",
    "Inference runtime",
    "Tool surface",
    "Network authorization",
    "Filesystem safety",
    "Execution boundary",
  ]) assert.match(mock, new RegExp(label));
  assert.match(views, /event\.key === "Escape"/);
  assert.match(views, /event\.key !== "Tab"/);
  assert.match(views, /ref=\{resumeTriggerRef\}/);
  assert.match(views, /resumeTriggerRef\.current\?\.focus\(\)/);
  assert.match(views, /querySelectorAll<HTMLElement>\("button:not\(\[disabled\]\), input:not\(\[disabled\]\)"\)/);
  assert.match(app, /setCommandOpen\(\(open\) => \{\s*if \(open\) window\.requestAnimationFrame/);
  assert.match(styles, /\.resume-contract\s*\{/);
  assert.match(styles, /\.resume-drift-list\s*\{/);
  assert.match(styles, /\.resume-state-icon\.is-blocked/);
});
