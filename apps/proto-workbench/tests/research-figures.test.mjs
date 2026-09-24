import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { requestComputeStudies } from "../src/main/services/compute-studies.ts";
import { requestResearchFigures } from "../src/main/services/research-figures.ts";

// Synthetic persisted format fixtures and a fake renderer exercise host storage,
// integrity and race behavior. These are NOT scientific or real renderer acceptance.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidence = join(repository, "build", "research-figures-20260922");
await mkdir(evidence, { recursive: true });
const runRoot = await mkdtemp(join(evidence, "host-regressions-"));
await writeFile(join(runRoot, "fixture-scope.json"), JSON.stringify({ scope: "Synthetic retained Compute bundles and fake-renderer service tests; no scientific execution or renderer acceptance.", createdAt: new Date().toISOString() }, null, 2));
const hash = value => createHash("sha256").update(value).digest("hex");
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const jsonData = value => JSON.parse(JSON.stringify(value));
const id = () => randomUUID().replaceAll("-", "");
const hasCode = expected => error => error?.code === expected;

async function put(root, path, bytes) { const full = join(root, ...path.split("/")); await mkdir(dirname(full), { recursive: true }); await writeFile(full, bytes); }
const fileRecord = (name, path, bytes) => ({ name, path, sha256: hash(bytes), size: bytes.length });
function sql(path, query, ...parameters) { const db = new DatabaseSync(path); try { return db.prepare(query).all(...parameters); } finally { db.close(); } }
async function publish(root, saved) {
  const manifest = encode(saved.manifest);
  const provenance = encode({ schema_version: "proto-agent.provenance.v1", run_id: saved.id, created_at: saved.manifest.created_at, subject: fileRecord("manifest", `compute/${saved.id}/manifest.json`, manifest), materials: saved.materials, artifacts: [fileRecord("artifact:0", `compute/${saved.id}/result.json`, saved.result)], tool: { name: "synthetic-figure-format-fixture", version: "1", python: "not-executed", platform: "fixture" }, policy: { digest: "sha256", signature: "none", path_mode: "root-relative-single-link-regular-files-no-reparse-points" } });
  for (const [name, bytes] of [["input", saved.input], ["result", saved.result], ["manifest", manifest], ["provenance", provenance]]) await put(root, `${saved.prefix}/${name}.json`, bytes);
}
async function fixture(root, options = {}) {
  const runId = id(), prefix = `build/compute/${runId}`, sourcePath = `inputs/${runId}.request.json`;
  const request = { tool: "synthetic_figure_data", arguments: options.arguments ?? { x: [3, 1, 2], alpha: 0.05, seed: 17 } };
  const input = encode(request), result = encode(options.result ?? { values: [7, 2, 9], estimate: 6, missing: null, rows: [{ category: "A", value: 4 }, { category: "A", value: 3 }] });
  const manifest = { schema_version: "proto-agent.compute.v1", ok: true, run_id: runId, tool: request.tool, created_at: "2026-09-22T00:00:00.000Z", implementation: "synthetic-format-fixture", implementation_version: 1, upstream_commit: null, method_references: ["Synthetic host test reference"], upstream_functions: [], runtime: { fixture: "not-executed" }, review_status: "human_review_required", scope: "Synthetic format fixture; no scientific execution or validity claim.", source: { path: sourcePath, sha256: hash(input) }, inputs: { request_snapshot: `${prefix}/input.json` }, artifacts: [`${prefix}/result.json`], result_sha256: hash(result) };
  const saved = { id: runId, prefix, sourcePath, request, input, result, manifest, materials: [fileRecord("input:request_snapshot", `${prefix}/input.json`, input)] };
  await put(root, sourcePath, input); await publish(root, saved);
  await put(root, `evidence/${runId}/original-bundle.json`, encode({ input: request, result: JSON.parse(result), manifest, materials: saved.materials }));
  return saved;
}
function draft(saved, overrides = {}) { return { title: "Synthetic saved-run figure", caption: "Host service acceptance fixture", columns: 2, panels: [{ id: randomUUID(), runId: saved.id, title: "Synthetic measurements", kind: "line", xLabel: "Saved input X", yLabel: "Saved result Y", xUnit: "user-supplied x", yUnit: "user-supplied y", x: { from: "input", pointer: "/x" }, y: { from: "result", pointer: "/values" } }], ...overrides }; }

