import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { validateSelectedAttachments } from "../src/main/services/attachment-validation.ts";

test("workspace references are validated without a native picker grant", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-workbench-attachment-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "goal.md");
  await writeFile(path, "reviewable goal", "utf8");
  const requested = { path, name: "spoofed.txt", mediaType: "application/octet-stream", sizeBytes: 1 };

  const result = await validateSelectedAttachments(
    [requested],
    new Map(),
    async (candidate) => {
      assert.equal(candidate, path);
      return path;
    },
    () => "text/markdown",
  );

  assert.equal(result.attachments[0].name, basename(path));
  assert.equal(result.attachments[0].mediaType, "text/markdown");
  assert.equal(result.attachments[0].sizeBytes, 15);
  assert.deepEqual(result.consumedGrantPaths, []);
});

test("picker grants are reported for consumption only after validation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-workbench-grant-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "evidence.pdf");
  await writeFile(path, "fixture", "utf8");
  const attachment = { path, name: "evidence.pdf", mediaType: "application/pdf", sizeBytes: 7 };
  const grants = new Map([[path, { attachment, expiresAt: Date.now() + 60_000 }]]);

  const result = await validateSelectedAttachments(
    [attachment],
    grants,
    async () => { throw new Error("outside workspace"); },
    () => "application/octet-stream",
  );

  assert.deepEqual(result.attachments, [attachment]);
  assert.deepEqual(result.consumedGrantPaths, [path]);
  assert.equal(grants.has(path), true, "validation must not consume the grant before send is accepted");
});

test("an expired external picker grant fails closed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-workbench-expired-grant-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "evidence.pdf");
  await writeFile(path, "fixture", "utf8");
  const attachment = { path, name: "evidence.pdf", mediaType: "application/pdf", sizeBytes: 7 };

  await assert.rejects(
    validateSelectedAttachments(
      [attachment],
      new Map([[path, { attachment, expiresAt: 1 }]]),
      async () => { throw new Error("outside workspace"); },
      () => "application/pdf",
      2,
    ),
    /not granted/,
  );
});
