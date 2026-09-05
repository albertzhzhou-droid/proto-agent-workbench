import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {join, resolve, dirname} from "node:path";
import test from "node:test";
import {WorkspaceFiles} from "../src/main/services/workspace-files.ts";

test("large IR views retain bounded contained reads without expanding editable text limits", async t => {
  const parent = resolve("build"); await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, "ir-read-test-"));
  t.after(async () => {assert.equal(dirname(root), parent); assert(root.startsWith(join(parent, "ir-read-test-"))); await rm(root, {recursive: true, force: true});});
  await mkdir(join(root, "build"));
  const files = new WorkspaceFiles(root, {});
  const content = JSON.stringify({sequence: "A".repeat(3 * 1024 * 1024)});
  await writeFile(join(root, "build", "large.ir.json"), content);
  const actual = await files.read("build/large.ir.json");
  assert.equal(actual.content.length, content.length);
  assert.equal(actual.sha256, createHash("sha256").update(content).digest("hex"));
  await writeFile(join(root, "build", "large.txt"), content);
  await assert.rejects(files.read("build/large.txt"), /bounded/);
  await writeFile(join(root, "outside-build.ir.json"), content);
  await assert.rejects(files.read("outside-build.ir.json"), /bounded/);
  await writeFile(join(root, "build", "oversized.ir.json"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  await assert.rejects(files.read("build/oversized.ir.json"), /bounded/);
  await assert.rejects(files.proposePatch({runId: "scope-test", targetPath: "build/large.ir.json", after: "{}", rationale: "test"}), /2 MiB text review limit/);
});
