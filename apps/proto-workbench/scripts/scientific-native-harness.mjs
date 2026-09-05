import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";
import { projectRunExecution } from "../src/shared/run-execution.ts";

const KEY = "qwen3.8-27b@q4_k_m";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const resumeAcknowledged = (current, previous) => current?.runId === previous.runId && current.revision > previous.revision && current.state !== "paused";
const GOAL = `Complete one software-only DNA design task within this workspace. Read designs/native-qa.proto and parts/eligible.json. Preserve the four existing eligible resource IDs and occurrence IDs p1,r1,c1,t1, topology and order. Reconfirm those existing records through proto_materials_search, then proto_materials_materialize to build/native-harness-parts.json and proto_search_parts using the returned parts_path; use that exact new material binding for this mission. Create designs/native-harness.proto with design name native_harness_qa and the same valid construct using workspace_propose_patch. After the edit run check and compile, including proto_compile with explicit output build/native-harness.ir.json, and capture workflow provenance and review evidence. Reopen build/native-harness.ir.json with workspace_read and finish only with actual artifact evidence. Deliver designs/native-harness.proto and build/native-harness.ir.json. Keep every generated report or review artifact under build/. Do not alter the original designs/native-qa.proto or parts/eligible.json. Use only the existing reviewed records, no new biological IDs. This task is local software verification, with no network access or wet-lab instructions. Stop after this one task.`;

