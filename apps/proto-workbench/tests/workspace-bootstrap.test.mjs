import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activateStartupWorkspace, seedWorkspace } from "../src/main/services/workspace-bootstrap.ts";

test("workspace seed copies missing fixtures without overwriting user edits", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-workbench-seed-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const template = join(root, "template");
  const workspace = join(root, "workspace");
  await mkdir(join(template, "parts"), { recursive: true });
  await mkdir(join(template, "workflows"), { recursive: true });
  await mkdir(join(workspace, "parts"), { recursive: true });
  await writeFile(join(template, "parts", "library.json"), "template-library", "utf8");
  await writeFile(join(template, "workflows", "review.json"), "template-workflow", "utf8");
  await writeFile(join(workspace, "parts", "library.json"), "user-edited-library", "utf8");

  await seedWorkspace(template, workspace);

  assert.equal(await readFile(join(workspace, "parts", "library.json"), "utf8"), "user-edited-library");
  assert.equal(await readFile(join(workspace, "workflows", "review.json"), "utf8"), "template-workflow");
});

test("startup workspace activation falls back without blocking the recovery UI", async () => {
  const attempts = [];
  const result = await activateStartupWorkspace("C:\\missing-workspace", "C:\\safe-workspace", async (path) => {
    attempts.push(path);
    if (path === "C:\\missing-workspace") throw new Error("Workspace path is unavailable.");
  });

  assert.deepEqual(attempts, ["C:\\missing-workspace", "C:\\safe-workspace"]);
  assert.equal(result.activePath, "C:\\safe-workspace");
  assert.deepEqual(result.fallback, {
    requestedPath: "C:\\missing-workspace",
    reason: "Workspace path is unavailable.",
  });
});

test("startup workspace activation does not hide a failure in the only safe path", async () => {
  await assert.rejects(
    activateStartupWorkspace("C:\\safe-workspace", "C:\\safe-workspace", async () => {
      throw new Error("Default workspace is unavailable.");
    }),
    /Default workspace is unavailable/,
  );
});

test("packaged workspace connector registry stays identical to the hardened source registry", async () => {
  const source = JSON.parse(await readFile(new URL("../../../connectors/proto_workbench.json", import.meta.url), "utf8"));
  const template = JSON.parse(await readFile(new URL("../runtime/workspace-template/connectors/proto_workbench.json", import.meta.url), "utf8"));

  assert.deepEqual(template, source);
  const executionAdapters = template.connectors.filter((connector) =>
    ["python_analysis", "jupyter", "r_runtime"].includes(connector.id),
  );
  assert.equal(executionAdapters.length, 3);
  assert.ok(executionAdapters.every((connector) => connector.status === "sandbox_required"));
});

test("packaged offline scientific fixtures stay byte-identical to reviewed source fixtures", async () => {
  for (const name of ["europe_pmc_search.json", "crossref_search.json", "uniprot_search.json", "rhea_search.tsv"]) {
    const source = await readFile(new URL(`../../../tests/fixtures/${name}`, import.meta.url));
    const template = await readFile(new URL(`../runtime/workspace-template/tests/fixtures/${name}`, import.meta.url));
    assert.deepEqual(template, source, `${name} drifted from its reviewed source fixture`);
  }
});
