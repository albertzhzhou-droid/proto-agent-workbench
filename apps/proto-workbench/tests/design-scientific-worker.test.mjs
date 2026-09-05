import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { computeScientific } from "../src/renderer/design-scientific.ts";
import { currentScientificSettlement, ScientificWorkerClient } from "../src/renderer/design-scientific-client.ts";
import { parseDesignIr, searchDesign, discoverOpenReadingFrames, rotateCircularConstructView } from "../src/renderer/design-visualization.ts";
import { calculateGcContentSeries, calculateGcSkewSeries } from "../src/renderer/sequence-metrics.ts";
import { buildFeatureInventory } from "../src/renderer/design-feature-inventory.ts";
import { dnaWindowProjection } from "../src/renderer/dna-window.ts";

class FakeWorker {
  onmessage = null;
  onerror = null;
  requests = [];
  terminated = false;
  postMessage(request) { this.requests.push(request); }
  terminate() { this.terminated = true; }
  reply(result, overrides = {}) { this.onmessage?.({ data: { ...this.requests.at(-1), result, ...overrides } }); }
}
function fixture(count = 2, bases = 50) {
  // Explicit software-only fixture; no claim of a reviewed biological resource.
  const sequence = "ATGGCCGTAATAGCTGCGTCTAGATCGATGCGATTAGCTCGATCGCGGGTAA".repeat(Math.ceil(bases / 50)).slice(0, bases);
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const parts = Array.from({ length: count }, (_, index) => ({ id: "fixture:toy_dna", instance_id: `slot_${index}`, name: "Toy DNA", type: "cds", start: index * bases, end: (index + 1) * bases, sequence, sequence_sha256: sha(sequence), source_sequence_sha256: sha(sequence), source_direction: 0, direction: 0, placement: { orientation: "forward", transform: "identity", algorithm: "iupac-dna.v1" } }));
  const assembled = parts.map((part) => part.sequence).join("");
  const parsed = parseDesignIr({ schema_version: "proto-agent.ir.v2", domain: "dna", design_id: "worker_toy", chassis: "toy", constructs: [{ name: "toy", topology: "circular", length: assembled.length, sequence: assembled, sequence_sha256: sha(assembled), parts, annotations: [] }], constraints: [], provenance: { source: "build/toy.proto" } });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return parsed.design;
}
const inventoryOptions = { query: "", type: "all", source: "all", sortKey: "coordinate", sortDirection: "asc", hiddenIndexes: [] };

