import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("mission launch is bound to a main-process-issued digest and rechecked before send", async () => {
  const contracts = await source("src/shared/contracts.ts");
  const ipc = await source("src/main/ipc-security.ts");
  const main = await source("src/main/index.ts");
  const preload = await source("src/preload/index.ts");
  const agent = await source("src/main/services/agent-service.ts");

  assert.match(contracts, /export interface MissionPreflight[\s\S]*?digest: string;[\s\S]*?requirements: MissionRequirement\[\]/);
  assert.match(contracts, /send\(threadId: string, content: string, expectedPreflightDigest: string/);
  assert.match(ipc, /\[IPC\.harnessPreflight\]/);
  assert.match(ipc, /\[IPC\.threadsSend\]: z\.tuple\(\[ID, z\.string\(\)\.min\(1\)\.max\(131_072\), SHA256/);
  assert.match(preload, /harness:[\s\S]*?preflight:[\s\S]*?IPC\.harnessPreflight/);
  assert.match(preload, /sha256Digest\(expectedPreflightDigest, "expectedPreflightDigest"\)/);
  assert.match(main, /const preflight = await issueMissionPreflight\(threadId, content, selected\.attachments\)/);
  assert.match(main, /preflight\.digest !== expectedPreflightDigest/);
  assert.match(main, /if \(!preflight\.launchable\)/);
  assert.match(agent, /missionPreflight: preflight \? \{[\s\S]*?digest: preflight\.digest/);
});

test("renderer preflight is a two-step review and mutations invalidate the cached report", async () => {
  const store = await source("src/renderer/store.ts");
  const app = await source("src/renderer/App.tsx");

  assert.match(store, /const report = await workbenchApi\(\)\.harness\.preflight/);
  assert.match(store, /workbenchApi\(\)\.threads\.send\(thread\.id, user\.content, missionPreflight\.digest, attachments\)/);
  assert.match(store, /setPrompt\(prompt\)[\s\S]*?missionPreflight: undefined/);
  assert.match(store, /setMode\(mode\)[\s\S]*?missionPreflight: undefined/);
  assert.match(store, /attachmentIdentity\(current\.attachments\) !== reviewedAttachments/);
  assert.match(app, /Main-process preflight/);
  assert.match(app, /missionPreflight \? "Start mission" : "Review mission"/);
  assert.match(app, /Launch confirmation never approves later effects/);
});

test("command palette only navigates or prepares drafts", async () => {
  const app = await source("src/renderer/App.tsx");
  const palette = section(app, "function CommandPalette", "function Sidebar");
  const launchpad = await source("src/renderer/OperationalPages.tsx");
  const cockpit = await source("src/main/services/operator-cockpit.ts");

  assert.match(palette, /beginNewRun\("plan"\)/);
  assert.match(palette, /beginNewRun\("act"\)/);
  assert.match(palette, /setPrompt\(/);
  assert.match(palette, /navigate\("runs"\)/);
  assert.doesNotMatch(palette, /\.send\(|threads\.send|approvals\.resolve|files\.applyApprovedPatch/);
  assert.match(palette, /Commands never send a prompt, call a tool, or approve a side effect/);
  assert.match(launchpad, /Mission library/);
  assert.match(launchpad, /Prepare draft/);
  assert.doesNotMatch(launchpad, /className="mission-starter-grid"/);
  assert.match(cockpit, /Evidence gap map/);
  assert.match(cockpit, /Controlled change/);
  assert.match(cockpit, /Recovery review/);
});

async function source(path) {
  return readFile(resolve(...path.split("/")), "utf8");
}

function section(value, startMarker, endMarker) {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing marker: ${endMarker}`);
  return value.slice(start, end);
}
