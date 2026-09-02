import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MANAGED_SKILL_ROOT,
  syncWorkspaceTemplate,
  verifyWorkspaceTemplate,
} from "../scripts/workspace-template-sync.mjs";

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

test("packaged workspace template exactly matches the current governed sources", async () => {
  const report = await verifyWorkspaceTemplate();
  assert.ok(report.fileCount >= 3);
  assert.ok(report.skillFileCount >= 1);
  assert.ok(report.files.some((file) => file.path === "connectors/proto_workbench.json"));
  assert.ok(report.files.some((file) => file.path === "workflows/design_review.json"));
  assert.ok(
    report.files.some((file) => file.path === `${MANAGED_SKILL_ROOT}/proto-science-workflow/references/acceptance.md`),
    "nested Skill references must be packaged",
  );
  assert.ok(report.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test("synchronization replaces stale Skill trees, removes extras, and detects later drift", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-template-sync-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const templateRoot = join(root, "template");

  await write(join(repositoryRoot, "connectors", "proto_workbench.json"), "{\"source\":true}\n");
  await write(join(repositoryRoot, "workflows", "design_review.json"), "{\"workflow\":1}\n");
  await write(join(repositoryRoot, ".codex", "skills", "alpha", "SKILL.md"), "# Alpha\n");
  await write(join(repositoryRoot, ".codex", "skills", "alpha", "references", "guide.md"), "guide\n");
  await write(join(templateRoot, "connectors", "proto_workbench.json"), "{}\n");
  await write(join(templateRoot, "workflows", "design_review.json"), "{}\n");
  await write(join(templateRoot, ".codex", "skills", "obsolete", "SKILL.md"), "stale\n");

  const report = await syncWorkspaceTemplate({ repositoryRoot, templateRoot });
  assert.equal(report.fileCount, 4);
  assert.equal(report.skillFileCount, 2);
  assert.equal(
    await readFile(join(templateRoot, ".codex", "skills", "alpha", "references", "guide.md"), "utf8"),
    "guide\n",
  );
  await assert.rejects(
    readFile(join(templateRoot, ".codex", "skills", "obsolete", "SKILL.md"), "utf8"),
    /ENOENT/,
  );

  await write(join(templateRoot, ".codex", "skills", "alpha", "SKILL.md"), "drifted\n");
  await assert.rejects(
    verifyWorkspaceTemplate({ repositoryRoot, templateRoot }),
    /alpha\/SKILL\.md hash mismatch/,
  );
});