test("superseded work is terminated and late replies cannot settle a newer artifact", async () => {
  const workers = [];
  const client = new ScientificWorkerClient(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const first = client.run("search", "artifact:a", { design: fixture(), query: "first" });
  const rejected = assert.rejects(first, { name: "AbortError" });
  const lateHandler = workers[0].onmessage;
  const firstRequest = workers[0].requests[0];
  const second = client.run("search", "artifact:b", { design: fixture(), query: "second" });
  assert.equal(workers[0].terminated, true);
  let settled = false;
  void second.then(() => { settled = true; });
  lateHandler({ data: { ...firstRequest, result: [{ value: "stale" }] } });
  workers[1].reply([{ value: "wrong identity" }], { artifactIdentity: "artifact:a" });
  workers[1].reply([{ value: "wrong operation" }], { kind: "inventory" });
  await Promise.resolve();
  assert.equal(settled, false);
  workers[1].reply([{ value: "current" }]);
  assert.deepEqual(await second, [{ value: "current" }]);
  await rejected;
  client.dispose();
});

test("abort, deadline, worker errors and dispatch errors release owned computation", async () => {
  const workers = [];
  const client = new ScientificWorkerClient(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }, 30);
  const input = { sequence: "ACGT", circular: false };
  const abort = new AbortController();
  const pending = client.run("tracks", "a", input, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(workers[0].terminated, true);
  await assert.rejects(client.run("tracks", "a", input), /deadline/);
  assert.equal(workers[1].terminated, true);
  const broken = client.run("tracks", "b", input);
  workers[2].onerror({});
  await assert.rejects(broken, /worker failed/);
  assert.equal(workers[2].terminated, true);
  const healthy = client.run("tracks", "b", input);
  workers[3].reply(computeScientific("tracks", input));
  assert.deepEqual(await healthy, computeScientific("tracks", input));
  client.dispose();
  assert.equal(workers[3].terminated, true);
  const throwing = new ScientificWorkerClient(() => ({ ...new FakeWorker(), postMessage() { throw new Error("clone rejected"); }, terminate() {} }));
  await assert.rejects(throwing.run("tracks", "a", input), /clone rejected/);
  throwing.dispose();
});

test("render-time identity guard hides old results before effect cleanup and after query changes", () => {
  const input = { design: fixture(), query: "slot_1" };
  const settled = { input, artifactIdentity: "a", result: [{ value: "current" }] };
  assert.equal(currentScientificSettlement(settled, input, "a"), settled);
  assert.equal(currentScientificSettlement(settled, input, "b"), undefined);
  assert.equal(currentScientificSettlement(settled, { ...input, query: "slot_0" }, "a"), undefined);
  assert.equal(currentScientificSettlement(settled, undefined, "a"), undefined);
});

test("scientific calculations preserve ORF, origin, search, filter and metric semantics", () => {
  const design = fixture();
  const original = structuredClone(design);
  const discovered = discoverOpenReadingFrames(design.constructs[0].sequence, { topology: "circular", constructStart: 0, minimumAminoAcids: 2, maximumFeatures: 1998 });
  const view = computeScientific("view", { design, discoverOrfs: true, minimumAminoAcids: 2, viewOrigins: { 0: 17 } });
  assert.deepEqual(view.discoveredOrfs, [discovered]);
  assert.deepEqual(view.design.constructs[0], rotateCircularConstructView({ ...design.constructs[0], features: [...design.constructs[0].features, ...discovered.features] }, 17));
  assert.deepEqual(computeScientific("search", { design: view.design, query: "slot_1" }), searchDesign(view.design, "slot_1"));
  const features = view.design.constructs[0].features;
  const options = { ...inventoryOptions, query: "slot_", sortKey: "name", sortDirection: "desc", hiddenIndexes: [1] };
  assert.deepEqual(computeScientific("inventory", { features, options }).entries, buildFeatureInventory(features, { ...options, hiddenFeatureIndexes: new Set([1]) }));
  const sequence = view.design.constructs[0].sequence;
  assert.deepEqual(computeScientific("tracks", { sequence, circular: true, windowSize: 21 }), { gcContent: calculateGcContentSeries(sequence, true, 96, 21), gcSkew: calculateGcSkewSeries(sequence, true, 96, 21) });
  assert.deepEqual(design, original, "source model remains immutable");
});

function realWorkerTransport() {
  const moduleUrl = new URL("../src/renderer/design-scientific.worker.ts", import.meta.url).href;
  const thread = new Worker(`const { parentPort } = require('node:worker_threads'); globalThis.self = { onmessage: null, postMessage: (data) => parentPort.postMessage(data) }; import(${JSON.stringify(moduleUrl)}).then(() => parentPort.on('message', (data) => globalThis.self.onmessage({ data })));`, { eval: true });
  const transport = { onmessage: null, onerror: null, postMessage: (data) => thread.postMessage(data), terminate: () => { void thread.terminate(); } };
  thread.on("message", (data) => transport.onmessage?.({ data }));
  thread.on("error", (error) => transport.onerror?.(error));
  return transport;
}

test("real worker supports 100kbp/2000 features and bounded 1Mbp sequence windows", { timeout: 20_000 }, async (t) => {
  const client = new ScientificWorkerClient(realWorkerTransport);
  const design = fixture(2000, 50);
  let timerAdvanced = false;
  const timer = setTimeout(() => { timerAdvanced = true; }, 0);
  const started = performance.now();
  try {
    const view = await client.run("view", "large:100k", { design, discoverOrfs: true, minimumAminoAcids: 30, viewOrigins: { 0: 97503 } });
    assert.equal(timerAdvanced, true, "host event loop remains available during worker computation");
    assert.equal(view.design.constructs[0].length, 100_000);
    assert.equal(view.design.constructs[0].features.length, 2000);
    assert.deepEqual(view.discoveredOrfs[0].features, [], "ORFs retain the total feature cap");
    const hits = await client.run("search", "large:100k", { design: view.design, query: "slot_1999" });
    assert.equal(hits[0].featureIndex, 1999);
    assert.deepEqual(hits, searchDesign(view.design, "slot_1999"));
    const inventory = await client.run("inventory", "large:100k", { features: view.design.constructs[0].features, options: inventoryOptions });
    assert.equal(inventory.entries.length, 2000);
    const tracks = await client.run("tracks", "large:100k", { sequence: view.design.constructs[0].sequence, circular: true, windowSize: 101 });
    assert.equal(tracks.gcContent.positions.length, 96);
    const million = fixture(2000, 500).constructs[0];
    const window = await client.run("window", "large:1m", { construct: million, start: 999000 });
    assert.deepEqual(window.projection, dnaWindowProjection(million, 999000));
    assert.equal(window.projection.sequence.length, 8000);
    assert.equal(window.projection.end, 1_000_000);
    assert.equal(window.density.length, 200);
    assert.ok(window.projection.annotations.length <= 400);
    t.diagnostic(`Real worker pipeline ${Math.round(performance.now() - started)}ms; CPU/transport check, not native frame-rate evidence.`);
  } finally { clearTimeout(timer); client.dispose(); }
});