// Small valid one-page PDF, intentionally displaying a synthetic fixture label.
function syntheticPdf() {
  const stream = "BT /F1 12 Tf 30 60 Td (Synthetic host service fixture) Tj ET\n";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let content = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(content); content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}
function fakeRenderer(root, options = {}) {
  const calls = [];
  const render = async (name, args) => {
    assert.equal(name, "proto_research_figure_render"); assert.deepEqual(Object.keys(args), ["path"]);
    const requestBytes = await readFile(join(root, args.path)), payload = JSON.parse(requestBytes), exportId = id(), prefix = `build/research-figures/exports/${exportId}/`;
    assert.equal(payload.schema, "proto.research-figure-render.v1");
    const call = { requestPath: args.path, requestBytes, payload, exportId }; calls.push(call);
    if (options.before) await options.before(call);
    const quote = value => `"${String(value).replaceAll('"', '""')}"`;
    const csv = "panel_id,index,x,y\n" + payload.panels.flatMap(panel => panel.points.map((point, index) => [panel.id, index + 1, point.x, point.y].map(quote).join(","))).join("\n") + "\n";
    const contents = [
      ["svg", "figure.svg", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><text x="10" y="50">Synthetic host service fixture</text></svg>')],
      ["pdf", "figure.pdf", "application/pdf", syntheticPdf()],
      ["csv", "plotted-values.csv", "text/csv", Buffer.from(csv)],
      ["data", "figure-data.json", "application/json", encode({ scope: "Synthetic renderer fixture", ...payload })],
      ["methods", "methods.md", "text/markdown", Buffer.from(payload.methodsMarkdown)],
      ["methods-json", "methods.json", "application/json", encode(payload.methods)],
    ];
    const files = [];
    for (const [format, filename, mimeType, bytes] of contents) { await put(root, prefix + filename, bytes); files.push({ format, path: prefix + filename, mimeType, bytes: bytes.length, sha256: hash(bytes) }); }
    const manifest = { schema: "proto.research-figure-export.v1", ok: true, fixtureScope: "Fake renderer for host service tests only", exportId, figureId: payload.figure.id, figureRevision: payload.figure.revision, createdAt: new Date().toISOString(), requestSha256: options.wrongRequestHash ? "0".repeat(64) : hash(requestBytes), files };
    const manifestBytes = encode(manifest), manifestPath = prefix + "manifest.json";
    await put(root, manifestPath, manifestBytes);
    const receipt = { exportId, figureId: payload.figure.id, figureRevision: payload.figure.revision, createdAt: manifest.createdAt, files, manifestPath, manifestSha256: hash(manifestBytes) };
    call.receipt = receipt;
    if (options.after) await options.after(call);
    return receipt;
  };
  return { render, calls };
}
async function workspace(name, fixtureOptions) {
  const root = join(runRoot, name); await mkdir(root, { recursive: true });
  const studyApi = request => requestComputeStudies(root, request);
  const renderer = fakeRenderer(root);
  const api = (request, options = {}) => requestResearchFigures(root, request, { render: renderer.render, ...options });
  const saved = await fixture(root, fixtureOptions);
  const initial = (await studyApi({ action: "create", name: "Synthetic figures project", question: "Host retention behavior only" })).study;
  const study = (await studyApi({ action: "link", studyId: initial.id, expectedRevision: initial.revision, runId: saved.id })).study;
  const figureDraft = draft(saved);
  return { root, saved, study, renderer, api, studyApi, figureDraft, database: join(root, "build", "compute-studies", "studies.sqlite"), save: async () => (await api({ action: "save", studyId: study.id, expectedStudyRevision: study.revision, draft: figureDraft })).figure };
}
const exportRequest = (study, figure, acknowledgeChangedSources = false) => ({ action: "export", studyId: study.id, figureId: figure.id, expectedRevision: figure.revision, expectedStudyRevision: study.revision, acknowledgeChangedSources });

test("saved figures reopen in a new service request with exact selectors, points, metadata and history", async () => {
  const w = await workspace("persistent-selection"); const figure = await w.save();
  assert.equal(figure.revision, 1); assert.equal(figure.change, "create");
  assert.deepEqual(figure.panels[0].binding, w.study.links[0].binding);
  const reopened = await requestResearchFigures(w.root, { action: "get", studyId: w.study.id, figureId: figure.id });
  assert.deepEqual(reopened.figure, figure);
  const list = await w.api({ action: "list", studyId: w.study.id }); assert.equal(list.figures.length, 1); assert.equal(list.figures[0].id, figure.id);
  const { inspection } = await w.api({ action: "inspect", studyId: w.study.id, figureId: figure.id });
  assert.equal(inspection.canExport, true); assert.equal(inspection.requiresSourceAcknowledgement, false);
  assert.deepEqual(inspection.panels[0].points, [{ x: 3, y: 7 }, { x: 1, y: 2 }, { x: 2, y: 9 }]);
  assert.deepEqual(jsonData(inspection.methods.runs[0].inputSnapshot), w.saved.request);
  assert.equal(inspection.methods.runs[0].savedMethodMetadata.implementation, "synthetic-format-fixture");
  const versions = sql(w.database, "SELECT payload FROM research_figure_versions WHERE id=? ORDER BY revision", figure.id); assert.equal(versions.length, 1); assert.deepEqual(JSON.parse(versions[0].payload), figure);
  const series = await w.api({ action: "series", studyId: w.study.id, runId: w.saved.id });
  assert.ok(series.series.some(item => item.selector.from === "result" && item.selector.pointer === "/estimate" && item.length === 1));
});

test("concurrent figure edits allow one winner and retain the earlier immutable version", async () => {
  const w = await workspace("figure-revision-cas"); const original = await w.save();
  const attempts = await Promise.allSettled(["Caption one", "Caption two"].map(caption => w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, figureId: original.id, expectedRevision: original.revision, draft: { ...w.figureDraft, caption } })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.find(result => result.status === "rejected").reason.code, "FIGURE_CONFLICT");
  const winner = attempts.find(result => result.status === "fulfilled").value.figure;
  assert.equal(winner.revision, 2); assert.equal(winner.change, "edit");
  const versions = sql(w.database, "SELECT revision,payload FROM research_figure_versions WHERE id=? ORDER BY revision", original.id);
  assert.deepEqual(versions.map(row => row.revision), [1, 2]); assert.deepEqual(JSON.parse(versions[0].payload), original); assert.deepEqual(JSON.parse(versions[1].payload), winner);
  await assert.rejects(w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, figureId: winner.id, expectedRevision: 1, draft: w.figureDraft }), hasCode("FIGURE_CONFLICT"));
  await assert.rejects(w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, figureId: winner.id, draft: w.figureDraft }), hasCode("FIGURE_REVISION"));
});

