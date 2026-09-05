import test from "node:test";
import assert from "node:assert/strict";
import {verifyArtifactReport} from "../src/main/services/harness-artifact-report.ts";

const a = {path: "build/runs/one/manifest.json", sha256: "a".repeat(64), aliases: ["C:\\workspace\\build\\runs\\one\\manifest.json"]};
const b = {path: "build/runs/one/provenance.json", sha256: "b".repeat(64)};
const required = {minimumRecords: 2, requiredPaths: [a.path, b.path]};
const table = rows => "| Path | SHA-256 |\n|---|---|\n" + rows.map(row => `| ${row.path} | ${row.sha256} |`).join("\n");

test("actual path and full digest bind in individual saved Markdown rows", () => {
  assert.deepEqual(verifyArtifactReport([a, b], [table([a, b])], required), []);
});

test("digest swaps cannot be satisfied by global membership elsewhere in a report", () => {
  const errors = verifyArtifactReport([a, b], [table([{...a, sha256: b.sha256}, {...b, sha256: a.sha256}])], required);
  assert.ok(errors.some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH" && error.path === a.path));
  assert.ok(errors.some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH" && error.path === b.path));
});

test("a malformed copied digest fails even if another saved document is correct", () => {
  assert.ok(verifyArtifactReport([a], [table([a]), table([{...a, sha256: a.sha256.slice(0, 62)}])], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH"));
});

test("explicit absolute aliases and Windows separators match only that exact artifact", () => {
  assert.deepEqual(verifyArtifactReport([a], [table([{...a, path: a.aliases[0].toUpperCase(), sha256: a.sha256.toUpperCase()}])], {minimumRecords: 1}), []);
  assert.ok(verifyArtifactReport([a], [table([{...a, path: "manifest.json"}])], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_PATH_UNKNOWN"));
  assert.ok(verifyArtifactReport([a], [table([{...a, path: "C:/elsewhere/build/runs/one/manifest.json"}])], {minimumRecords: 1}).length);
});

test("JSON ordering and escaped Windows aliases retain per-object association", () => {
  const report = JSON.stringify([{sha256: a.sha256, path: a.aliases[0]}, {sha256: b.sha256, path: b.path}], null, 2);
  assert.deepEqual(verifyArtifactReport([a, b], [report], required), []);
});

test("parent JSON containers cannot pool hashes from unrelated child records", () => {
  const report = JSON.stringify({records: [{path: a.path, sha256: b.sha256}, {path: b.path, sha256: a.sha256}]});
  assert.ok(verifyArtifactReport([a, b], [report], required).some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH"));
});

test("one-artifact prose sections retain exact paths and full hashes", () => {
  const report = [a, b].map(record => `### ${record.path}\nSHA256: ${record.sha256}`).join("\n\n");
  assert.deepEqual(verifyArtifactReport([a, b], [report], required), []);
});

test("required paths and distinct counts cannot be met by duplicate references", () => {
  const errors = verifyArtifactReport([a, b], [table([a, a])], required);
  assert.ok(errors.some(error => error.path === b.path && error.code === "ARTIFACT_REPORT_MISSING"));
  assert.ok(errors.some(error => error.message.includes("2 current")));
});

test("unknown additional explicit artifact paths remain failures alongside valid rows", () => {
  assert.ok(verifyArtifactReport([a, b], [table([a, b, {path: "build/fabricated.json", sha256: "f".repeat(64)}])], required).some(error => error.code === "ARTIFACT_REPORT_PATH_UNKNOWN"));
});

test("ambiguous receipts and ambiguous path aliases cannot pass", () => {
  assert.ok(verifyArtifactReport([a, {...a, sha256: b.sha256}], [table([a])], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_CONFLICT"));
  assert.ok(verifyArtifactReport([a, {...b, aliases: [a.path]}], [table([a, b])], required).some(error => error.code === "ARTIFACT_REPORT_CONFLICT"));
});

test("short, nonhex, empty and suffixed table claims remain failures beside a correct document", () => {
  for (const sha256 of ["deadbeef", "not-a-digest", "", "0", "g".repeat(64), a.sha256 + " extra", a.sha256.slice(1), a.sha256 + "0"]) {
    const errors = verifyArtifactReport([a], [table([a]), table([{...a, sha256}])], {minimumRecords: 1});
    assert.ok(errors.some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH"), JSON.stringify(sha256));
  }
});

test("JSON hash claims preserve their types and cannot borrow a valid notes value", () => {
  for (const sha256 of [null, false, 123, {}, [], {example: a.sha256}, [a.sha256], "not-a-digest", ""]) {
    const bad = JSON.stringify({path: a.path, sha256, notes: a.sha256});
    assert.ok(verifyArtifactReport([a], [JSON.stringify(a), bad], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH"), JSON.stringify(sha256));
  }
});

test("nested wrong hash and correct example cannot satisfy a parent artifact claim", () => {
  const report = JSON.stringify({path: a.path, metadata: {sha256: b.sha256}, unrelated_example: {sha256: a.sha256}});
  assert.ok(verifyArtifactReport([a], [report], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_MISSING"));
  assert.ok(verifyArtifactReport([a], [JSON.stringify(a), report], {minimumRecords: 1}).length);
  assert.deepEqual(verifyArtifactReport([a], [JSON.stringify({metadata: {path: a.path, sha256: a.sha256}})], {minimumRecords: 1}), []);
});

test("unlabelled correct digest text cannot stand in for an actual artifact hash field", () => {
  for (const report of [JSON.stringify({path: a.path, notes: a.sha256}), `### ${a.path}\nExample: ${a.sha256}`, `| Path | Notes |\n|---|---|\n| ${a.path} | ${a.sha256} |`]) {
    assert.ok(verifyArtifactReport([a], [report], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_MISSING"));
  }
});

test("labeled prose checks the whole value including empty or malformed duplicate claims", () => {
  for (const sha256 of ["not-a-digest", "deadbeef", "", `prefix ${a.sha256}`, `${a.sha256} suffix`]) {
    const report = `### ${a.path}\nSHA-256: ${sha256}\nUnrelated example: ${a.sha256}`;
    assert.ok(verifyArtifactReport([a], [table([a]), report], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH"), sha256);
  }
  assert.deepEqual(verifyArtifactReport([a], [`- **Path**: \`${a.aliases[0]}\`\n- **SHA-256**: \`${a.sha256.toUpperCase()}\``], {minimumRecords: 1}), []);
});

test("named manifest and provenance pairs bind independently within one JSON object or table row", () => {
  const object = {manifest_path: a.path, manifest_sha256: a.sha256, provenance_path: b.path, provenance_sha256: b.sha256};
  assert.deepEqual(verifyArtifactReport([a, b], [JSON.stringify(object)], required), []);
  const namedTable = `| Manifest path | Manifest SHA256 | Provenance path | Provenance SHA256 |\n|---|---|---|---|\n| ${a.path} | ${a.sha256} | ${b.path} | ${b.sha256} |`;
  assert.deepEqual(verifyArtifactReport([a, b], [namedTable], required), []);
  assert.ok(verifyArtifactReport([a, b], [JSON.stringify({...object, provenance_sha256: a.sha256})], required).some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH" && error.path === b.path));
  assert.ok(verifyArtifactReport([a, b], [JSON.stringify({manifest_path: a.path, provenance_path: b.path, sha256: a.sha256})], required).some(error => error.code === "ARTIFACT_REPORT_CONFLICT"));
});

test("later invalid prose claims are checked without truncating a long section", () => {
  const report = `### ${a.path}\nSHA256: ${a.sha256}\n${"padding ".repeat(5000)}\nSHA256: nope`;
  assert.ok(verifyArtifactReport([a], [report], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH"));
});

test("structured record bounds fail closed instead of accepting only the visited prefix", () => {
  const report = JSON.stringify([a, ...Array.from({length: 20_001}, () => ({note: "bounded fixture"}))]);
  assert.ok(verifyArtifactReport([a], [report], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_LIMIT"));
});

test("duplicate JSON hash properties cannot hide an earlier malformed claim", () => {
  const report = `{"path":${JSON.stringify(a.path)},"sha256":"not-a-digest","sha256":"${a.sha256}"}`;
  assert.ok(verifyArtifactReport([a], [report], {minimumRecords: 1}).length);
});

test("whole-report JSON fences retain typed claims and reject concealed duplicate keys", () => {
  const fence = text => `\`\`\`json\n${text}\n\`\`\``;
  assert.deepEqual(verifyArtifactReport([a, b], [fence(JSON.stringify([a, b], null, 2))], required), []);
  const duplicate = `{"path":${JSON.stringify(a.path)},"sha256":"wrong","sha256":"${a.sha256}"}`;
  assert.ok(verifyArtifactReport([a], [fence(duplicate)], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_CONFLICT"));
  assert.ok(verifyArtifactReport([a], [fence(JSON.stringify({path: a.path, notes: a.sha256}))], {minimumRecords: 1}).length);
});

test("formatting may include the label colon without relaxing the entire hash claim", () => {
  for (const marker of ["**", "__", "`"]) {
    const prose = `${marker}Path:${marker} \`${a.path}\`\n${marker}SHA256:${marker} \`${a.sha256}\``;
    assert.deepEqual(verifyArtifactReport([a], [prose], {minimumRecords: 1}), []);
    assert.ok(verifyArtifactReport([a], [table([a]), prose.replace(a.sha256, "deadbeef")], {minimumRecords: 1}).some(error => error.code === "ARTIFACT_REPORT_HASH_MISMATCH"));
  }
});

test("mixed prose and two embedded JSON fences keep each typed artifact record", () => {
  const report = `Verified software outputs follow.\n\n\`\`\`json\n${JSON.stringify(a)}\n\`\`\`\n\nThe second output retains its own provenance.\n\n\`\`\`json\n${JSON.stringify({metadata: b})}\n\`\`\`\n\nHuman review remains required.`;
  assert.deepEqual(verifyArtifactReport([a, b], [report], required), []);
});

test("an embedded malformed duplicate claim fails beside another correct fence", () => {
  for (const sha256 of ["not-a-digest", "", 23, null, {example: a.sha256}]) {
    const report = `Current report:\n\`\`\`json\n${JSON.stringify(a)}\n\`\`\`\nA second asserted copy:\n\`\`\`json\n${JSON.stringify({path: a.path, sha256})}\n\`\`\``;
    assert.ok(verifyArtifactReport([a], [report], {minimumRecords: 1}).some(item => item.code === "ARTIFACT_REPORT_HASH_MISMATCH"), JSON.stringify(sha256));
  }
  const duplicate = `{"path":${JSON.stringify(a.path)},"sha256":"wrong","sha256":"${a.sha256}"}`;
  assert.ok(verifyArtifactReport([a], [`Notes\n\`\`\`json\n${duplicate}\n\`\`\`\nEnd.`], {minimumRecords: 1}).some(item => item.code === "ARTIFACT_REPORT_CONFLICT"));
});

test("malformed nested JSON syntax cannot disappear beside a valid embedded report", () => {
  const good = `\`\`\`json\n${JSON.stringify(a)}\n\`\`\``;
  const malformed = `{"path":${JSON.stringify(a.path)},"metadata":{"sha256": }}`;
  const errors = verifyArtifactReport([a], [`Report:\n${good}\nBad copy:\n\`\`\`json\n${malformed}\n\`\`\`\nEnd.`], {minimumRecords: 1});
  assert.ok(errors.some(item => item.code === "ARTIFACT_REPORT_CONFLICT"));
});

test("prose on opposite sides of an embedded fence cannot pool a path and digest", () => {
  const report = `### ${a.path}\n\`\`\`json\n{"note":"a separate object"}\n\`\`\`\nSHA256: ${a.sha256}`;
  assert.ok(verifyArtifactReport([a], [report], {minimumRecords: 1}).some(item => item.code === "ARTIFACT_REPORT_MISSING"));
});
