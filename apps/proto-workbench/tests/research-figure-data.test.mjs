import assert from "node:assert/strict";
import test from "node:test";
import { buildFigureMethods, discoverFigureSeries, selectFigurePoints } from "../src/main/services/research-figure-data.ts";

const runId = "a".repeat(32), hash = "b".repeat(64);
const binding = { tool: "statistics.saved-only", createdAt: "2026-09-22T00:00:00.000Z", manifestSha256: hash, inputSha256: hash, resultSha256: hash, provenanceSha256: hash };
const study = { id: "979906ba-07ce-4d51-9bb2-cadcfaa12696", revision: 2, name: "A saved research question", question: "Does the recorded measurement change?" };
function run(result = { values: [4, 7, 2] }, args = { x: [2, 1, 3] }) {
  return { runId, tool: binding.tool, createdAt: binding.createdAt, binding, request: { tool: binding.tool, arguments: args }, receipt: { ok: true, run_id: runId, tool: binding.tool, result, implementation: "historical.implementation", implementation_version: 7, upstream_commit: "original-commit", runtime: { python: "original-version" }, method_references: ["Original method reference"], source: { path: "build/original-input.json", sha256: hash }, inputs: { request_snapshot: `build/compute/${runId}/input.json`, "file:data": { path: "samples/original.csv", sha256: hash } } }, integrity: { status: "verified", code: "BUNDLE_VERIFIED", message: "Matching unsigned bytes", checkedAt: binding.createdAt, authority: "unsigned-local-artifacts", hashes: { manifestSha256: hash, inputSha256: hash, resultSha256: hash, provenanceSha256: hash } }, sourceFreshness: { status: "current", checkedAt: binding.createdAt, details: [{ name: "file:data", path: "samples/original.csv", expectedSha256: hash, actualSha256: hash, status: "current", code: "SOURCE_MATCH", message: "Matches" }] } };
}
function panel(overrides = {}) { return { id: "a9f6d89e-9065-4cba-bbc5-68758079a042", runId, title: "Measured signal", kind: "line", xLabel: "Time", yLabel: "Signal", xUnit: "s", yUnit: "user-supplied unit", y: { from: "result", pointer: "/values" }, binding, ...overrides }; }
function figure(panels = [panel()]) { return { id: "3f523763-7b02-4a60-8298-8e39a390a7b7", studyId: study.id, revision: 1, createdAt: binding.createdAt, updatedAt: binding.createdAt, change: "create", title: "Recorded comparison", caption: "User-authored caption", columns: 2, panels }; }
const view = (value = panel(), points = [{ x: 1, y: 4 }, { x: 2, y: 7 }, { x: 3, y: 2 }]) => ({ id: value.id, status: "ready", message: "Saved selection verified", points });

test("projection preserves array order, original numbers and one-based default index", () => {
  assert.deepEqual(selectFigurePoints(run(), panel()), [{ x: 1, y: 4 }, { x: 2, y: 7 }, { x: 3, y: 2 }]);
  assert.deepEqual(selectFigurePoints(run(), panel({ x: { from: "input", pointer: "/x" } })), [{ x: 2, y: 4 }, { x: 1, y: 7 }, { x: 3, y: 2 }]);
  const points = selectFigurePoints(run({ values: [-0, 1e-22, 1e24] }), panel());
  assert.equal(Object.is(points[0].y, -0), true); assert.equal(points[1].y, 1e-22); assert.equal(points[2].y, 1e24);
});

test("a numeric scalar is one measurement rather than an invented sample series", () => {
  const saved = run({ mean: 2.125 });
  assert.deepEqual(selectFigurePoints(saved, panel({ y: { from: "result", pointer: "/mean" } })), [{ x: 1, y: 2.125 }]);
  assert.ok(discoverFigureSeries(saved).series.some(item => item.selector.pointer === "/mean" && item.length === 1 && item.kind === "numeric"));
});

