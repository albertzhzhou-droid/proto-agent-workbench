import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

test("every rendered button is wired to an interaction handler", async () => {
  const files = [
    resolve("src", "renderer", "App.tsx"),
    resolve("src", "renderer", "OperationalPages.tsx"),
    resolve("src", "renderer", "DesignsPage.tsx"),
  ];
  const unwired = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === "button") {
        const wired = node.attributes.properties.some(
          (attribute) => ts.isJsxAttribute(attribute) && /^on(?:Click|PointerDown|Change)$/.test(attribute.name.getText(ast)),
        );
        if (!wired) unwired.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  assert.deepEqual(unwired, [], `Unwired buttons: ${unwired.join(", ")}`);
});

test("tool-only agent turns retain a visible cancel action", async () => {
  const app = await readFile(resolve("src", "renderer", "App.tsx"), "utf8");
  const store = await readFile(resolve("src", "renderer", "store.ts"), "utf8");

  assert.match(app, /isAgentRunning\s*\?\s*cancel\(\)\s*:\s*send\(\)/);
  assert.match(app, /isAgentRunning\s*\?\s*"Cancel"\s*:\s*preflighting\s*\?\s*"Checking…"/);
  assert.match(app, /missionPreflight\s*\?\s*"Start mission"\s*:\s*"Review mission"/);
  assert.match(store, /event\.type === "message-start"[\s\S]{0,220}isAgentRunning: true/);
  assert.match(store, /event\.type === "message-complete"[\s\S]{0,520}isAgentRunning: false/);
  assert.match(app, /formatElapsed\(clock - agentStartedAt\)/);
  assert.match(app, /activeEvent\.title/);
});

test("the first-run gate preserves a failed draft and requires real readiness", async () => {
  const app = await readFile(resolve("src", "renderer", "App.tsx"), "utf8");
  const store = await readFile(resolve("src", "renderer", "store.ts"), "utf8");

  assert.match(app, /!prompt\.trim\(\) \|\| !readiness\.operational/);
  assert.match(app, /navigate\("launchpad"\)/);
  assert.match(store, /messages: state\.messages\.filter\(\(message\) => message\.id !== user\.id\)/);
  assert.match(store, /prompt: state\.prompt \|\| user\.content/);
  assert.match(store, /attachments: dedupeAttachments\(\[\.\.\.attachments, \.\.\.state\.attachments\]\)/);
  assert.match(store, /!thread \|\| !prompt\.trim\(\) \|\| isAgentRunning/);
  assert.match(app, /!isAgentRunning && !preflighting && readiness\.operational/);
});

