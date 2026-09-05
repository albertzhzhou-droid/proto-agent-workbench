import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IPC } from "../src/shared/ipc.ts";
import {
  assertPrivilegedIpcSender,
  resolveRendererTarget,
  validateIpcArguments,
} from "../src/main/ipc-security.ts";
import {
  assertSafeExternalOpenPath,
  canonicalSelectedDirectory,
  revalidateRuntimeExecutable,
  trustRuntimeExecutable,
} from "../src/main/services/path-security.ts";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";
import { minimalChildEnvironment } from "../src/main/services/process-security.ts";

test("packaged renderer ignores environment URLs and development accepts only an exact loopback origin", () => {
  const packaged = resolveRendererTarget(true, "https://attacker.invalid/", "C:\\app\\renderer\\index.html");
  assert.equal(packaged.kind, "file");
  assert.match(packaged.expectedUrl, /^file:/);

  assert.equal(
    resolveRendererTarget(false, "http://127.0.0.1:5173/", "C:\\app\\renderer\\index.html").expectedUrl,
    "http://127.0.0.1:5173/",
  );
  assert.throws(
    () => resolveRendererTarget(false, "http://127.0.0.1:5173/nested", "C:\\app\\renderer\\index.html"),
    /exact HTTP loopback origin/,
  );
  assert.throws(
    () => resolveRendererTarget(false, "https://example.com/", "C:\\app\\renderer\\index.html"),
    /exact HTTP loopback origin/,
  );
  assert.throws(
    () => resolveRendererTarget(false, "http://localhost:5173/", "C:\\app\\renderer\\index.html"),
    /exact HTTP loopback origin/,
  );
});

test("the hidden desktop window is released after either visual readiness or a completed main-frame load", async () => {
  const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const createWindow = source.slice(source.indexOf("function createWindow"), source.indexOf("async function prepareDefaultWorkspace"));

  assert.match(createWindow, /show: false/);
  assert.match(createWindow, /mainWindow\.once\("ready-to-show", showLoadedWindow\)/);
  assert.match(createWindow, /mainWindow\.webContents\.once\("did-finish-load", showLoadedWindow\)/);
  assert.match(createWindow, /mainWindow\.isDestroyed\(\) \|\| mainWindow\.isVisible\(\)/);
});

test("protein track export binds a bounded source request without accepting renderer-supplied evidence", () => {
  const request = {
    target: {artifactPath: "build/protein.ir.json", artifactSha256: "a".repeat(64), proteinId: "protein-1", sequenceSha256: "b".repeat(64)},
    selectedRange: {start: 10, end: 25}, structure: null,
  };
  assert.deepEqual(validateIpcArguments(IPC.structurePrepareTracks, [request]), [request]);
  const svg = {request, format: "svg", svgSha256: "c".repeat(64)};
  assert.deepEqual(validateIpcArguments(IPC.structureExportTracks, [svg]), [svg]);
  for (const forged of [
    {...svg, metadata: {artifactSha256: "d".repeat(64)}},
    {...svg, filename: "../report.svg"},
    {...svg, svg: "<svg/>"},
    {...svg, png: new Uint8Array(64)},
    {...svg, format: "png"},
    {...svg, request: {...request, selectedRange: {start: 25, end: 10}}},
    {...svg, request: {...request, structure: {attachmentId: "c".repeat(64), modelIndex: -1, chainId: "A", explicitStartOneBased: 1}}},
  ]) assert.throws(() => validateIpcArguments(IPC.structureExportTracks, [forged]), /Invalid arguments/);
  const png = {...svg, format: "png", png: new Uint8Array(64)};
  assert.deepEqual(validateIpcArguments(IPC.structureExportTracks, [png]), [png]);
});