test("strict RFC6901 escaping selects array columns and empty property names", () => {
  const saved = run({ "a/b": [{ "x~y": 7, "": 9 }, { "x~y": 3, "": 5 }] });
  assert.deepEqual(selectFigurePoints(saved, panel({ y: { from: "result", pointer: "/a~1b", field: "/x~0y" } })), [{ x: 1, y: 7 }, { x: 2, y: 3 }]);
  assert.deepEqual(selectFigurePoints(saved, panel({ y: { from: "result", pointer: "/a~1b", field: "/" } })), [{ x: 1, y: 9 }, { x: 2, y: 5 }]);
  assert.ok(discoverFigureSeries(saved).series.some(item => item.selector.pointer === "/a~1b" && item.selector.field === "/x~0y"));
  for (const pointer of ["/a~2b", "/a~", "a/b", "/a~1b/01", "/a~1b/-", "/a~1b/+0", "/a~1b/2", "/a~1b/9007199254740992"]) assert.throws(() => selectFigurePoints(saved, panel({ y: { from: "result", pointer } })));
});

test("prototype paths, inherited values and accessors never become data", () => {
  const result = Object.assign(Object.create({ inherited: [1, 2] }), { values: [4, 7] });
  Object.defineProperty(result, "getter", { enumerable: true, get() { throw new Error("This accessor must never execute"); } });
  Object.defineProperty(result, "__proto__", { enumerable: true, value: [8, 9] });
  const saved = run(result);
  for (const pointer of ["/inherited", "/getter", "/__proto__", "/constructor", "/prototype", "/values/length"]) assert.throws(() => selectFigurePoints(saved, panel({ y: { from: "result", pointer } })));
  const found = discoverFigureSeries(saved);
  assert.equal(found.series.some(item => /inherited|getter|__proto__/.test(item.selector.pointer)), false);
});

test("null, missing, mixed values, sparse rows and non-finite values reject the whole selection", () => {
  for (const values of [[1, null, 2], [1, "2", 3], [1, NaN, 2], [1, Infinity, 2], [1, undefined, 2], [1, , 3]]) {
    const saved = run({ values });
    assert.throws(() => selectFigurePoints(saved, panel()));
    assert.equal(discoverFigureSeries(saved).series.some(item => item.selector.from === "result"), false);
  }
  const saved = run({ rows: [{ y: 1, category: "A" }, { category: "B" }, { y: 3, category: "C" }] });
  assert.throws(() => selectFigurePoints(saved, panel({ y: { from: "result", pointer: "/rows", field: "/y" } })));
  assert.equal(discoverFigureSeries(saved).series.some(item => item.selector.field === "/y"), false);
  assert.ok(discoverFigureSeries(saved).series.some(item => item.selector.field === "/category"));
});

test("bar categories retain repeated labels; scatter and line require numeric X", () => {
  const saved = run({ values: [8, 3, 5], categories: ["A", "A", "B"] });
  const x = { from: "result", pointer: "/categories" };
  assert.deepEqual(selectFigurePoints(saved, panel({ kind: "bar", x })), [{ x: "A", y: 8 }, { x: "A", y: 3 }, { x: "B", y: 5 }]);
  assert.throws(() => selectFigurePoints(saved, panel({ x })), /numeric X/);
  assert.throws(() => selectFigurePoints(saved, panel({ kind: "scatter", x })), /numeric X/);
  assert.throws(() => selectFigurePoints(run({ values: [8, 3, 5], categories: ["A", 2, "B"] }), panel({ kind: "bar", x })));
});

test("unequal or excessive arrays fail without truncation, repetition or filtering", () => {
  assert.throws(() => selectFigurePoints(run(), panel({ x: { from: "result", pointer: "/values/0" } })), /identical lengths/);
  assert.throws(() => selectFigurePoints(run({ values: [] }), panel()), /between 1 and 5,000/);
  assert.equal(selectFigurePoints(run({ values: Array(5000).fill(1) }), panel()).length, 5000);
  assert.throws(() => selectFigurePoints(run({ values: Array(5001).fill(1) }), panel()), /5,000/);
  const found = discoverFigureSeries(run({ values: Array(5001).fill(1) }));
  assert.equal(found.truncated, true); assert.equal(found.series.some(item => item.selector.pointer === "/values"), false);
});

