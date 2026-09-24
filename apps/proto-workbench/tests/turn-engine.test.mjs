import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { completionGate, projectToolResult, toolResultFailed, turnBudget } from "../src/main/services/turn-engine.ts";
import { HarnessStore } from "../src/main/services/harness-store.ts";
import { assembleHarnessContext, projectToolResult as projectHarness } from "../src/main/services/harness-context.ts";

test("shared projector bounds metadata, JSON escapes and Unicode while retaining a complete artifact route", () => {
  const text = JSON.stringify({ ok: true, artifacts: Array.from({length:200}, (_,i) => `build/${i}-${"x".repeat(250)}.json`), maturity: { description: "m".repeat(60000) }, body: "🧬中文\n\"".repeat(10000) });
  for (const budget of [256, 1200, 48000]) {
    const encoded = projectToolResult(text, budget, "build/chat/full-output.json"), projected = JSON.parse(encoded);
    assert.ok(Buffer.byteLength(encoded) <= budget);
    assert.equal(projected.artifactPath, "build/chat/full-output.json");
    assert.ok(projected.omittedArtifactCount > 0);
    assert.ok(projected.omittedIdentityFields > 0);
    assert.equal(projected.preview.includes("�"), false);
  }
});

test("projector Unicode boundary has no replacement characters and preserves a harness result handle", () => {
  const text = JSON.stringify({ handle: "exact-result-handle", payload: "🧬中".repeat(1000) });
  for (const budget of [128, 129, 257, 1001, 1200]) {
    const result = projectToolResult(text, budget);
    assert.ok(Buffer.byteLength(result) <= budget);
    assert.equal(JSON.parse(result).handle, "exact-result-handle");
    assert.equal(JSON.parse(result).preview.includes("�"), false);
  }
});

test("Harness and Chat share context budget and preserve the Harness repair reply allowance", async () => {
  assert.deepEqual(turnBudget(32768), { replyTokens: 4096, reserveTokens: 2048, inputBudget: 26624 });
  assert.equal(turnBudget(32768, 8192).replyTokens, 8192);
  assert.equal(turnBudget(8192).replyTokens, 2048);
  const boundary = turnBudget(8192).inputBudget;
  const context = await assembleHarnessContext([{ role: "user", content: "Request" }], [], "Request", 8192, 4096, async () => boundary);
  assert.equal(context.tokens, boundary);
  await assert.rejects(assembleHarnessContext([{ role: "user", content: "Request" }], [], "Request", 8192, 4096, async () => boundary + 1), /CONTEXT_BUDGET_EXHAUSTED/);
});

test("Harness durable results and shared evidence gate retain text-only tool failures", () => {
  const db = new DatabaseSync(":memory:"), store = new HarnessStore(db), failure = { isError: true, content: [{ type: "text", text: "Rejected" }] };
  const result = store.record("run", "call", "proto_check", failure);
  assert.equal(result.ok, false);
  assert.equal(store.read("run", result.handle).ok, false);
  assert.equal(toolResultFailed({ ok: true, data: { status: "failed" } }), true);
  assert.equal(completionGate([{ status: result.ok ? "complete" : "error" }]), "incomplete-evidence");
  assert.equal(JSON.parse(projectHarness(result)).ok, false);
  db.close();
});
