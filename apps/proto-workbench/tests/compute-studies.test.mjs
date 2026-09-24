import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { COMPUTE_STUDIES_IO_LIMITS, requestComputeStudies } from "../src/main/services/compute-studies.ts";

// These are deliberately synthetic format fixtures. They exercise retention,
// provenance and storage behavior; they are not evidence of scientific execution.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = join(repository, "build", "research-studies-tests");
await mkdir(fixtureRoot, { recursive: true });
const runRoot = await mkdtemp(join(fixtureRoot, "backend-regressions-"));
await writeFile(join(runRoot, "fixture-scope.json"), JSON.stringify({
  scope: "Synthetic format fixtures only; no computation or scientific validation performed.",
  createdAt: new Date().toISOString(),
}, null, 2));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
// The strict host parser deliberately uses null-prototype objects. Compare the
// JSON data crossing IPC, not its in-process prototype representation.
const jsonData = value => JSON.parse(JSON.stringify(value));
const runId = () => randomUUID().replaceAll("-", "");
const hasCode = code => error => error?.code === code;

async function workspace(name) {
  const root = join(runRoot, name);
  await mkdir(root, { recursive: true });
  const api = request => requestComputeStudies(root, request);
  return { root, api, database: join(root, "build", "compute-studies", "studies.sqlite") };
}
async function put(root, path, bytes) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
function fileRecord(name, path, bytes) {
  return { name, path, sha256: hash(bytes), size: bytes.length };
}
async function fixture(root, options = {}) {
  const id = options.id ?? runId();
  const prefix = `build/compute/${id}`;
  const sourcePath = `inputs/${id}.request.json`;
  const sources = options.sources ?? [];
  const request = { tool: "synthetic_retention_fixture", arguments: options.arguments ?? { alpha: 0.05, seed: 17 } };
  const input = encode(request);
  const result = encode(options.result ?? { estimate: 2.25, unavailable: null, supplied: "2.25", values: [0, false, ""] });
  const inputs = { request_snapshot: `${prefix}/input.json` };
  const materials = [fileRecord("input:request_snapshot", `${prefix}/input.json`, input)];
  for (const source of sources) {
    const bytes = Buffer.from(source.text ?? "synthetic source\n");
    await put(root, source.path, bytes);
    inputs[`file:${source.claim}`] = { path: source.path, sha256: hash(bytes) };
    materials.push(fileRecord(`input:file:${source.claim}`, source.path, bytes));
  }
  const manifest = {
    schema_version: "proto-agent.compute.v1", ok: true, run_id: id,
    tool: request.tool, created_at: "2026-09-22T00:00:00.000Z",
    implementation: "synthetic-format-fixture", implementation_version: 1,
    upstream_commit: null, method_references: [], upstream_functions: [],
    runtime: { fixture: "not-executed" }, review_status: "human_review_required",
    scope: "Synthetic format fixture; no scientific execution or validity claim.",
    source: { path: sourcePath, sha256: hash(input) }, inputs,
    artifacts: [`${prefix}/result.json`], result_sha256: hash(result),
    ...options.metadata,
  };
  const saved = { id, prefix, request, input, result, manifest, materials, sourcePath };
  await put(root, sourcePath, input);
  await publish(root, saved);
  return saved;
}
async function publish(root, saved) {
  const manifest = encode(saved.manifest);
  const provenance = {
    schema_version: "proto-agent.provenance.v1", created_at: "2026-09-22T00:00:00.000Z", run_id: saved.id,
    subject: fileRecord("manifest", `compute/${saved.id}/manifest.json`, manifest),
    materials: saved.materials,
    artifacts: [fileRecord("artifact:0", `compute/${saved.id}/result.json`, saved.result)],
    tool: { name: "synthetic-format-fixture", version: "1", python: "not-executed", platform: "fixture" },
    policy: { digest: "sha256", signature: "none", path_mode: "root-relative-single-link-regular-files-no-reparse-points" },
  };
  for (const [name, bytes] of [["input", saved.input], ["result", saved.result], ["manifest", manifest], ["provenance", encode(provenance)]]) {
    await put(root, `${saved.prefix}/${name}.json`, bytes);
  }
}
function databaseRead(path, sql, ...parameters) {
  const db = new DatabaseSync(path);
  try { return db.prepare(sql).all(...parameters); } finally { db.close(); }
}

test("unknown missing run IDs return unavailable without growing the discovery index", async () => {
  const { api, database } = await workspace("missing-identities");
  for (let index = 0; index < 4; index++) {
    const { run } = await api({ action: "open-run", runId: runId() });
    assert.equal(run.integrity.status, "unavailable");
    assert.equal(run.request, undefined);
    assert.equal(run.receipt, undefined);
  }
  assert.equal(databaseRead(database, "SELECT count(*) AS n FROM compute_study_runs")[0].n, 0);
});

