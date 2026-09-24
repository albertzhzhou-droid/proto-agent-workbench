import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { researchPreviewDatabase } from "../src/dev/research-preview-database.ts";

test("isolated preview DB stays under build and preserves existing bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "proto-preview-db-"));
  assert.equal(researchPreviewDatabase(root), resolve(root, "build/chat-preview/conversations.sqlite"));
  const expected = researchPreviewDatabase(root, "build/acceptance/conversations.sqlite");
  writeFileSync(expected, "retained fixture bytes");
  assert.equal(researchPreviewDatabase(root, expected), expected);
  assert.equal(readFileSync(expected, "utf8"), "retained fixture bytes");
  for (const path of ["../outside.sqlite", "data.sqlite", "build", "build/log.txt", "build/../outside.sqlite"]) {
    assert.throws(() => researchPreviewDatabase(root, path), /inside this workspace/);
  }
  mkdirSync(join(root, "build/directory.sqlite"));
  assert.throws(() => researchPreviewDatabase(root, "build/directory.sqlite"), /regular file/);
});

test("isolated preview DB rejects a parent junction instead of writing through it", () => {
  const root = mkdtempSync(join(tmpdir(), "proto-preview-db-link-"));
  const outside = mkdtempSync(join(tmpdir(), "proto-preview-db-target-"));
  mkdirSync(join(root, "build"));
  symlinkSync(outside, join(root, "build/linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => researchPreviewDatabase(root, "build/linked/conversations.sqlite"), /regular workspace directories/);
});
