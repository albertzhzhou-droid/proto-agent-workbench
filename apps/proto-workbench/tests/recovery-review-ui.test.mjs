import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("Reviews exposes durable patch operation, checkpoint, and recovery actions", async () => {
  const pages = await readFile(resolve("src", "renderer", "OperationalPages.tsx"), "utf8");

  assert.match(pages, /activePatchOperation \?\? runDetail\?\.patchOperations\[0\]/);
  assert.match(pages, /checkpoints\.find\(\(candidate\) => candidate\.id === operation\.checkpointId\)/);
  assert.match(pages, /aria-label="Durable patch transaction status"/);
  assert.match(pages, /aria-current=\{step\.state === "current" \? "step" : undefined\}/);
  assert.match(pages, /Reconcile file effect/);
  assert.match(pages, /Resume validation/);
  assert.match(pages, /Prepare restore diff/);
  assert.match(pages, /openFile\(operation\.targetPath\)/);
  assert.match(pages, /Base \$\{operation\.baseExists/);
  assert.match(pages, /result \$\{operation\.resultExists/);
});

test("Reviews gives applying and recoverable runs concise list badges", async () => {
  const pages = await readFile(resolve("src", "renderer", "OperationalPages.tsx"), "utf8");

  assert.match(pages, /state === "applying-patch"[\s\S]*?\? "Applying"/);
  assert.match(pages, /state === "validating"[\s\S]*?\? "Validate"/);
  assert.match(pages, /state === "interrupted" && run\.lifecycle\.attention === "recovery"[\s\S]*?\? "Recover"/);
  assert.match(pages, /attention === "patch-operation" \? "validation" : run\.lifecycle\.attention/);
});