/** One real model task, actual native UI controls; only this UI-owned instance is unloaded. */
export async function runScientificNativeHarness({ page, report, check, screenshot, waitUntil, workspace, profile, evidence, fileTree, activeRestart = false, skipGraphPointer = false, inspectOnly = false, resumePaused = false, restartOwnedApplication }) {
  const nav = (name) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });
  const models = () => page.evaluate(() => window.workbench.models.list());
  const selectExactModel = async (model) => {
    const rows = page.locator(".catalog-model-row").filter({ has: page.getByText(model.name, { exact: true }) });
    const count = await rows.count(); assert(count > 0 && count <= 12, "Exact-key model selection candidates must stay bounded.");
    for (let index = 0; index < count; index += 1) {
      await rows.nth(index).click();
      if (await page.locator(".model-detail-heading p").innerText() === KEY) return;
    }
    throw new Error("No native catalogue row exposes the requested exact model key.");
  };
  let ownedModelId, ownedInstanceId, runId;
  if (!inspectOnly && !resumePaused) report.harnessNative = { key: KEY, contextTokens: 32768, goal: GOAL, startedAt: new Date().toISOString(), mode: "Exactly one native user-submitted mission; no replay or seeded model results", checkpoints: [] };
  else if (inspectOnly) assert(report.harnessNative?.finalProjection?.state === "completed", "Inspection requires a previously completed real mission.");
  else { assert.equal(report.harnessNative?.activeRestart?.paused?.state, "paused"); runId = report.harnessNative.activeRestart.paused.runId; }
  const details = report.harnessNative;
  const readDurable = () => {
    const db = new DatabaseSync(join(profile, "proto-workbench.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT payload,sha256 FROM harness_executions WHERE run_id=?").get(runId);
      assert(row && hash(row.payload) === row.sha256);
      const sourceOperations = db.prepare("SELECT call_id,payload,sha256 FROM harness_source_operations WHERE run_id=? ORDER BY call_id").all(runId).map((row) => ({ ...row }));
      for (const operation of sourceOperations) assert.equal(hash(operation.payload), operation.sha256);
      return { checkpoint: JSON.parse(row.payload), sourceOperations, results: db.prepare("SELECT call_id,tool,sha256 FROM harness_results WHERE run_id=? ORDER BY call_id").all(runId).map((result) => ({ ...result })) };
    } finally { db.close(); }
  };
  const loadOwnedModel = async () => {
      await nav("Models").click();
      await page.getByRole("button", { name: "Refresh LM Studio", exact: true }).click();
      const catalogue = await waitUntil(async () => { const items = await models(); return items.some((item) => item.providerModelId === KEY) ? items : undefined; }, 20_000);
      assert(catalogue.every((item) => !item.loadedInstances?.length), "The reserved native inference slot must start without another loaded instance.");
      const model = catalogue.find((item) => item.providerModelId === KEY);
      details.discovery = { id: model.id, key: model.providerModelId, name: model.name, loadedInstances: model.loadedInstances, at: new Date().toISOString() };
      await selectExactModel(model);
      assert.equal(await page.locator(".model-detail-heading p").innerText(), KEY);
      await page.locator(".load-control-group").filter({ hasText: "Context length" }).locator('input[type="number"]').fill("32768");
      await page.getByRole("button", { name: "Load in LM Studio", exact: true }).click();
      const loaded = await waitUntil(async () => (await models()).find((item) => item.id === model.id && item.workbenchInstance?.ownedByWorkbench), 120_000);
      ownedModelId = model.id; ownedInstanceId = loaded.workbenchInstance.id;
      await page.getByRole("button", { name: "Refresh LM Studio", exact: true }).click();
      const observed = await waitUntil(async () => (await models()).find((item) => item.id === model.id)?.loadedInstances?.find((instance) => instance.id === ownedInstanceId), 20_000);
      assert.equal(observed.contextLength, 32768);
      details.load = { id: model.id, instanceId: ownedInstanceId, contextLength: 32768, ownedByWorkbench: true, at: new Date().toISOString() }; report.modelsLoaded = true;
      (details.loads ??= []).push(details.load);
      await screenshot(`harness-01-owned-model-${details.loads.length}`); return details.load;
  };
  const unloadOwnedModel = async () => {
    const owned = (await models()).filter((model) => model.providerModelId === KEY && model.workbenchInstance?.ownedByWorkbench);
    if (!owned.length) return;
    assert.equal(owned.length, 1); const model = owned[0];
    if (ownedInstanceId) assert.equal(model.workbenchInstance.id, ownedInstanceId);
    ownedModelId ??= model.id;
    await nav("Models").click(); await selectExactModel(model);
    await page.getByRole("button", { name: "Unload owned instance", exact: true }).click();
    await waitUntil(async () => !(await models()).some((item) => item.workbenchInstance?.id === model.workbenchInstance.id), 40_000);
    await page.getByRole("button", { name: "Refresh LM Studio", exact: true }).click();
    await waitUntil(async () => !(await models()).some((item) => item.workbenchInstance?.id === model.workbenchInstance.id || item.loadedInstances?.some((instance) => instance.id === model.workbenchInstance.id)), 40_000);
    details.unload = { id: model.id, instanceId: model.workbenchInstance.id, absentAfterOwnedUiUnload: true, at: new Date().toISOString() };
    (details.unloads ??= []).push(details.unload);
    await screenshot(`harness-07-owned-instance-unloaded-${details.unloads.length}`);
  };
  try {
    if (!inspectOnly) {
    await check("native live catalogue discovery and explicit owned Qwen load", loadOwnedModel);
    await check("native mission preflight and one real Qwen tool execution", async () => {
      if (resumePaused) {
        const paused = details.activeRestart.paused;
        const reopened = (await page.evaluate(() => window.workbench.harness.listExecutions())).find((item) => item.runId === runId);
        assert.equal(reopened.state, "paused"); assert(reopened.resumable);
        assert.equal(reopened.generatedTokens, paused.generatedTokens); assert.equal(reopened.activeTimeMs, paused.activeTimeMs);
        assert.deepEqual(readDurable().sourceOperations, details.activeRestart.pausedDurable.sourceOperations);
        assert.equal(hash(await readFile(join(workspace, "designs", "native-harness.proto"))), details.activeRestart.sourceSha256);
        details.activeRestart.reopened = reopened;
        await page.locator(".recent-run").first().click();
        await screenshot("harness-restart-02-same-paused-task-new-process");
        await page.getByRole("button", { name: "Resume saved task", exact: true }).click();
        details.activeRestart.explicitResumeAt = new Date().toISOString();
        details.activeRestart.resumeAcknowledged = await waitUntil(async () => {
          const current = (await page.evaluate(() => window.workbench.harness.listExecutions())).find((item) => item.runId === runId);
          return resumeAcknowledged(current, reopened) ? current : undefined;
        });
      } else {
      await nav("Launchpad").click();
      await page.getByRole("button", { name: /Act within scope/ }).click();
      await page.getByRole("textbox", { name: "Ask the local research agent", exact: true }).fill(GOAL);
      await page.getByRole("button", { name: "Review mission", exact: true }).click();
      await page.getByRole("region", { name: "Trusted mission preflight" }).waitFor();
      details.preflight = await page.getByRole("region", { name: "Trusted mission preflight" }).innerText();
      // Keep the actual reviewed card across at least three normal2s metrics
      // emissions; unrelated VRAM updates must not invalidate mission authority.
      await page.waitForTimeout(6500);
      assert(await page.getByRole("region", { name: "Trusted mission preflight" }).isVisible(), "Reviewed preflight disappeared during routine model metrics updates.");
      details.preflightStableForMs = 6500;
      await screenshot("harness-02-preflight");
      const start = page.getByRole("button", { name: "Start mission", exact: true });
      assert.equal(await start.count(), 1, `Native launch is unavailable: ${details.preflight}`);
      assert(await start.isEnabled(), details.preflight); await start.click();
      }
      const terminal = new Set(["completed", "incomplete", "blocked", "cancelled", "effect-unknown", "failed", "paused"]);
      let previous = "";
      const projection = await waitUntil(async () => {
        const list = await page.evaluate(() => window.workbench.harness.listExecutions());
        assert(list.length <= 1, "This QA must create exactly one model mission.");
        const current = list[0]; if (!current) return;
        runId = current.runId;
        if (activeRestart && !details.activeRestart && current.state === "generating") {
          const durable = readDurable();
          const receipts = durable.sourceOperations.filter((row) => JSON.parse(row.payload).phase === "receipt");
          if (receipts.length && durable.checkpoint.pendingCalls.length === 0) {
            details.activeRestart = { triggeredAt: new Date().toISOString(), before: durable, mode: "Ordinary window close while actively generating after a durable source receipt; no manual Pause", ownedInstanceBeforeClose: ownedInstanceId };
            details.activeRestart.sourceSha256 = hash(await readFile(join(workspace, "designs", "native-harness.proto")));
            await screenshot("harness-restart-01-active-task-before-window-close");
            // Exercise the production window-close path. The application must
            // persist a resumable checkpoint, release its MCP, and unload its
            // owned model before exit. No manual Pause precedes this close.
            page = await restartOwnedApplication({ requireCooperativeClose: true });
            const reopened = await waitUntil(async () => (await page.evaluate(() => window.workbench.harness.listExecutions())).find((item) => item.runId === runId));
            assert.equal(reopened.state, "paused"); assert(reopened.resumable);
            const pausedDurable = readDurable();
            assert.equal(pausedDurable.checkpoint.pendingCalls.length, 0, "Cooperative close must settle the pending-call boundary.");
            assert(reopened.generatedTokens >= durable.checkpoint.generatedTokens, "Restart must not refund the generated-token budget.");
            assert(reopened.activeTimeMs >= durable.checkpoint.activeTimeMs, "Restart must not refund active time.");
            assert.deepEqual(pausedDurable.sourceOperations, durable.sourceOperations, "Closing must not replay or replace the committed source operation.");
            for (const result of durable.results) assert.deepEqual(pausedDurable.results.find((item) => item.call_id === result.call_id), result);
            assert.equal(hash(await readFile(join(workspace, "designs", "native-harness.proto"))), details.activeRestart.sourceSha256);
            details.activeRestart.paused = reopened;
            details.activeRestart.pausedDurable = pausedDurable;
            details.activeRestart.reopened = reopened;
            details.activeRestart.cooperativeWindowClose = true;
            details.activeRestart.shutdownOwnedUnloadConfirmedByFreshCatalogue = false;
            await page.locator(".recent-run").first().click();
            await screenshot("harness-restart-02-same-task-new-process");
            await loadOwnedModel();
            // loadOwnedModel requires the live provider catalogue to be empty
            // before requesting a fresh owned instance at the exact context.
            details.activeRestart.shutdownOwnedUnloadConfirmedByFreshCatalogue = true;
            await page.locator(".recent-run").first().click();
            await page.getByRole("button", { name: "Resume saved task", exact: true }).click();
            details.activeRestart.explicitResumeAt = new Date().toISOString();
            details.activeRestart.resumeAcknowledged = await waitUntil(async () => {
              const current = (await page.evaluate(() => window.workbench.harness.listExecutions())).find((item) => item.runId === runId);
              return resumeAcknowledged(current, reopened) ? current : undefined;
            });
            return;
          }
        }
        const key = `${current.round}:${current.state}`;
        if (key !== previous) { previous = key; details.checkpoints.push(current); console.log(JSON.stringify({ stage: "native-Qwen", round: current.round, state: current.state, savedResults: current.resultCount })); }
        return terminal.has(current.state) ? current : undefined;
      }, 900_000);
      details.finalProjection = projection;
      details.events = await page.evaluate((id) => window.workbench.runs.get(id), runId);
      await writeFile(join(evidence, "harness-real-events.json"), JSON.stringify(details.events, null, 2));
      await screenshot("harness-03-model-task-finished");
      assert.equal(projection.state, "completed", JSON.stringify(projection.error));
      assert(projection.resultCount >= 3 && projection.round >= 2);
      if (activeRestart) {
        assert(details.activeRestart?.explicitResumeAt, "A real application restart and explicit Resume must have occurred before completion.");
        const after = readDurable(), before = details.activeRestart.pausedDurable;
        assert.deepEqual(after.sourceOperations, before.sourceOperations, "The committed source operation must not be duplicated or rewritten after restart.");
        for (const result of before.results) assert.deepEqual(after.results.find((item) => item.call_id === result.call_id), result, "A prior durable tool result changed after restart.");
        assert(after.checkpoint.generatedTokens >= before.checkpoint.generatedTokens);
        assert(after.checkpoint.activeTimeMs >= before.checkpoint.activeTimeMs);
        assert(after.checkpoint.recoveryCounters.resumes >= 1);
        details.activeRestart.after = after;
        details.activeRestart.priorSourceOperationNotReplayed = true;
      }
      return { runId, state: projection.state, rounds: projection.round, results: projection.resultCount, events: details.events.length };
    });
    }
    if (!skipGraphPointer) await check("real persisted dependency graph and selected operation data", async () => {
      const projected = projectRunExecution(details.events);
      const edges = projected.topologyEdges.filter((edge) => edge.kind === "execution");
      assert(edges.length > 0, "Actual tool-result dependencies must be recorded.");
      await page.getByRole("tab", { name: "Topology", exact: true }).click();
      const graph = page.locator(".run-dependency-graph"); await graph.waitFor();
      const nodes = graph.locator(".run-dependency-node"); assert((await nodes.count()) >= 3);
      assert.equal(await graph.locator(".run-dependency-canvas > svg > path").count(), edges.length);
      await nodes.last().click();
      const data = page.getByRole("region", { name: "Selected operation data" }); await data.waitFor();
      assert.match(await data.innerText(), /Recorded SHA-256/);
      await data.getByRole("button", { name: "Arguments", exact: true }).click();
      assert.match(await data.locator("pre").getAttribute("aria-label"), /Recorded arguments/);
      await screenshot("harness-04-real-dependency-graph");
      await data.getByRole("button", { name: "Result", exact: true }).click();
      await screenshot("harness-05-selected-operation");
      return { nodes: await nodes.count(), persistedObservedDependencies: edges.length, selectedData: await data.innerText() };
    });
    else (report.exclusions ??= []).push("Graph pointer interaction is excluded from this kernel restart case because c2c0/r-0c8d820b preserves the actual panel occlusion failure. It requires a separate corrected native UI gate.");
    await check("model-created DNA artifact opens and exports through actual native UI", async () => {
      const source = await readFile(join(workspace, "designs", "native-harness.proto"), "utf8");
      const irBytes = await readFile(join(workspace, "build", "native-harness.ir.json"));
      const ir = JSON.parse(irBytes); assert.equal(ir.design_id, "native_harness_qa");
      assert.equal(hash(await readFile(join(workspace, "designs", "native-qa.proto"))), report.initialSourceSha256);
      assert.equal(hash(await readFile(join(workspace, "parts", "eligible.json"))), report.initialPartsSha256);
      await nav("Designs").click(); await page.getByRole("button", { name: "Refresh artifacts", exact: true }).click();
      const document = page.locator(".design-document").filter({ hasText: "native_harness_qa" }).first(); await document.waitFor(); await document.click();
      await page.getByRole("button", { name: /^Select p1, promoter/ }).click();
      await page.getByRole("button", { name: "PNG", exact: true }).click();
      const receipt = page.getByRole("region", { name: "Latest map export verification" }); await receipt.waitFor();
      assert.match(await receipt.innerText(), /Independently reopened/);
      const pngs = (await fileTree(join(workspace, "build", "visualization-exports"))).filter((path) => path.endsWith(".png"));
      assert.equal(pngs.length, 1); const bytes = await readFile(pngs[0]); const decoded = await sharp(bytes).metadata();
      assert(decoded.width > 100 && decoded.height > 100);
      await screenshot("harness-06-model-design-export");
      return { sourceSha256: hash(source), artifactSha256: hash(irBytes), exportedPng: pngs[0], pngSha256: hash(bytes), width: decoded.width, height: decoded.height, originalInputsUnchanged: true };
    });
  } catch (error) {
    details.failure = { message: error.message, body: await page.locator("body").innerText().catch(() => "unavailable"), at: new Date().toISOString() };
    await screenshot("harness-failure-before-cleanup").catch(() => undefined);
    throw error;
  } finally {
    if (!inspectOnly && runId) {
      const current = (await page.evaluate(() => window.workbench.harness.listExecutions())).find((item) => item.runId === runId);
      if (current && !["completed", "cancelled", "failed", "blocked", "effect-unknown", "incomplete"].includes(current.state)) {
        // Failure cleanup preserves a resumable checkpoint and awaits actual
        // host teardown instead of cancelling a newly acknowledged resume.
        await page.evaluate((id) => window.workbench.harness.pauseExecution(id), runId);
      }
    }
    if (!inspectOnly) await unloadOwnedModel();
    await writeFile(join(evidence, "harness-native.json"), JSON.stringify(details, null, 2));
  }
}