test("strict save requests reject host-owned bindings, invalid selections and unassociated runs", async () => {
  const w = await workspace("strict-selections");
  const injected = structuredClone(w.figureDraft); injected.panels[0].binding = w.study.links[0].binding;
  await assert.rejects(w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, draft: injected }));
  for (const selector of [{ from: "result", pointer: "/missing" }, { from: "result", pointer: "/values/01" }, { from: "result", pointer: "/constructor" }]) {
    const invalid = structuredClone(w.figureDraft); invalid.panels[0].y = selector;
    await assert.rejects(w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, draft: invalid }));
  }
  const other = await fixture(w.root); const unlinked = draft(other);
  await assert.rejects(w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, draft: unlinked }), hasCode("RUN_NOT_LINKED"));
  assert.deepEqual((await w.api({ action: "list", studyId: w.study.id })).figures, []);
});

test("changed source requires acknowledgement, preserves snapshot values and records changed hashes", async () => {
  const w = await workspace("source-acknowledgement"); const figure = await w.save();
  const changed = encode({ ...w.saved.request, arguments: { x: [100, 200, 300] } }); await put(w.root, w.saved.sourcePath, changed);
  const { inspection } = await w.api({ action: "inspect", studyId: w.study.id, figureId: figure.id });
  assert.equal(inspection.canExport, true); assert.equal(inspection.requiresSourceAcknowledgement, true); assert.equal(inspection.panels[0].status, "source-changed");
  assert.deepEqual(inspection.panels[0].points.map(point => point.x), [3, 1, 2]);
  await assert.rejects(w.api(exportRequest(w.study, figure)), hasCode("SOURCE_ACKNOWLEDGEMENT_REQUIRED")); assert.equal(w.renderer.calls.length, 0);
  const exported = (await w.api(exportRequest(w.study, figure, true))).export; assert.equal(exported.files.length, 6);
  const methods = JSON.parse(await readFile(join(w.root, exported.files.find(file => file.format === "methods-json").path)));
  assert.equal(methods.runs[0].currentSourceFreshness.status, "changed"); assert.equal(methods.runs[0].currentSourceFreshness.details[0].actualSha256, hash(changed));
  assert.deepEqual(methods.runs[0].inputSnapshot.arguments.x, [3, 1, 2]);
});