test("run selection hydrates one durable RunDetail snapshot", async () => {
  const contracts = await readFile(resolve("src", "shared", "contracts.ts"), "utf8");
  const store = await readFile(resolve("src", "renderer", "store.ts"), "utf8");

  assert.match(contracts, /export interface RunDetail\s*\{[\s\S]*?revision: string;[\s\S]*?events: AgentRunEvent\[\];[\s\S]*?patches: PatchProposal\[\];[\s\S]*?activePatch\?: PatchProposal;[\s\S]*?approvals: ToolApproval\[\];[\s\S]*?review: ReviewPacketView;[\s\S]*?allowedActions: RunAllowedActions;/);
  assert.match(contracts, /getDetail\(runId: string\): Promise<RunDetail>/);
  assert.match(store, /const detail = await workbenchApi\(\)\.runs\.getDetail\(runId\)/);
  assert.match(store, /function runDetailState\(detail: RunDetail\)[\s\S]*?events: detail\.events,[\s\S]*?review: detail\.review,[\s\S]*?comments: detail\.comments,[\s\S]*?patch: visiblePatch\(detail\),[\s\S]*?pendingApprovals: detail\.approvals\.filter/);
});

test("run selection ignores stale async responses and reconciliation stays scoped", async () => {
  const store = await readFile(resolve("src", "renderer", "store.ts"), "utf8");

  assert.match(store, /let runSelectionGeneration = 0/);
  assert.match(store, /const generation = \+\+runSelectionGeneration/);
  assert.ok(
    (store.match(/if \(generation !== runSelectionGeneration\) return;/g) ?? []).length >= 2,
    "both the resolved and rejected selection paths must ignore stale generations",
  );
  assert.match(store, /async reconcileRunDetail\(runId\)[\s\S]*?if \(get\(\)\.selectedRunId !== runId\) return;[\s\S]*?await workbenchApi\(\)\.runs\.getDetail\(runId\)[\s\S]*?if \(get\(\)\.selectedRunId !== runId\) return;/);
});

test("streamed patches cannot replace the drawer for another selected run", async () => {
  const store = await readFile(resolve("src", "renderer", "store.ts"), "utf8");
  const patchBranch = store.match(/if \(event\.type === "patch-proposal"[\s\S]*?\n\s*}\n\s*if \(event\.type === "approval-required"/);

  assert.ok(patchBranch, "patch-proposal subscription branch was not found");
  assert.match(patchBranch[0], /if \(event\.patch\.runId === get\(\)\.selectedRunId\)/);
  assert.match(patchBranch[0], /void get\(\)\.reconcileRunDetail\(event\.patch\.runId\)/);
  assert.match(store, /selectedEventId: pendingPatchEventId\(state\.events, event\.patch as PatchProposal\)/);
});

test("patch decisions expose a busy lifecycle and disable both decision buttons", async () => {
  const app = await readFile(resolve("src", "renderer", "App.tsx"), "utf8");
  const store = await readFile(resolve("src", "renderer", "store.ts"), "utf8");

  assert.match(app, /disabled=\{Boolean\(busyPatchAction\) \|\| !runDetail\?\.allowedActions\.rejectPatch\}/);
  assert.match(app, /disabled=\{Boolean\(busyPatchAction\) \|\| !runDetail\?\.allowedActions\.approvePatch\}/);
  assert.match(app, /busyPatchAction === "approve"[\s\S]*?Checkpointing & applying…/);
  assert.match(app, /busyPatchAction === "reject"[\s\S]*?Rejecting…/);
  assert.match(store, /set\(\{ busyPatchAction: "approve" \}\)[\s\S]*?finally\s*\{[\s\S]*?set\(\{ busyPatchAction: undefined \}\)/);
  assert.match(store, /set\(\{ busyPatchAction: "reject" \}\)[\s\S]*?finally\s*\{[\s\S]*?set\(\{ busyPatchAction: undefined \}\)/);
  assert.match(app, /!runDetail\?\.allowedActions\.approvePatch/);
  assert.match(app, /!runDetail\?\.allowedActions\.rejectPatch/);
});

test("run attention renders actionable, accessible lifecycle CTAs", async () => {
  const app = await readFile(resolve("src", "renderer", "App.tsx"), "utf8");

  assert.match(app, /attention === "patch-review"[\s\S]*?label: "Review patch", run: showPendingPatch/);
  assert.match(app, /attention === "human-review"[\s\S]*?label: "Open human review", run: \(\) => navigate\("reviews"\)/);
  assert.match(app, /attention === "tool-approval"[\s\S]*?label: "Review tool action", run: focusToolApproval/);
  assert.match(app, /role="status" aria-live="polite" aria-busy=\{loading\}/);
  assert.match(app, /action && !loading && <button[\s\S]*?onClick=\{action\.run\}>\{action\.label\}/);
});

test("full Review keeps evidence and packet navigation wired", async () => {
  const pages = await readFile(resolve("src", "renderer", "OperationalPages.tsx"), "utf8");

  assert.match(pages, /const openFile = useWorkbenchStore\(\(state\) => state\.openFile\)/);
  assert.match(pages, /review\.claims\.map\(\(claim\) =>[\s\S]*?<button className="inline-link"[\s\S]*?disabled=\{!claim\.evidence\[0\]\}[\s\S]*?openFile\(claim\.evidence\[0\]\)/);
  assert.match(pages, /review\.packetPath && <button className="section-link"[\s\S]*?openFile\(review\.packetPath as string\)\}>Open review packet/);
});

test("materials activation and rollback require operator-supplied evidence in the UI", async () => {
  const pages = await readFile(resolve("src", "renderer", "OperationalPages.tsx"), "utf8");

  assert.match(pages, /activationOperator[\s\S]*?useState\(""\)/);
  assert.match(pages, /aria-label="Activation operator label"/);
  assert.match(pages, /aria-label="Activation approval reference"/);
  assert.match(pages, /operator label is self-declared and is not authenticated by Proto Workbench/);
  assert.match(pages, /disabled=\{busy \|\| !activationEvidenceComplete\}[\s\S]*?materials\.activate\(snapshot\.snapshot_id, activationEvidence\)/);
  assert.match(pages, /disabled=\{busy \|\| !snapshotInput\.trim\(\) \|\| !activationEvidenceComplete\}[\s\S]*?materials\.rollback\(snapshotInput\.trim\(\), activationEvidence\)/);
});
