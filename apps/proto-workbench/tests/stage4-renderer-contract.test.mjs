import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  digestBindingForArtifact,
  parseDesignProvenanceStatement,
} from "../src/renderer/design-artifacts.ts";

test("a fresh Launchpad draft clears stale run selection and RunHeader never falls back to another run", async () => {
  const pages = await readFile(resolve("src", "renderer", "OperationalPages.tsx"), "utf8");
  const store = await readFile(resolve("src", "renderer", "store.ts"), "utf8");
  const app = await readFile(resolve("src", "renderer", "App.tsx"), "utf8");
  const launchpad = section(pages, "function LaunchpadPage()", "function PageHeader");
  const beginNewRun = section(store, "async beginNewRun(mode)", "async setMode(mode)");
  const runHeader = section(app, "function RunHeader()", "function RunAttentionStrip()");

  assert.match(launchpad, /const beginNewRun = useWorkbenchStore\(\(state\) => state\.beginNewRun\)/);
  assert.match(launchpad, /const startRun = async \(mode: "plan" \| "act"\) => \{\s*await beginNewRun\(mode\);\s*\}/);
  assert.match(beginNewRun, /selectedRunId: undefined/);
  assert.match(beginNewRun, /runDetail: undefined/);
  assert.match(beginNewRun, /events: \[\]/);
  assert.match(beginNewRun, /selectedEventId: undefined/);
  assert.match(beginNewRun, /patch: undefined/);
  assert.match(beginNewRun, /pendingApprovals: \[\]/);

  assert.match(runHeader, /const current = selectedRunId\s*\? runs\.find\(\(run\) => run\.runId === selectedRunId\)\s*: undefined/);
  assert.doesNotMatch(runHeader, /runs\s*\[\s*0\s*\]/, "RunHeader must not show the first run when no run is selected");
  assert.match(runHeader, /<h1>\{current\?\.title \?\? thread\?\.title \?\? "New Proto research run"\}<\/h1>/);
});

test("preview fixtures have a global, persistent safety boundary", async () => {
  const app = await readFile(resolve("src", "renderer", "App.tsx"), "utf8");
  const styles = await readFile(resolve("src", "renderer", "styles.css"), "utf8");
  const appShell = section(app, "export function App()", "function StartupSurface");
  const topBar = section(app, "function TopBar()", "function Sidebar()");

  assert.match(appShell, /<TopBar \/>[\s\S]*?currentView === "runs"/);
  assert.match(topBar, /const dataMode = workbenchDataMode\(\)/);
  assert.match(topBar, /dataMode === "preview" && <span className="global-preview-badge"/);
  assert.match(topBar, /Development fixtures are active; actions do not change a real workspace\./);
  assert.match(topBar, />Preview · fixture only<\/span>/);
  assert.match(styles, /\.global-preview-badge\s*\{/);
});

test("Design Explorer binds current artifact bytes to provenance and blocks invalid IR", async () => {
  const designs = await readFile(resolve("src", "renderer", "DesignsPage.tsx"), "utf8");

  assert.ok(designs.includes("const provenanceCandidates = entries"));
  assert.ok(designs.includes("provenance\\.json"));
  assert.match(designs, /const parsed = parseDesignProvenanceStatement\(JSON\.parse\(file\.content\) as unknown, entry\.path\)/);
  assert.match(designs, /digestBindingForArtifact\(entry\.relativePath, file\.sha256, entry\.sizeBytes, provenanceStatements\)/);
  assert.match(designs, /if \(!parsed\.ok \|\| !parsed\.design\)[\s\S]*?status: "invalid"[\s\S]*?diagnostics: parsed\.diagnostics/);
  assert.match(designs, /if \(!design \|\| !construct\)[\s\S]*?className="designs-page has-invalid-artifact"/);
  assert.match(designs, /<section className="design-artifact-error" role="alert">/);
  assert.match(designs, /<DesignsHeader[\s\S]*?exportDisabled/);
  assert.match(designs, /digestBinding\?\.status === "mismatch"[\s\S]*?Digest mismatch/);
  assert.match(designs, /Do not rely on this artifact until it is rebuilt or reconciled\./);
});

test("artifact digest binding requires both SHA-256 and byte size and malformed provenance fails closed", () => {
  const digest = "a".repeat(64);
  const parsed = parseDesignProvenanceStatement({
    schema_version: "proto-agent.provenance.v1",
    run_id: "run-stage4",
    subject: { sha256: "b".repeat(64) },
    artifacts: [{ path: "runs/run-stage4/design.ir.json", sha256: digest, size: 128 }],
  }, "build/runs/run-stage4/provenance.json");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(
    digestBindingForArtifact("build/runs/run-stage4/design.ir.json", digest, 128, [parsed.statement])?.status,
    "match",
  );
  assert.equal(
    digestBindingForArtifact("build/runs/run-stage4/design.ir.json", digest, 129, [parsed.statement])?.status,
    "mismatch",
  );
  assert.equal(
    digestBindingForArtifact("build/runs/run-stage4/design.ir.json", "c".repeat(64), 128, [parsed.statement])?.status,
    "mismatch",
  );

  assert.deepEqual(parseDesignProvenanceStatement({
    schema_version: "proto-agent.provenance.v1",
    run_id: "run-stage4",
    subject: { sha256: "not-a-digest" },
    artifacts: [],
  }, "build/runs/run-stage4/provenance.json"), {
    ok: false,
    error: "The provenance subject digest is missing or malformed.",
  });
});

test("the renderer consumes the operation-scoped durable validation journal", async () => {
  const contracts = await readFile(resolve("src", "shared", "contracts.ts"), "utf8");
  const app = await readFile(resolve("src", "renderer", "App.tsx"), "utf8");
  const patchRail = section(app, "function PatchOperationRail", "function ValidationJournalRail");
  const journalRail = section(app, "function ValidationJournalRail", "function ToolApprovalBar");

  assert.match(contracts, /export interface RunDetail\s*\{[\s\S]*?validationJournals\?: ValidationJournalSnapshot\[\]/);
  assert.match(patchRail, /detail\?\.validationJournals\?\.find\(\(candidate\) => candidate\.operationId === operation\.id\)/);
  assert.match(patchRail, /\{journal && <ValidationJournalRail journal=\{journal\} \/>\}/);
  assert.match(journalRail, /NonNullable<RunDetail\["validationJournals"\]>\[number\]/);
  assert.match(journalRail, /aria-label="Durable validation journal"/);
  assert.match(journalRail, /journal\.steps\.map\(\(step\) =>/);
  assert.match(journalRail, /attempt \{step\.attempt\}/);
  assert.match(journalRail, /Plan \{shortHash\(journal\.planSha256\)\} · journal v\{journal\.revision\}/);
  assert.match(journalRail, /No write or network side effect was replayed automatically\./);
});

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