test("discovery reports node, candidate and depth bounds explicitly", () => {
  const candidates = discoverFigureSeries(run(Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`n${index}`, index])), {}));
  assert.equal(candidates.series.length, 256); assert.equal(candidates.truncated, true);
  const deep = Array.from({ length: 9 }).reduce(value => ({ nested: value }), [1, 2]);
  const bounded = discoverFigureSeries(run({ values: deep }, {}));
  assert.equal(bounded.truncated, true); assert.equal(bounded.series.length, 0);
  const exhausted = discoverFigureSeries(run({ rows: Array.from({ length: 5000 }, (_, index) => ({ a: index, b: index, c: index })) }, {}));
  assert.equal(exhausted.truncated, true); assert.ok(exhausted.series.length < 3);
  for (const suggestion of exhausted.series) assert.equal(selectFigurePoints(run({ rows: Array.from({ length: 5000 }, (_, index) => ({ a: index, b: index, c: index })) }, {}), panel({ y: suggestion.selector })).length, 5000);
});

test("unverified, preview and mismatched result identities cannot supply figure data", () => {
  for (const mutate of [value => { value.integrity.status = "damaged"; }, value => { value.receipt.preview = true; }, value => { value.receipt.ok = false; }, value => { delete value.request; }, value => { value.receipt.run_id = "c".repeat(32); }, value => { value.receipt.tool = "another-tool"; }]) {
    const saved = run(); mutate(saved);
    assert.throws(() => selectFigurePoints(saved, panel())); assert.throws(() => discoverFigureSeries(saved));
  }
  assert.throws(() => selectFigurePoints(run(), panel({ runId: "c".repeat(32) })), /different saved run/);
});

test("methods retain exact original input and metadata, binding and current freshness separately", () => {
  const saved = run({ values: [4, 7, 2] }, { alpha: 0.05, alternative: "two-sided", data: "samples/original.csv", labels: ["control", "treated"], optional: null });
  saved.receipt.maturity = { schema_version: "proto.compute-maturity.v1", method_stage: "demonstration", scientific_validation: "not-established", domain_validation: "not-established", applicability: ["Fixture scope"], known_limitations: ["Not an experimental validation"], evidence: [], assessment_basis: "Saved assessment", availability_is_separate: true, automatic_promotion: false };
  saved.sourceFreshness.status = "changed"; saved.sourceFreshness.details[0].status = "changed"; saved.sourceFreshness.details[0].actualSha256 = "c".repeat(64);
  const { methods, methodsMarkdown } = buildFigureMethods(figure(), study, [saved], [view()]);
  assert.deepEqual(methods.runs[0].inputSnapshot, saved.request);
  assert.deepEqual(methods.runs[0].savedMethodMetadata.maturity, saved.receipt.maturity);
  assert.deepEqual(methods.panels[0].binding, binding);
  assert.equal(methods.runs[0].savedMethodMetadata.implementation, "historical.implementation");
  assert.equal(methods.runs[0].savedMethodMetadata.upstream_commit, "original-commit");
  assert.equal(methods.runs[0].originalInputReferences.inputs["file:data"].sha256, hash);
  assert.equal(methods.runs[0].artifactIntegrity.status, "verified");
  assert.equal(methods.runs[0].currentSourceFreshness.status, "changed");
  assert.equal(methods.panels[0].axes.y.unit, "user-supplied unit");
  assert.match(methods.panels[0].axes.provenance, /user-authored/);
  assert.match(methodsMarkdown, /no promotion is inferred/);
  assert.match(methodsMarkdown, /no current catalog lookup|saved method metadata/);
  saved.request.arguments.alpha = 0.9; saved.receipt.maturity.method_stage = "heuristic";
  assert.equal(methods.runs[0].inputSnapshot.arguments.alpha, 0.05);
  assert.equal(methods.runs[0].savedMethodMetadata.maturity.method_stage, "demonstration");
});

