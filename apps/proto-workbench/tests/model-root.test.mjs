import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveModelLibraryRoot } from "../src/main/services/model-root.ts";

test("selecting an LM Studio root resolves its models child without reading LM Studio configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "proto-workbench-model-root-"));
  const models = join(root, "models");
  await mkdir(models);
  try {
    assert.equal(await resolveModelLibraryRoot(root), models);
    assert.equal(await resolveModelLibraryRoot(models), models);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing model root fails before starting the scanner sidecar", async () => {
  const root = join(tmpdir(), `proto-workbench-missing-${crypto.randomUUID()}`);
  await assert.rejects(resolveModelLibraryRoot(root), /does not exist/);
});
