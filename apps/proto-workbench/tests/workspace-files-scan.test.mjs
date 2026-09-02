import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";

async function temporaryWorkspace(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function normalizedEntries(entries) {
  return entries.map((entry) => entry.relativePath.replaceAll("\\", "/")).sort();
}

test("workspace startup scan skips generated trees while retaining root build review artifacts", async (context) => {
  const root = await temporaryWorkspace(context, "proto-workspace-scan-");
  const rootArtifact = join(root, "build", "runs", "reviewed", "design.ir.json");
  const sourceFile = join(root, "docs", "overview.md");
  await mkdir(join(root, "build", "runs", "reviewed"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(rootArtifact, '{"schema":"proto-agent.ir.v1"}', "utf8");
  await writeFile(sourceFile, "reviewable source", "utf8");

  const nestedBuild = join(root, "apps", "proto-workbench", "build");
  await Promise.all(
    Array.from({ length: 600 }, (_, index) => mkdir(join(nestedBuild, `stress-output-${index}`), { recursive: true })),
  );
  await writeFile(join(nestedBuild, "stress-output-599", "must-not-index.md"), "generated", "utf8");

  const generatedSentinels = [
    join(root, ".pnpm-store", "must-not-index.json"),
    join(root, "apps", "proto-workbench", ".npm-cache", "must-not-index.json"),
    join(root, "apps", "proto-workbench", ".venv-sidecar", "must-not-index.py"),
    join(root, "apps", "proto-workbench", "dist", "must-not-index.js"),
    join(root, "apps", "proto-workbench", "node_modules", "must-not-index.js"),
    join(root, "apps", "proto-workbench", "NVIDIA Corporation", "umdlogs", "must-not-index.json"),
    join(root, "apps", "proto-workbench", "out", "must-not-index.js"),
    join(root, "apps", "proto-workbench", "qa", "must-not-index.png"),
    join(root, "apps", "proto-workbench", "release-final", "must-not-index.json"),
    join(root, "apps", "proto-workbench", "release-stress-r39", "must-not-index.json"),
    join(root, "apps", "proto-workbench", "release-v2", "must-not-index.json"),
    join(root, "apps", "proto-workbench", "runtime", "proto-agent", "must-not-index.py"),
  ];
  for (const sentinel of generatedSentinels) {
    await mkdir(join(sentinel, ".."), { recursive: true });
    await writeFile(sentinel, "generated", "utf8");
  }

  const workspace = new WorkspaceFiles(root, { savePatch() {} });
  const entries = normalizedEntries(await workspace.list());
  assert.deepEqual(entries, ["build/runs/reviewed/design.ir.json", "docs/overview.md"]);
});

test("root build scan keeps the real IR, manifest, provenance, and review contract only", async (context) => {
  const root = await temporaryWorkspace(context, "proto-workspace-build-contract-");
  const fixtures = new Map([
    ["build/design.ir.json", "{}"],
    ["build/runs/run-1/construct.ir.json", "{}"],
    ["build/runs/run-1/manifest.json", "{}"],
    ["build/runs/run-1/provenance.json", "{}"],
    ["build/runs/run-1/construct.fasta", ">generated"],
    ["build/reviews/run-1/evidence.cards.json", "[]"],
    ["build/reviews/run-1/human_review_checklist.md", "# Review"],
    ["build/reviews/run-1/review_packet.json", "{}"],
    ["build/reviews/run-1/review_packet.md", "# Packet"],
    ["build/analysis/run-1/manifest.json", "{}"],
    ["build/analysis/run-1/stdout.txt", "generated log"],
    ["build/notebooks/run-1/manifest.json", "{}"],
    ["build/notebooks/run-1/notebook_summary.json", "{}"],
    ["build/security/final-toggle.ir.json", "{}"],
    ["build/security/dependency-audit.json", "{}"],
    ["build/upgrade-queue/state.json", "{}"],
  ]);
  for (const [relativePath, content] of fixtures) {
    const target = join(root, ...relativePath.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const cacheRoot = join(root, "build", "cache");
  await Promise.all(
    Array.from({ length: 520 }, (_, index) => mkdir(join(cacheRoot, `entry-${index}`), { recursive: true })),
  );
  await writeFile(join(cacheRoot, "entry-519", "manifest.json"), "{}", "utf8");
  const pyinstallerRoot = join(root, "build", "pyinstaller");
  await Promise.all(
    Array.from({ length: 520 }, (_, index) => mkdir(join(pyinstallerRoot, `entry-${index}`), { recursive: true })),
  );
  await writeFile(join(pyinstallerRoot, "entry-519", "manifest.json"), "{}", "utf8");
  const visualizationQaRoot = join(root, "build", "visualization-qa");
  await Promise.all(
    Array.from({ length: 520 }, (_, index) => mkdir(join(visualizationQaRoot, `native-pass-${index}`), { recursive: true })),
  );
  await writeFile(join(visualizationQaRoot, "native-pass-519", "manifest.json"), "{}", "utf8");

  const workspace = new WorkspaceFiles(root, { savePatch() {} });
  const entries = normalizedEntries(await workspace.list());
  assert.deepEqual(entries, [
    "build/analysis/run-1/manifest.json",
    "build/design.ir.json",
    "build/notebooks/run-1/manifest.json",
    "build/reviews/run-1/evidence.cards.json",
    "build/reviews/run-1/human_review_checklist.md",
    "build/reviews/run-1/review_packet.json",
    "build/reviews/run-1/review_packet.md",
    "build/runs/run-1/construct.ir.json",
    "build/runs/run-1/manifest.json",
    "build/runs/run-1/provenance.json",
    "build/security/final-toggle.ir.json",
  ]);
});

test("workspace startup scan keeps its fail-closed directory budget for reviewable trees", async (context) => {
  const root = await temporaryWorkspace(context, "proto-workspace-budget-");
  const sourceRoot = join(root, "source");
  await Promise.all(
    Array.from({ length: 520 }, (_, index) => mkdir(join(sourceRoot, `directory-${index}`), { recursive: true })),
  );

  const workspace = new WorkspaceFiles(root, { savePatch() {} });
  await assert.rejects(workspace.list(), /Workspace scan exceeded its directory budget/);
});
