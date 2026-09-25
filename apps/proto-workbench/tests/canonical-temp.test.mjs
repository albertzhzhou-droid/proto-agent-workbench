import assert from "node:assert/strict";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { canonicalMkdtemp } from "./helpers/canonical-temp.mjs";
import { assertDisposableWorkspace, DISPOSABLE_WORKSPACE_MARKER, OwnedProcessError } from "../scripts/owned-process.mjs";

test("new test fixtures canonicalize a temp alias while runtime still rejects the aliased path", async t => {
  const root = await canonicalMkdtemp(join(tmpdir(), "proto-canonical-temp-"));
  t.after(async () => {
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.ok(basename(root).startsWith("proto-canonical-temp-"));
    await rm(root, { recursive: true, force: true });
  });
  const target = join(root, "actual-temp"), alias = join(root, "temp-alias");
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  const workspace = await canonicalMkdtemp(join(alias, "owned-fixture-"));
  assert.equal(workspace, await realpath(workspace));
  assert.equal(dirname(workspace), resolve(target));
  await writeFile(join(workspace, ".proto-agent-disposable-workspace"), DISPOSABLE_WORKSPACE_MARKER);
  const aliasedWorkspace = join(alias, basename(workspace));
  await assert.rejects(assertDisposableWorkspace(aliasedWorkspace, []),
    error => error instanceof OwnedProcessError && error.code === "UNSAFE_DIRECTORY");
  assert.equal(await assertDisposableWorkspace(workspace, []), workspace);
});