test("a full discovery cache cannot prevent linking or reopening an independent project anchor", async () => {
  const { root, api, database } = await workspace("bounded-cache-independent-links");
  const { study: initial } = await api({ action: "create", name: "Cache boundary fixture", question: "Can a retained project outlive its cache?" });
  const db = new DatabaseSync(database);
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO compute_study_runs VALUES (?, ?)");
    for (let index = 1; index <= COMPUTE_STUDIES_IO_LIMITS.discoveredRuns; index++) {
      const id = index.toString(16).padStart(32, "0");
      insert.run(id, JSON.stringify({ runId: id, integrity: { status: "not-checked", code: "SEEDED_TEST_ROW", checkedAt: "2026-09-22T00:00:00.000Z", message: "Synthetic cache row", authority: "unsigned-local-artifacts" } }));
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  const saved = await fixture(root);
  const { study } = await api({ action: "link", studyId: initial.id, expectedRevision: 1, runId: saved.id });
  assert.equal(study.runCount, 1);
  assert.equal(databaseRead(database, "SELECT count(*) AS n FROM compute_study_runs")[0].n, COMPUTE_STUDIES_IO_LIMITS.discoveredRuns);
  assert.equal(databaseRead(database, "SELECT count(*) AS n FROM compute_study_runs WHERE run_id=?", saved.id)[0].n, 0);
  const { runs } = await api({ action: "runs", studyId: study.id });
  assert.equal(runs[0].runId, saved.id);
  assert.deepEqual(runs[0].binding, study.links[0].binding);
  assert.equal((await api({ action: "open-run", studyId: study.id, runId: saved.id })).run.integrity.status, "verified");
  const all = await api({ action: "runs" });
  assert.equal(all.page.discoveryTruncated, true);
  assert.equal(databaseRead(database, "SELECT count(*) AS n FROM compute_study_runs")[0].n, COMPUTE_STUDIES_IO_LIMITS.discoveredRuns);
});

test("discovery indexes at most thirty manifest labels per request and never verifies header-only fixtures", async () => {
  const { root, api, database } = await workspace("bounded-header-discovery");
  for (let index = 0; index < COMPUTE_STUDIES_IO_LIMITS.discoveryHeaders + 1; index++) {
    const id = runId();
    await put(root, `build/compute/${id}/manifest.json`, encode({ schema_version: "proto-agent.compute.v1", run_id: id, tool: "synthetic_header_only", created_at: `2026-09-22T00:00:${String(index).padStart(2, "0")}.000Z` }));
  }
  const first = await api({ action: "runs", limit: 30 });
  assert.equal(first.page.indexingPending, 1);
  assert.equal(first.runs.length, 30);
  assert.ok(first.runs.every(run => run.tool === "synthetic_header_only" && run.integrity.status === "not-checked"));
  const summaries = databaseRead(database, "SELECT summary FROM compute_study_runs").map(row => JSON.parse(row.summary));
  assert.equal(summaries.filter(row => row.tool).length, 30);
  assert.ok(summaries.every(row => row.integrity.status === "not-checked" && !row.request && !row.receipt));
  assert.ok(first.page.nextCursor);
  const second = await api({ action: "runs", limit: 30, cursor: first.page.nextCursor });
  assert.equal(second.page.indexingPending, 0);
  assert.equal(second.page.resetRequired, true, "new metadata invalidates the old ordering cursor");
  assert.equal((await api({ action: "open-run", runId: first.runs[0].runId })).run.integrity.status, "unavailable");
});

test("producer upstream function objects and historical metadata survive reopening", async () => {
  const { root, api } = await workspace("producer-metadata");
  const metadata = { implementation: "biomni-adapted", upstream_commit: "f".repeat(40), upstream_functions: [{ path: "biomni/tool/imaging.py", name: "measure_image" }, "legacy_function_label"], runtime: { python: "3.12.0", numpy: "2.0.0" }, method_references: ["Synthetic citation fixture"] };
  const saved = await fixture(root, { metadata });
  const { run } = await api({ action: "open-run", runId: saved.id });
  assert.equal(run.integrity.status, "verified");
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(jsonData(run.receipt[key]), value);
  assert.deepEqual(jsonData(run.request), saved.request);
  assert.deepEqual(jsonData(run.receipt.result), JSON.parse(saved.result));
  assert.equal(run.integrity.authority, "unsigned-local-artifacts");
  assert.equal(run.binding.manifestSha256, run.integrity.hashes.manifestSha256);
});

test("Windows request separators match canonical single and array file claims without rewriting saved input", async () => {
  const { root, api } = await workspace("windows-request-paths");
  const args = { file_path: "inputs\\one.csv", file_paths: ["inputs\\two.csv"] };
  const saved = await fixture(root, { arguments: args, sources: [{ claim: "file_path", path: "inputs/one.csv" }, { claim: "file_paths[0]", path: "inputs/two.csv" }] });
  const { run } = await api({ action: "open-run", runId: saved.id });
  assert.equal(run.integrity.status, "verified");
  assert.equal(run.sourceFreshness.status, "current");
  assert.deepEqual(jsonData(run.request.arguments), args);
  assert.equal(hash(await readFile(join(root, saved.prefix, "input.json"))), hash(saved.input));
});

test("path normalization does not legalize parent or dot segments in retained request arguments", async () => {
  const { root, api } = await workspace("invalid-request-path-segments");
  for (const spelling of ["inputs\\..\\inputs\\one.csv", ".\\inputs\\one.csv"]) {
    const saved = await fixture(root, { arguments: { file_path: spelling }, sources: [{ claim: "file_path", path: "inputs/one.csv" }] });
    const { run } = await api({ action: "open-run", runId: saved.id });
    assert.equal(run.integrity.status, "damaged");
    assert.equal(run.integrity.code, "UNSAFE_PATH");
    assert.equal(run.receipt, undefined);
  }
});

test("more than 128 producer file claims verify while original-source reads remain bounded to 64", async () => {
  const { root, api } = await workspace("large-claim-list-small-source-budget");
  const paths = Array.from({ length: 140 }, (_, index) => `inputs/source-${index}.csv`);
  const saved = await fixture(root, { arguments: { file_paths: paths }, sources: paths.map((path, index) => ({ claim: `file_paths[${index}]`, path, text: `${index}\n` })) });
  const { run } = await api({ action: "open-run", runId: saved.id });
  assert.equal(run.integrity.status, "verified");
  assert.equal(run.sourceFreshness.status, "not-checked");
  assert.equal(run.sourceFreshness.details.length, 141);
  assert.equal(run.sourceFreshness.details.filter(detail => detail.status === "current").length, COMPUTE_STUDIES_IO_LIMITS.sourceFiles);
  assert.equal(run.sourceFreshness.details.filter(detail => detail.status === "not-checked").length, 141 - COMPUTE_STUDIES_IO_LIMITS.sourceFiles);
  assert.ok(run.sourceFreshness.details.slice(64).every(detail => detail.code === "SOURCE_BUDGET" && detail.actualSha256 === undefined));
  assert.deepEqual(run.request.arguments.file_paths, paths);
});

test("coordinated self-consistent bundle rewriting cannot silently replace a linked project result", async () => {
  const { root, api } = await workspace("immutable-project-anchor");
  const saved = await fixture(root);
  const { study: initial } = await api({ action: "create", name: "Pinned fixture", question: "Which exact bytes were reviewed?" });
  const { study: linked } = await api({ action: "link", studyId: initial.id, expectedRevision: 1, runId: saved.id });
  const anchor = structuredClone(linked.links[0].binding);
  saved.result = encode({ estimate: 999 });
  saved.manifest.result_sha256 = hash(saved.result);
  await publish(root, saved);
  const unbound = (await api({ action: "open-run", runId: saved.id })).run;
  assert.equal(unbound.integrity.status, "verified", "unsigned self-consistency alone is insufficient to retain the project identity");
  assert.equal(unbound.receipt.result.estimate, 999);
  const anchored = (await api({ action: "open-run", runId: saved.id, studyId: linked.id })).run;
  assert.equal(anchored.integrity.code, "LINK_ANCHOR_CHANGED");
  assert.equal(anchored.integrity.status, "damaged");
  assert.equal(anchored.request, undefined);
  assert.equal(anchored.receipt, undefined);
  assert.deepEqual(anchored.binding, anchor);
  assert.deepEqual((await api({ action: "get", studyId: linked.id })).study, linked);
  await assert.rejects(api({ action: "link", studyId: linked.id, expectedRevision: 2, runId: saved.id }), hasCode("ALREADY_LINKED"));
  assert.deepEqual((await api({ action: "get", studyId: linked.id })).study.links[0].binding, anchor);
});

test("revision compare-and-swap retains the winning edit and complete immutable link history", async () => {
  const { root, api } = await workspace("revision-history");
  const saved = await fixture(root);
  const { study: initial } = await api({ action: "create", name: "Original", question: "Original question" });
  const attempts = await Promise.allSettled(["One", "Two"].map(name => api({ action: "update", studyId: initial.id, expectedRevision: 1, name, question: `Question ${name}` })));
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(attempts.find(item => item.status === "rejected").reason.code, "REVISION_CONFLICT");
  const winner = attempts.find(item => item.status === "fulfilled").value.study;
  assert.equal(winner.revision, 2);
  const { study: linked } = await api({ action: "link", studyId: initial.id, expectedRevision: 2, runId: saved.id });
  const { study: unlinked } = await api({ action: "unlink", studyId: initial.id, expectedRevision: 3, runId: saved.id });
  assert.equal(unlinked.revision, 4);
  assert.equal(unlinked.runCount, 0);
  assert.deepEqual(unlinked.links, []);
  assert.deepEqual(unlinked.history.map(event => event.action), ["create", "update", "link", "unlink"]);
  assert.deepEqual(unlinked.history[0], initial.history[0]);
  assert.deepEqual(unlinked.history[2].binding, linked.links[0].binding);
  assert.deepEqual(unlinked.history[3].binding, linked.links[0].binding);
  await assert.rejects(api({ action: "open-run", studyId: initial.id, runId: saved.id }), hasCode("RUN_NOT_LINKED"));
  assert.deepEqual((await api({ action: "get", studyId: initial.id })).study, unlinked);
});

test("study cursors reject other databases, scopes and page sizes and request reset after mutation", async () => {
  const first = await workspace("cursor-first-workspace");
  const other = await workspace("cursor-other-workspace");
  for (const name of ["One", "Two", "Three"]) await first.api({ action: "create", name, question: "Cursor fixture" });
  const page = await first.api({ action: "list", limit: 1 });
  assert.ok(page.page.nextCursor);
  const next = await first.api({ action: "list", limit: 1, cursor: page.page.nextCursor });
  assert.equal(next.studies.length, 1);
  assert.notEqual(next.studies[0].id, page.studies[0].id);
  await assert.rejects(other.api({ action: "list", limit: 1, cursor: page.page.nextCursor }), hasCode("INVALID_CURSOR"));
  await assert.rejects(first.api({ action: "list", limit: 2, cursor: page.page.nextCursor }), hasCode("INVALID_CURSOR"));
  await assert.rejects(first.api({ action: "runs", limit: 1, cursor: page.page.nextCursor }), hasCode("INVALID_CURSOR"));
  await first.api({ action: "create", name: "Four", question: "Changed generation" });
  const stale = await first.api({ action: "list", limit: 1, cursor: page.page.nextCursor });
  assert.equal(stale.page.resetRequired, true);
  assert.deepEqual(stale.studies, []);
  assert.equal(stale.page.nextCursor, null);
});

test("damaged study payloads fail explicitly without repair or loss of the original row", async () => {
  const { api, database } = await workspace("preserved-corrupt-study");
  const { study } = await api({ action: "create", name: "Original row", question: "Retain corruption evidence" });
  for (const payload of ["{broken-json", JSON.stringify({ ...study, revision: 7 }), JSON.stringify({ ...study, history: [] })]) {
    const db = new DatabaseSync(database);
    try { db.prepare("UPDATE compute_studies SET payload=? WHERE id=?").run(payload, study.id); } finally { db.close(); }
    const before = databaseRead(database, "SELECT * FROM compute_studies WHERE id=?", study.id);
    await assert.rejects(api({ action: "get", studyId: study.id }), hasCode("STUDY_DAMAGED"));
    await assert.rejects(api({ action: "update", studyId: study.id, expectedRevision: 1, name: "Overwrite", question: "Must fail" }), hasCode("STUDY_DAMAGED"));
    assert.deepEqual(databaseRead(database, "SELECT * FROM compute_studies WHERE id=?", study.id), before);
  }
});

test("unsafe integers and duplicate JSON keys are rejected even when all stored hashes agree", async () => {
  const { root, api } = await workspace("strict-retained-json");
  for (const [json, code] of [["{\"count\":9007199254740993}\n", "UNSAFE_JSON_INTEGER"], ["{\"estimate\":1,\"estimate\":2}\n", "DUPLICATE_JSON_KEY"]]) {
    const saved = await fixture(root);
    saved.result = Buffer.from(json);
    saved.manifest.result_sha256 = hash(saved.result);
    await publish(root, saved);
    const { run } = await api({ action: "open-run", runId: saved.id });
    assert.equal(run.integrity.status, "damaged");
    assert.equal(run.integrity.code, code);
    assert.equal(run.receipt, undefined);
  }
});