test("six-file fake export is retrievable with receipt hashes and old exports survive figure edits", async () => {
  const w = await workspace("export-retention"); const figure = await w.save();
  const exported = (await w.api(exportRequest(w.study, figure))).export;
  assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_exports")[0].n, 1);
  for (const file of exported.files) {
    const { artifact } = await w.api({ action: "artifact", studyId: w.study.id, figureId: figure.id, exportId: exported.exportId, format: file.format });
    const bytes = Buffer.from(artifact.base64, "base64"); assert.equal(hash(bytes), file.sha256); assert.equal(bytes.length, file.bytes); assert.equal(artifact.sha256, file.sha256);
  }
  await w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, figureId: figure.id, expectedRevision: figure.revision, draft: { ...w.figureDraft, caption: "A new caption" } });
  const historical = await w.api({ action: "artifact", studyId: w.study.id, figureId: figure.id, exportId: exported.exportId, format: "methods-json" });
  assert.equal(JSON.parse(Buffer.from(historical.artifact.base64, "base64")).figure.revision, 1);
  const reopened = await requestResearchFigures(w.root, { action: "get", studyId: w.study.id, figureId: figure.id });
  assert.equal(reopened.figure.revision, 2); assert.deepEqual(reopened.exports, [exported]);
  const other = await w.save();
  assert.deepEqual((await w.api({ action: "get", studyId: w.study.id, figureId: other.id })).exports, []);
});

test("export file and manifest tampering reject reads without silently updating receipts", async () => {
  const w = await workspace("export-tampering"); const figure = await w.save();
  const exported = (await w.api(exportRequest(w.study, figure))).export;
  const receiptBefore = sql(w.database, "SELECT payload FROM research_figure_exports WHERE id=?", exported.exportId)[0].payload;
  for (const path of [exported.files.find(file => file.format === "csv").path, exported.manifestPath]) {
    const original = await readFile(join(w.root, path)); await put(w.root, `evidence/tamper-${path.split("/").at(-1)}.original`, original); await put(w.root, path, Buffer.concat([original, Buffer.from("tamper")]));
    await assert.rejects(w.api({ action: "artifact", studyId: w.study.id, figureId: figure.id, exportId: exported.exportId, format: "pdf" }), hasCode("EXPORT_CHANGED"));
    assert.equal(sql(w.database, "SELECT payload FROM research_figure_exports WHERE id=?", exported.exportId)[0].payload, receiptBefore);
    await put(w.root, path, original);
  }
});

test("different project and figure identities cannot retrieve an export", async () => {
  const w = await workspace("export-ownership"); const first = await w.save(); const exported = (await w.api(exportRequest(w.study, first))).export;
  const second = await w.save();
  await assert.rejects(w.api({ action: "artifact", studyId: w.study.id, figureId: second.id, exportId: exported.exportId, format: "svg" }), hasCode("EXPORT_NOT_FOUND"));
  const foreign = (await w.studyApi({ action: "create", name: "Other project", question: "No implicit cross-project access" })).study;
  await assert.rejects(w.api({ action: "get", studyId: foreign.id, figureId: first.id }), hasCode("FIGURE_NOT_FOUND"));
  await assert.rejects(w.api({ action: "artifact", studyId: foreign.id, figureId: first.id, exportId: exported.exportId, format: "svg" }), hasCode("FIGURE_NOT_FOUND"));
  assert.equal((await w.api({ action: "list", studyId: foreign.id })).figures.length, 0);
});

test("decoded export receipt identities must match their owning database row", async () => {
  const w = await workspace("export-receipt-row-identity"); const figure = await w.save(); const exported = (await w.api(exportRequest(w.study, figure))).export;
  const original = sql(w.database, "SELECT payload FROM research_figure_exports WHERE id=?", exported.exportId)[0].payload;
  await put(w.root, "evidence/original-export-receipt.json", original);
  for (const changed of [{ exportId: id() }, { figureId: randomUUID() }, { figureRevision: 2 }]) {
    const payload = JSON.stringify({ ...JSON.parse(original), ...changed });
    const db = new DatabaseSync(w.database); try { db.prepare("UPDATE research_figure_exports SET payload=? WHERE id=?").run(payload, exported.exportId); } finally { db.close(); }
    await assert.rejects(w.api({ action: "artifact", studyId: w.study.id, figureId: figure.id, exportId: exported.exportId, format: "svg" }), hasCode("EXPORT_DAMAGED"));
    await assert.rejects(w.api({ action: "get", studyId: w.study.id, figureId: figure.id }), hasCode("EXPORT_DAMAGED"));
    assert.equal(sql(w.database, "SELECT payload FROM research_figure_exports WHERE id=?", exported.exportId)[0].payload, payload);
  }
});

