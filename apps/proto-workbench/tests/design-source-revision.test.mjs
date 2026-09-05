import test from "node:test";
import assert from "node:assert/strict";
import {committedDesignArtifact} from "../src/renderer/design-source-revision.ts";
import {groupDesignArtifacts, designArtifactHasPath} from "../src/renderer/design-inventory.ts";

const current = {path: "C:/workspace/build/runs/new/edit.ir.json", relativePath: "build/runs/new/edit.ir.json", status: "ready", digestBinding: {status: "match"}, design: {sourceSha256: "new-source", partsSha256: "bound-parts", constructs: [{name: "first"}, {name: "edited"}]}};
const receipt = {ok: true, candidate_sha256: "new-source", parts_sha256: "bound-parts", artifact_paths: ["build\\runs\\new\\edit.ir.json"]};

test("refresh follows the committed source and library instead of the older open artifact", () => {
  const old = {...current, path: "C:/workspace/build/old.ir.json", relativePath: "build/old.ir.json", design: {...current.design, sourceSha256: "old-source"}};
  assert.equal(committedDesignArtifact([old, current], receipt, "edited"), current);
  assert.equal(committedDesignArtifact([current, old], receipt, "edited"), current);
});

test("refresh never switches to an unrelated, stale or invalid compilation", () => {
  for (const artifact of [
    {...current, status: "invalid"},
    {...current, digestBinding: {status: "mismatch"}},
    {...current, design: {...current.design, sourceSha256: "old-source"}},
    {...current, design: {...current.design, partsSha256: "another-library"}},
    {...current, path: "C:/elsewhere/unrelated.ir.json", relativePath: "build/unrelated.ir.json"},
  ]) assert.equal(committedDesignArtifact([artifact], receipt, "edited"), undefined);
  assert.equal(committedDesignArtifact([current], {...receipt, ok: false}, "edited"), undefined);
  assert.equal(committedDesignArtifact([current], receipt, "missing"), undefined);
});

test("redo selects its exact bytes through a stronger provenance representative without jumping to protein", () => {
  const firstReverse = {...current, modifiedAt: "2026-09-05T01:38:33Z", sha256: "reverse-bytes"};
  const redo = {...firstReverse, path: "C:/workspace/build/redo/edit.ir.json", relativePath: "build/redo/edit.ir.json", modifiedAt: "2026-09-05T01:38:57Z", digestBinding: undefined};
  const undo = {...firstReverse, path: "C:/workspace/build/undo/edit.ir.json", relativePath: "build/undo/edit.ir.json", sha256: "undo-bytes", design: {...firstReverse.design, sourceSha256: "undo-source"}};
  const protein = {...firstReverse, path: "C:/workspace/build/protein.ir.json", relativePath: "build/protein.ir.json", sha256: "protein-bytes", design: {sourceSha256: "protein-source", partsSha256: "proteins", constructs: [{name: "protein"}]}};
  const beforeRedo = groupDesignArtifacts([protein, undo, firstReverse]);
  assert.equal(committedDesignArtifact(beforeRedo, {...receipt, candidate_sha256: "undo-source", artifact_paths: [undo.relativePath]}, "edited")?.path, undo.path);
  const afterRedo = groupDesignArtifacts([protein, redo, undo, firstReverse]);
  const selected = committedDesignArtifact(afterRedo, {...receipt, artifact_paths: [redo.relativePath]}, "edited");
  assert.equal(selected?.path, firstReverse.path);
  assert.equal(selected?.sha256, redo.sha256);
  assert.equal(selected?.copyCount, 2);
  assert.equal(designArtifactHasPath(selected, redo.path), true);
  assert.equal(designArtifactHasPath(selected, undo.path), false);
});

test("an invalid or digest-mismatched output never contributes a trusted alias", () => {
  const good = {...current, modifiedAt: "2026-09-05T01:38:33Z", sha256: "same-bytes"};
  for (const bad of [{status: "invalid"}, {digestBinding: {status: "mismatch"}}]) {
    const output = {...good, ...bad, path: "C:/workspace/build/rejected.ir.json", relativePath: "build/rejected.ir.json"};
    const grouped = groupDesignArtifacts([good, output]);
    assert.equal(committedDesignArtifact(grouped, {...receipt, artifact_paths: [output.relativePath]}, "edited"), undefined);
    assert.equal(designArtifactHasPath(grouped[0], output.path), false);
  }
});