test("privileged IPC requires the exact main webContents, top frame, URL, and bounded schema", () => {
  const mainFrame = { url: "http://127.0.0.1:5173/" };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.doesNotThrow(() => assertPrivilegedIpcSender(event, window, mainFrame.url));
  assert.throws(
    () => assertPrivilegedIpcSender({ sender: webContents, senderFrame: { url: mainFrame.url } }, window, mainFrame.url),
    /untrusted renderer frame/,
  );
  assert.throws(
    () => assertPrivilegedIpcSender(event, window, "http://127.0.0.1:4173/"),
    /untrusted renderer frame/,
  );

  assert.deepEqual(validateIpcArguments(IPC.modelsScan, []), []);
  assert.throws(() => validateIpcArguments(IPC.modelsScan, ["C:\\arbitrary"]), /Invalid arguments/);
  const activationEvidence = {
    operator: "operator-supplied-label",
    approval_reference: "change-record:MAT-18",
  };
  assert.deepEqual(
    validateIpcArguments(IPC.materialsActivate, ["public-reviewed-2026.09", activationEvidence]),
    ["public-reviewed-2026.09", activationEvidence],
  );
  assert.deepEqual(
    validateIpcArguments(IPC.materialsRollback, ["public-reviewed-2026.09", activationEvidence]),
    ["public-reviewed-2026.09", activationEvidence],
  );
  const materializeSelection = {
    resource_ids: ["igem:first", "igem:second"],
    chassis: "ecoli_k12",
    snapshot: "public-reviewed-2026.09",
  };
  assert.deepEqual(
    validateIpcArguments(IPC.materialsMaterialize, [materializeSelection]),
    [materializeSelection],
  );
  assert.throws(
    () => validateIpcArguments(IPC.materialsMaterialize, [{ ...materializeSelection, resource_ids: [] }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.materialsMaterialize, [{ ...materializeSelection, resource_ids: ["igem:first", "IGEM:FIRST"] }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.materialsMaterialize, [{ ...materializeSelection, resource_ids: Array.from({ length: 51 }, (_, index) => `igem:${index}`) }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.materialsMaterialize, [{ ...materializeSelection, snapshot: "../staging" }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.materialsActivate, ["public-reviewed-2026.09"]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.materialsActivate, ["public-reviewed-2026.09", { ...activationEvidence, operator: "" }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.materialsRollback, ["public-reviewed-2026.09", { ...activationEvidence, approval_reference: "line 1\nline 2" }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.materialsActivate, ["public-reviewed-2026.09", { ...activationEvidence, operator: "line 1\u2028line 2" }]),
    /Invalid arguments/,
  );
  const validMapExport = {
    format: "svg",
    filename: "design-map.svg",
    bytes: new Uint8Array(64),
    width: 1200,
    height: 800,
    metadata: {
      schema: "proto-workbench.map-export.v1",
      exportedAt: "2026-08-31T12:00:00.000Z",
      format: "svg",
      designId: "design-1",
      construct: "construct-1",
      artifactPath: "build/design.ir.json",
      artifactSha256: "a".repeat(64),
      artifactSizeBytes: 128,
      digestStatus: "match",
      governance: { status: "verified", unverifiedPartCount: 0, gaps: [] },
      renderer: { name: "CGView.js", version: "1.8.2" },
      topology: { source: "circular", rendered: "circular", projection: false },
      viewOrigin: { applied: false, sourceBaseOneBased: 1, mutatesSource: false },
      coordinates: "internal 0-based end-exclusive; display 1-based inclusive",
      renderedMapLayers: {
        partAnnotations: true,
        primerBindings: true,
        softwareOrfDiscovery: false,
        softwareOrfMinimumAminoAcids: null,
        coordinateRuler: true,
        gcContentPlot: true,
        gcSkewPlot: false,
        gcWindowSize: 120,
        featureLabelDensity: "balanced",
        hiddenFeatureCount: 0,
        selectionOverlay: false,
      },
      excludedUiOverlays: ["selection"],
      excludedSequenceLayers: ["complement", "restriction_sites", "translations"],
      reviewStatus: "human_review_required",
      dataMode: "desktop",
    },
  };
  assert.deepEqual(validateIpcArguments(IPC.visualizationMapExport, [validMapExport]), [validMapExport]);
  assert.throws(
    () => validateIpcArguments(IPC.visualizationMapExport, [{ ...validMapExport, filename: "..\\design-map.svg" }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.visualizationMapExport, [{ ...validMapExport, format: "png" }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.visualizationMapExport, [{ ...validMapExport, bytes: new Uint8Array(31) }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.settingsUpdate, [{ runtimePath: "C:\\evil.exe" }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.threadsSend, ["thread", "x".repeat(131_073)]),
    /Invalid arguments/,
  );
  assert.deepEqual(
    validateIpcArguments(IPC.threadsSend, ["thread", "review this goal", "a".repeat(64)]),
    ["thread", "review this goal", "a".repeat(64)],
  );
  assert.throws(
    () => validateIpcArguments(IPC.threadsSend, ["thread", "review this goal", "not-a-digest"]),
    /Invalid arguments/,
  );
  assert.deepEqual(
    validateIpcArguments(IPC.harnessPreflight, [{ threadId: "thread", content: "review this goal" }]),
    [{ threadId: "thread", content: "review this goal" }],
  );
  const validPolicySimulation = {
    threadId: "thread",
    content: "compare this exact mission without executing it",
    scenarioIds: ["plan-posture", "workspace-drift"],
  };
  assert.deepEqual(validateIpcArguments(IPC.harnessPolicySimulation, [validPolicySimulation]), [validPolicySimulation]);
  assert.throws(
    () => validateIpcArguments(IPC.harnessPolicySimulation, [{ ...validPolicySimulation, content: "x".repeat(8_193) }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.harnessPolicySimulation, [{ ...validPolicySimulation, scenarioIds: ["arbitrary-policy"] }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.harnessPolicySimulation, [{ ...validPolicySimulation, apply: true }]),
    /Invalid arguments/,
  );
  const validDecisionBundle = {
    ...validPolicySimulation,
    selectedScenarioId: "workspace-drift",
    redaction: "metadata-only",
    expectedSimulationDigest: "c".repeat(64),
  };
  assert.deepEqual(validateIpcArguments(IPC.harnessDecisionBundlePreview, [validDecisionBundle]), [validDecisionBundle]);
  assert.deepEqual(
    validateIpcArguments(IPC.harnessDecisionBundleExport, [{ ...validDecisionBundle, expectedBundleDigest: "d".repeat(64) }]),
    [{ ...validDecisionBundle, expectedBundleDigest: "d".repeat(64) }],
  );
  assert.throws(
    () => validateIpcArguments(IPC.harnessDecisionBundlePreview, [{ ...validDecisionBundle, redaction: "include-everything" }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.harnessDecisionBundleExport, [{ ...validDecisionBundle, expectedBundleDigest: "D".repeat(64) }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.harnessDecisionBundlePreview, [{ ...validDecisionBundle, authorize: true }]),
    /Invalid arguments/,
  );

  for (const channel of [
    IPC.filesApplyPatch,
    IPC.filesRejectPatch,
    IPC.filesReconcilePatchOperation,
    IPC.filesResumePatchValidation,
    IPC.filesPrepareCheckpointRestore,
  ]) {
    assert.deepEqual(validateIpcArguments(channel, ["operation-1", 0]), ["operation-1", 0]);
    assert.throws(() => validateIpcArguments(channel, ["operation-1"]), /Invalid arguments/);
    assert.throws(() => validateIpcArguments(channel, ["operation-1", -1]), /Invalid arguments/);
    assert.throws(() => validateIpcArguments(channel, ["operation-1", 1.5]), /Invalid arguments/);
    assert.throws(() => validateIpcArguments(channel, ["operation-1", "0"]), /Invalid arguments/);
  }

  assert.deepEqual(validateIpcArguments(IPC.runsCreateCheckpoint, ["run-1"]), ["run-1"]);
  assert.throws(() => validateIpcArguments(IPC.runsCreateCheckpoint, ["run-1", "extra"]), /Invalid arguments/);
  assert.deepEqual(validateIpcArguments(IPC.runsPreviewResume, ["checkpoint-1"]), ["checkpoint-1"]);
  assert.deepEqual(validateIpcArguments(IPC.runsCockpit, []), []);
  const validEvidenceSearch = {
    query: "review packet",
    kinds: ["event", "artifact", "claim"],
    lifecycleStates: ["waiting-patch-review", "review-required"],
    stages: ["design", "review"],
    includeArchived: false,
    limit: 24,
  };
  assert.deepEqual(validateIpcArguments(IPC.runsSearchEvidence, [validEvidenceSearch]), [validEvidenceSearch]);
  assert.throws(() => validateIpcArguments(IPC.runsSearchEvidence, [{ ...validEvidenceSearch, query: "x".repeat(161) }]), /Invalid arguments/);
  assert.throws(() => validateIpcArguments(IPC.runsSearchEvidence, [{ ...validEvidenceSearch, limit: 51 }]), /Invalid arguments/);
  assert.throws(() => validateIpcArguments(IPC.runsSearchEvidence, [{ ...validEvidenceSearch, unexpected: true }]), /Invalid arguments/);
  const validFork = {
    checkpointId: "checkpoint-1",
    expectedSnapshotDigest: "a".repeat(64),
    expectedResumeContractDigest: "b".repeat(64),
    idempotencyKey: "fork:checkpoint-1:attempt-1",
    title: "Branch from review boundary",
  };
  assert.deepEqual(validateIpcArguments(IPC.runsForkCheckpoint, [validFork]), [validFork]);
  assert.throws(
    () => validateIpcArguments(IPC.runsForkCheckpoint, [{ ...validFork, expectedSnapshotDigest: "A".repeat(64) }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.runsForkCheckpoint, [{ ...validFork, expectedResumeContractDigest: "B".repeat(64) }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.runsForkCheckpoint, [{ ...validFork, idempotencyKey: "short" }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.runsForkCheckpoint, [{ ...validFork, title: "x".repeat(201) }]),
    /Invalid arguments/,
  );
  assert.throws(
    () => validateIpcArguments(IPC.runsForkCheckpoint, [{ ...validFork, expectedWorkspacePath: "C:\\other" }]),
    /Invalid arguments/,
  );
});

test("runtime trust binds a regular llama-server.exe digest and external open denies executable types", async () => {
  const root = await mkdtemp(join(tmpdir(), "proto-runtime-security-"));
  const runtimePath = join(root, "llama-server.exe");
  await writeFile(runtimePath, "trusted fixture", "utf8");
  const trust = await trustRuntimeExecutable(runtimePath);
  assert.match(trust.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await revalidateRuntimeExecutable(trust), runtimePath);
  await writeFile(runtimePath, "changed fixture", "utf8");
  await assert.rejects(revalidateRuntimeExecutable(trust), /changed after approval/);
  assert.doesNotThrow(() => assertSafeExternalOpenPath(join(root, "notes.md")));
  assert.throws(() => assertSafeExternalOpenPath(join(root, "payload.exe")), /cannot be opened/);
});

test("workspace traversal skips a junction that targets data outside the canonical workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-workspace-security-"));
  const outside = await mkdtemp(join(tmpdir(), "proto-workspace-outside-"));
  await writeFile(join(root, "inside.md"), "inside marker", "utf8");
  await writeFile(join(outside, "secret.md"), "outside secret marker", "utf8");
  const link = join(root, "linked-outside");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      context.skip("This Windows account cannot create a test junction.");
      return;
    }
    throw error;
  }
  assert.equal(await canonicalSelectedDirectory(root), root);
  await assert.rejects(canonicalSelectedDirectory(link), /non-linked|reparse points/);
  const workspace = new WorkspaceFiles(root, { savePatch() {} });
  const inside = await workspace.search("inside marker");
  const outsideMatches = await workspace.search("outside secret marker");
  assert.equal(inside.length, 1);
  assert.deepEqual(outsideMatches, []);
});

test("workspace capabilities reject hardlinks for reads, scans, snapshots, and replacement", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "proto-workspace-hardlink-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const outside = join(base, "outside.md");
  const linked = join(root, "linked.md");
  await mkdir(root);
  await writeFile(outside, "outside hardlink marker", "utf8");
  try {
    await link(outside, linked);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      context.skip("This filesystem cannot create a same-volume test hardlink.");
      return;
    }
    throw error;
  }

  const database = new AppDatabase(":memory:");
  context.after(() => database.close());
  const workspace = new WorkspaceFiles(root, database);
  await assert.rejects(workspace.read("linked.md"), /Hard-linked|single-link/);
  assert.deepEqual(await workspace.search("outside hardlink marker"), []);
  assert.deepEqual(await workspace.list(), []);
  await assert.rejects(
    workspace.proposePatch({
      runId: "run-hardlink",
      targetPath: "linked.md",
      after: "reviewed replacement",
      rationale: "Hardlink boundary regression",
    }),
    /Hard-linked|single-link/,
  );

  const target = join(root, "target.md");
  await writeFile(target, "reviewed base", "utf8");
  const patch = await workspace.proposePatch({
    runId: "run-hardlink",
    targetPath: "target.md",
    after: "approved result",
    rationale: "Controlled replacement regression",
  });
  await unlink(target);
  await link(outside, target);
  await assert.rejects(
    workspace.applyApprovedPatch(patch.id, patch.revision),
    /Hard-linked|single-link/,
  );
  assert.equal(await readFile(outside, "utf8"), "outside hardlink marker");
});

test("workspace paths reject in-root junction aliases for existing and missing targets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-workspace-alias-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const realDirectory = join(root, "real");
  const alias = join(root, "alias");
  await mkdir(realDirectory);
  await writeFile(join(realDirectory, "existing.md"), "canonical content", "utf8");
  try {
    await symlink(realDirectory, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      context.skip("This filesystem cannot create a directory link fixture.");
      return;
    }
    throw error;
  }

  const database = new AppDatabase(":memory:");
  context.after(() => database.close());
  const workspace = new WorkspaceFiles(root, database);
  await assert.rejects(workspace.read(join("alias", "existing.md")), /symbolic links or junctions/);
  await assert.rejects(
    workspace.proposePatch({
      runId: "run-alias",
      targetPath: join("alias", "new.md"),
      after: "must not be written through an alias",
      rationale: "Parent-link boundary regression",
    }),
    /symbolic links or junctions/,
  );
});

test("child environments preserve only the OS baseline and explicit capabilities", () => {
  process.env.PROTO_WORKBENCH_TEST_SECRET = "must-not-leak";
  try {
    const env = minimalChildEnvironment({ PROTO_ALLOWED_FIXTURE: "allowed" });
    assert.equal(env.PROTO_ALLOWED_FIXTURE, "allowed");
    assert.equal(env.PROTO_WORKBENCH_TEST_SECRET, undefined);
  } finally {
    delete process.env.PROTO_WORKBENCH_TEST_SECRET;
  }
});