test("unlink and coordinated bundle replacement require explicit panel rebind after relink", async () => {
  const w = await workspace("explicit-rebind"); const original = await w.save(); const originalBinding = structuredClone(original.panels[0].binding);
  const unlinked = (await w.studyApi({ action: "unlink", studyId: w.study.id, expectedRevision: w.study.revision, runId: w.saved.id })).study;
  let inspection = (await w.api({ action: "inspect", studyId: w.study.id, figureId: original.id })).inspection;
  assert.equal(inspection.canExport, false); assert.equal(inspection.panels[0].status, "binding-changed");
  w.saved.result = encode({ values: [70, 20, 90] }); w.saved.manifest.result_sha256 = hash(w.saved.result); await publish(w.root, w.saved);
  const relinked = (await w.studyApi({ action: "link", studyId: w.study.id, expectedRevision: unlinked.revision, runId: w.saved.id })).study;
  assert.notEqual(relinked.links[0].binding.resultSha256, originalBinding.resultSha256);
  inspection = (await w.api({ action: "inspect", studyId: w.study.id, figureId: original.id })).inspection;
  assert.equal(inspection.canExport, false); assert.equal(inspection.panels[0].status, "binding-changed");
  await assert.rejects(w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: relinked.revision, figureId: original.id, expectedRevision: original.revision, draft: w.figureDraft }), hasCode("BINDING_CHANGED"));
  await assert.rejects(w.api(exportRequest(relinked, original)), hasCode("FIGURE_NOT_READY"));
  const rebound = (await w.api({ action: "rebind", studyId: relinked.id, expectedStudyRevision: relinked.revision, figureId: original.id, expectedRevision: original.revision, panelIds: [original.panels[0].id] })).figure;
  assert.equal(rebound.change, "rebind"); assert.equal(rebound.revision, 2); assert.deepEqual(rebound.panels[0].binding, relinked.links[0].binding);
  const versions = sql(w.database, "SELECT payload FROM research_figure_versions WHERE id=? ORDER BY revision", original.id); assert.deepEqual(JSON.parse(versions[0].payload).panels[0].binding, originalBinding);
  inspection = (await w.api({ action: "inspect", studyId: relinked.id, figureId: rebound.id })).inspection;
  assert.deepEqual(inspection.panels[0].points.map(point => point.y), [70, 20, 90]); assert.equal(inspection.canExport, true);
});

test("tampered retained run blocks inspection and export without repair", async () => {
  const w = await workspace("run-tampering"); const figure = await w.save();
  const corrupted = encode({ values: [99, 99, 99] }); await put(w.root, `${w.saved.prefix}/result.json`, corrupted);
  const { inspection } = await w.api({ action: "inspect", studyId: w.study.id, figureId: figure.id }); assert.equal(inspection.canExport, false); assert.equal(inspection.panels[0].status, "unavailable"); assert.equal(inspection.panels[0].points, undefined);
  await assert.rejects(w.api(exportRequest(w.study, figure)), hasCode("FIGURE_NOT_READY")); assert.equal(w.renderer.calls.length, 0);
  assert.equal(hash(await readFile(join(w.root, w.saved.prefix, "result.json"))), hash(corrupted));
});

test("explicit rebind enforces the aggregate board point limit without replacing the saved revision", async () => {
  const w = await workspace("rebind-point-limit");
  const panels = Array.from({ length: 5 }, () => { const value = { ...w.figureDraft.panels[0], id: randomUUID() }; delete value.x; return value; });
  const figure = (await w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, draft: { ...w.figureDraft, panels } })).figure;
  const unlinked = (await w.studyApi({ action: "unlink", studyId: w.study.id, expectedRevision: w.study.revision, runId: w.saved.id })).study;
  w.saved.result = encode({ values: Array.from({ length: 5000 }, (_, index) => index / 3) }); w.saved.manifest.result_sha256 = hash(w.saved.result); await publish(w.root, w.saved);
  const relinked = (await w.studyApi({ action: "link", studyId: w.study.id, expectedRevision: unlinked.revision, runId: w.saved.id })).study;
  await assert.rejects(w.api({ action: "rebind", studyId: w.study.id, expectedStudyRevision: relinked.revision, figureId: figure.id, expectedRevision: figure.revision, panelIds: panels.map(panel => panel.id) }), hasCode("POINT_LIMIT"));
  assert.deepEqual((await w.api({ action: "get", studyId: w.study.id, figureId: figure.id })).figure, figure);
  assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_versions WHERE id=?", figure.id)[0].n, 1);
});