test("legacy missing maturity and unavailable runs do not gain scientific claims", () => {
  const { methods, methodsMarkdown } = buildFigureMethods(figure(), study, [run()], [view()]);
  assert.equal(methods.runs[0].maturityRecorded, false); assert.equal(Object.hasOwn(methods.runs[0].savedMethodMetadata, "maturity"), false);
  assert.match(methodsMarkdown, /not recorded; no method or scientific maturity is inferred/);
  const damaged = run(); damaged.integrity.status = "damaged";
  const result = buildFigureMethods(figure(), study, [damaged], [{ id: panel().id, status: "unavailable", message: "Damaged artifact" }]);
  assert.equal(result.methods.runs[0].inputSnapshot, null); assert.equal(result.methods.runs[0].availability, "unavailable-for-methods");
  assert.equal(result.methods.panels[0].inspection.pointCount, null);
});

test("methods put hostile text and references in code without executable HTML or links", () => {
  const saved = run(); saved.receipt.method_references = ["[click](javascript:alert(1))", "https://example.invalid/<script>bad</script>", "```\n# forged section\n```"];
  const authored = figure(); authored.title = "<img onerror=alert(1)>"; authored.caption = "```\n[bad](javascript:evil)\n```";
  const { methodsMarkdown, methods } = buildFigureMethods(authored, study, [saved], [view()]);
  assert.equal(methods.figure.caption, authored.caption);
  assert.deepEqual(methods.runs[0].savedMethodMetadata.method_references, saved.receipt.method_references);
  assert.ok(methodsMarkdown.includes('` "<img onerror=alert(1)>" `'));
  assert.ok(methodsMarkdown.includes('` "[click](javascript:alert(1))" `'));
  assert.ok(methodsMarkdown.includes('```` "```\\n[bad](javascript:evil)\\n```" ````'));
  assert.equal(methodsMarkdown.split("\n").some(line => line === "# forged section"), false); // JSON strings retain escaped newlines inside code.
  assert.ok(methodsMarkdown.includes("````json\n"));
});

test("large input is complete in methods JSON and omission from Markdown is explicit", () => {
  const saved = run(undefined, { samples: Array.from({ length: 5000 }, (_, index) => index / 7), exactLiteral: "no silent summary" });
  const { methods, methodsMarkdown } = buildFigureMethods(figure(), study, [saved], [view()]);
  assert.deepEqual(methods.runs[0].inputSnapshot.arguments.samples, saved.request.arguments.samples);
  assert.match(methodsMarkdown, /complete value \(\d+ JSON characters\) is retained in methods.json/);
  assert.match(methodsMarkdown, /\/runs\/0\/inputSnapshot/);
  assert.match(methodsMarkdown, /not abbreviated in that structured file/);
});

test("methods preserve per-panel semantics and reject duplicate identities and excessive board points", () => {
  const selected = panel({ kind: "scatter", x: { from: "input", pointer: "/x" } });
  const result = buildFigureMethods(figure([selected]), study, [run()], [view(selected)]);
  assert.equal(result.methods.panels[0].semantics.x, "selected saved values"); assert.equal(result.methods.panels[0].semantics.line, null);
  const bars = panel({ kind: "bar" });
  const barMethods = buildFigureMethods(figure([bars]), study, [run()], [view(bars)]);
  assert.match(barMethods.methods.panels[0].semantics.bar, /positional bar/);
  assert.match(barMethods.methods.panels[0].semantics.bar, /repeated labels remain distinct/);
  assert.throws(() => buildFigureMethods(figure(), { ...study, id: "another" }, [run()], [view()]), /different research project/);
  assert.throws(() => buildFigureMethods(figure(), study, [run(), run()], [view()]), /Duplicate/);
  assert.throws(() => buildFigureMethods(figure(), study, [run()], [view(), view()]), /Duplicate/);
  const panels = Array.from({ length: 5 }, (_, index) => panel({ id: `panel-${index}` }));
  const views = panels.map(value => view(value, Array.from({ length: 5000 }, (_, index) => ({ x: index + 1, y: index }))));
  assert.throws(() => buildFigureMethods(figure(panels), study, [run()], views), /20,000 total/);
});
