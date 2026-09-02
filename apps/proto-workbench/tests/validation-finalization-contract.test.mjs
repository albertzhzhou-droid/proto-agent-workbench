import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");

test("patch validation is single-flight and rechecks the reviewed target before verification", () => {
  assert.match(mainSource, /validationOperationsInFlight\.has\(operation\.id\)/);
  assert.match(mainSource, /workspaceFiles\.assertOperationResultCurrent\(validating\.id\)/);
  const verifyFunction = mainSource.slice(mainSource.indexOf("async function validatePatchOperation"));
  const observeIndex = verifyFunction.indexOf("assertOperationResultCurrent(validating.id)");
  const finishIndex = verifyFunction.indexOf("database.finishPatchValidation(");
  assert.ok(observeIndex >= 0 && finishIndex > observeIndex, "target digest observation must precede verified transition");
  assert.match(verifyFunction, /current\.state !== "validating" \|\| current\.revision !== validating\.revision/);
});

test("a live validation attempt cannot be reconciled through IPC", () => {
  assert.match(
    mainSource,
    /operation\.state === "validating" \|\| validationOperationsInFlight\.has\(operation\.id\)/,
  );
  assert.match(mainSource, /Wait for the active validation attempt to finish before reconciling/);
});