test("missing renderer diagnostics reach the caller without registering an export", async () => {
  const w = await workspace("renderer-unavailable"); const figure = await w.save();
  await assert.rejects(w.api(exportRequest(w.study, figure), { render: async () => ({ok:false,diagnostics:[{code:'FIGURE_RENDERER_UNAVAILABLE',message:'Optional Matplotlib runtime is missing.'}]}) }), error => error.code==='FIGURE_RENDERER_UNAVAILABLE' && error.message==='Optional Matplotlib runtime is missing.');
  assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_exports")[0].n, 0);
});

test("renderer manifest identity mismatches cannot be hidden behind recomputed file hashes", async () => {
  const w = await workspace("manifest-identity"); const figure = await w.save();
  const renderer = fakeRenderer(w.root, { after: async call => {
    const path = join(w.root, call.receipt.manifestPath), manifest = JSON.parse(await readFile(path));
    manifest.figureId = randomUUID(); const bytes = encode(manifest); await writeFile(path, bytes); call.receipt.manifestSha256 = hash(bytes);
  } });
  await assert.rejects(w.api(exportRequest(w.study, figure), { render: renderer.render }), hasCode("INVALID_EXPORT"));
  assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_exports")[0].n, 0);
});

test("project changes during rendering retain generated files but do not register an export", async () => {
  const w = await workspace("project-race"); const figure = await w.save();
  const renderer = fakeRenderer(w.root, { before: async () => { await w.studyApi({ action: "update", studyId: w.study.id, expectedRevision: w.study.revision, name: "Changed during renderer", question: "Race fixture" }); } });
  await assert.rejects(w.api(exportRequest(w.study, figure), { render: renderer.render }), hasCode("STUDY_CONFLICT"));
  assert.equal(renderer.calls.length, 1); assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_exports")[0].n, 0);
  assert.ok((await readFile(join(w.root, renderer.calls[0].receipt.manifestPath))).length > 0);
});

test("figure changes during rendering reject stale export registration and retain both versions", async () => {
  const w = await workspace("figure-race"); const figure = await w.save();
  const renderer = fakeRenderer(w.root, { before: async () => { await w.api({ action: "save", studyId: w.study.id, expectedStudyRevision: w.study.revision, figureId: figure.id, expectedRevision: figure.revision, draft: { ...w.figureDraft, caption: "Edited while rendering" } }); } });
  await assert.rejects(w.api(exportRequest(w.study, figure), { render: renderer.render }), hasCode("FIGURE_CONFLICT"));
  assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_exports")[0].n, 0); assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_versions WHERE id=?", figure.id)[0].n, 2);
});

test("source changes during rendering reject registration even if initial export was acknowledged", async () => {
  const w = await workspace("source-race"); const figure = await w.save();
  const renderer = fakeRenderer(w.root, { before: async () => { await put(w.root, w.saved.sourcePath, Buffer.from("Changed during render; preserved as synthetic race evidence.")); } });
  await assert.rejects(w.api(exportRequest(w.study, figure, true), { render: renderer.render }), hasCode("FIGURE_CHANGED_DURING_EXPORT"));
  assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_exports")[0].n, 0);
});

test("renderer request hash mismatch or request-file mutation cannot register an export", async () => {
  for (const mode of ["wrong-request-hash", "mutated-request-file"]) {
    const w = await workspace(mode); const figure = await w.save();
    const renderer = fakeRenderer(w.root, mode === "wrong-request-hash" ? { wrongRequestHash: true } : { after: async call => { await put(w.root, call.requestPath, Buffer.concat([call.requestBytes, Buffer.from(" ")])); } });
    await assert.rejects(w.api(exportRequest(w.study, figure), { render: renderer.render }), hasCode(mode === "wrong-request-hash" ? "INVALID_EXPORT" : "FIGURE_REQUEST_CHANGED"));
    assert.equal(sql(w.database, "SELECT count(*) n FROM research_figure_exports")[0].n, 0);
  }
});
