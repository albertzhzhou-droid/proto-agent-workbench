import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { normalizeReport, writeStressUpgradeQueue } from "../scripts/stress-upgrade-queue.mjs";

test("stress failures become bounded machine-readable upgrade items", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "proto-stress-queue-"));
  const build = join(workspace, "build");
  await mkdir(build);
  try {
    const path = await writeStressUpgradeQueue(build, {
      scenario: "levodopa-safety",
      status: "failed",
      stage: "model-load",
      detailCode: "LLAMA_HEALTH_TIMEOUT",
      diagnosticFingerprint: "0123456789abcdef",
      metrics: {
        eventCount: 9,
        eventTypes: { "run-event": 5, "message-delta": 4 },
        completedTools: ["proto_connectors_check"],
        messageCharacters: 128,
        lastRunEvent: { stage: "plan", actor: "tool", status: "completed", tool: "proto_connectors_check" },
      },
      findings: [],
    });
    const queue = JSON.parse(await readFile(path, "utf8"));
    assert.equal(queue.schema_version, "proto-workbench.stress-upgrade-queue.v1");
    assert.equal(queue.items[0].code, "LLAMA_HEALTH_TIMEOUT");
    assert.equal(queue.items[0].priority, "P1");
    assert.equal(queue.diagnostic_fingerprint, "0123456789abcdef");
    assert.deepEqual(queue.metrics.completedTools, ["proto_connectors_check"]);
    assert.equal(JSON.stringify(queue).includes(workspace), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("successful clean stress reports do not manufacture queue items", () => {
  const queue = normalizeReport({
    scenario: "levodopa-safety",
    status: "passed",
    stage: "report",
    detailCode: "NONE",
    findings: [],
  });
  assert.deepEqual(queue.items, []);
});
