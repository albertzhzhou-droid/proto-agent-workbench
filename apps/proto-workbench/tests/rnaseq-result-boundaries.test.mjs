import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {link, mkdir, mkdtemp, unlink, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {computeResultByteLimit, computeResultNodeLimit} from "../src/shared/compute-limits.ts";
import {WorkspaceFiles} from "../src/main/services/workspace-files.ts";
import {requestComputeStudies} from "../src/main/services/compute-studies.ts";
import {readVerifiedComputeResult} from "../src/renderer/compute-result-reader.ts";

const MiB = 1024 * 1024;
const RNA_TOOL = "analyze_rnaseq_study";
const OTHER_TOOL = "synthetic_ordinary_compute_fixture";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceRoot = join(repository, "build", "rnaseq-studies-20260922");
await mkdir(evidenceRoot, {recursive: true});
const runRoot = await mkdtemp(join(evidenceRoot, "result-boundaries-"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => Buffer.from(JSON.stringify(value) + "\n");
const fileRecord = (name, path, bytes) => ({name, path, sha256: hash(bytes), size: bytes.length});
await writeFile(join(runRoot, "scope.json"), encode({
  scope: "Synthetic byte-boundary and retained-identity fixtures only; no RNA-seq fitting or scientific validation.",
  createdAt: new Date().toISOString(),
}));

async function put(root, path, bytes) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, bytes);
}

async function fixture(name, result) {
  const root = join(runRoot, name);
  const id = randomUUID().replaceAll("-", "");
  const prefix = `build/compute/${id}`;
  const saved = {root, id, prefix, result, resultPath: `${prefix}/result.json`, manifestPath: `${prefix}/manifest.json`};
  await put(root, saved.resultPath, result);
  saved.files = new WorkspaceFiles(root, {savePatch() {throw new Error("Read-only fixture must not save a patch.");}});
  saved.read = path => saved.files.read(path);
  saved.api = request => requestComputeStudies(root, request);
  await publish(saved, RNA_TOOL);
  return saved;
}

// Publish matching real SHA-256 records. This explicitly models retention only;
// a format-valid unsigned bundle does not establish that computation occurred.
async function publish(saved, tool) {
  const {root, id, prefix, result, resultPath} = saved;
  const input = encode({tool, arguments: {fixture: "byte-boundary-only"}});
  const inputPath = `${prefix}/input.json`;
  const sourcePath = "inputs/synthetic-request.json";
  const manifest = {
    schema_version: "proto-agent.compute.v1", ok: true, run_id: id, tool,
    created_at: "2026-09-22T00:00:00.000Z", implementation: "synthetic-format-fixture", implementation_version: 1,
    upstream_commit: null, method_references: [], upstream_functions: [], runtime: {fixture: "not-executed"},
    review_status: "human_review_required", scope: "Synthetic retention fixture; no scientific execution claim.",
    source: {path: sourcePath, sha256: hash(input)}, inputs: {request_snapshot: inputPath},
    artifacts: [resultPath], result_sha256: hash(result),
  };
  const manifestBytes = encode(manifest);
  const provenance = {
    schema_version: "proto-agent.provenance.v1", run_id: id, created_at: manifest.created_at,
    subject: fileRecord("manifest", `compute/${id}/manifest.json`, manifestBytes),
    materials: [fileRecord("input:request_snapshot", inputPath, input)],
    artifacts: [fileRecord("artifact:0", `compute/${id}/result.json`, result)],
    tool: {name: "synthetic-format-fixture", version: "1", python: "not-executed", platform: "fixture"},
    policy: {digest: "sha256", signature: "none", path_mode: "root-relative-single-link-regular-files-no-reparse-points"},
  };
  for (const [path, bytes] of [[inputPath, input], [sourcePath, input], [saved.manifestPath, manifestBytes], [`${prefix}/provenance.json`, encode(provenance)]]) {
    await put(root, path, bytes);
  }
  saved.manifest = manifest;
  saved.manifestBytes = manifestBytes;
  saved.receipt = {...manifest, manifest_path: saved.manifestPath};
}

test("only the exact RNA tool receives a 32 MiB result bound", () => {
  assert.equal(computeResultByteLimit(RNA_TOOL), 32 * MiB);
  assert.equal(computeResultNodeLimit(RNA_TOOL), 2_000_000);
  for (const tool of [OTHER_TOOL, undefined, null, {}, [RNA_TOOL], "Analyze_rnaseq_study", RNA_TOOL + " "]) {
    assert.equal(computeResultByteLimit(tool), 4 * MiB);
    assert.equal(computeResultNodeLimit(tool), 600_000);
  }
});

test("transcriptome-sized row count uses the larger RNA node budget without increasing ordinary-tool nodes", async () => {
  // 60,001 object nodes plus nine values per row is already >600,000 nodes.
  // Compact fixture column names keep these exact same bytes below 4 MiB so
  // ordinary-tool rejection specifically proves the node guard, not byte size.
  const rows = Array.from({length: 60_001}, (_, index) => ({id: `g-${index}`, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0}));
  const payload = encode({fixture: "synthetic row-node boundary; no scientific results", rows});
  assert.ok(payload.byteLength < 4 * MiB);
  const saved = await fixture("transcriptome-node-bound", payload);
  const {run} = await saved.api({action: "open-run", runId: saved.id});
  assert.equal(run.integrity.status, "verified", JSON.stringify(run.integrity));
  assert.equal(run.receipt.result.rows.length, 60_001);
  assert.equal(run.receipt.result.rows[60_000].id, "g-60000");
  assert.equal(run.binding.resultSha256, hash(payload));
  await publish(saved, OTHER_TOOL);
  const ordinary = await saved.api({action: "open-run", runId: saved.id});
  assert.equal(ordinary.run.integrity.status, "damaged");
  assert.equal(ordinary.run.integrity.code, "JSON_LIMIT");
  assert.equal(ordinary.run.receipt, undefined);
});

test("one retained 5 MiB fixture exercises host, renderer, studies, and ordinary-tool rejection", async context => {
  const payload = encode({fixture: "synthetic byte boundary, no DESeq2 model", values: [0, 1, null], padding: "x".repeat(5 * MiB)});
  assert.ok(payload.byteLength > 4 * MiB && payload.byteLength < 32 * MiB);
  const saved = await fixture("shared-large-result", payload);

  await context.test("RNA result reopens from actual bytes in host and renderer", async () => {
    const file = await saved.files.read(saved.resultPath);
    assert.equal(Buffer.byteLength(file.content), payload.byteLength);
    assert.equal(file.sha256, hash(payload));
    const opened = await readVerifiedComputeResult(saved.receipt, saved.read, RNA_TOOL);
    assert.deepEqual(opened.values, [0, 1, null]);
    assert.equal(opened.padding.length, 5 * MiB);
  });

  await context.test("studies verifies and links the complete larger synthetic Compute bundle", async () => {
    const {run} = await saved.api({action: "open-run", runId: saved.id});
    assert.equal(run.integrity.status, "verified", JSON.stringify(run.integrity));
    assert.equal(run.integrity.authority, "unsigned-local-artifacts");
    assert.equal(run.binding.resultSha256, hash(payload));
    assert.equal(run.receipt.result.padding.length, 5 * MiB);
    assert.equal(run.sourceFreshness.status, "current");
    const {study: created} = await saved.api({action: "create", name: "Synthetic large result", question: "Retained byte-boundary fixture only"});
    const {study: linked} = await saved.api({action: "link", studyId: created.id, expectedRevision: created.revision, runId: saved.id});
    const reopened = await saved.api({action: "open-run", studyId: linked.id, runId: saved.id});
    assert.equal(reopened.run.integrity.status, "verified");
    assert.equal(reopened.run.binding.resultSha256, hash(payload));
  });

  await context.test("same bytes remain too large for an ordinary Compute tool", async () => {
    await publish(saved, OTHER_TOOL);
    await assert.rejects(saved.files.read(saved.resultPath), /bounded/);
    const file = {content: payload.toString("utf8"), sha256: hash(payload)};
    await assert.rejects(readVerifiedComputeResult(saved.receipt, async () => file, OTHER_TOOL), /no longer match/);
    const {run} = await saved.api({action: "open-run", runId: saved.id});
    assert.equal(run.integrity.status, "unavailable");
    assert.equal(run.receipt, undefined);
    await publish(saved, RNA_TOOL);
  });

  await context.test("renderer rejects real changed bytes even when the host returns their current hash", async () => {
    const tampered = Buffer.from(payload);
    tampered[tampered.indexOf("xxx")] = "y".charCodeAt(0);
    await put(saved.root, saved.resultPath, tampered);
    const file = await saved.files.read(saved.resultPath);
    assert.equal(file.sha256, hash(tampered));
    assert.notEqual(file.sha256, saved.receipt.result_sha256);
    await assert.rejects(readVerifiedComputeResult(saved.receipt, saved.read, RNA_TOOL), /no longer match/);
    const {run} = await saved.api({action: "open-run", runId: saved.id});
    assert.equal(run.integrity.status, "damaged");
    assert.equal(run.integrity.code, "DIGEST_MISMATCH");
    await put(saved.root, saved.resultPath, payload);
  });

  await context.test("renderer also rejects a misleading returned hash and a mismatched tool", async () => {
    const file = await saved.files.read(saved.resultPath);
    await assert.rejects(readVerifiedComputeResult(saved.receipt, async () => ({...file, sha256: "0".repeat(64)})), /no longer match/);
    await assert.rejects(readVerifiedComputeResult(saved.receipt, saved.read, OTHER_TOOL), /requested tool/);
  });
});

test("generic workspace text remains limited to exactly 2 MiB", async () => {
  const saved = await fixture("generic-text-bound", encode({fixture: true}));
  const path = "notes/generic.txt";
  const exact = Buffer.alloc(2 * MiB, "x");
  await put(saved.root, path, exact);
  assert.equal(Buffer.byteLength((await saved.files.read(path)).content), exact.byteLength);
  await put(saved.root, path, Buffer.concat([exact, Buffer.from("x")]));
  await assert.rejects(saved.files.read(path), /bounded/);
});

test("invalid, mismatched, missing and hard-linked manifests cannot authorize Compute result reads", async context => {
  const saved = await fixture("manifest-guard", encode({fixture: "small negative fixtures"}));
  for (const [label, invalid] of [
    ["non-object", []], ["schema", {...saved.manifest, schema_version: "other"}],
    ["run identity", {...saved.manifest, run_id: "f".repeat(32)}],
  ]) {
    await context.test(label, async () => {
      await put(saved.root, saved.manifestPath, encode(invalid));
      await assert.rejects(saved.files.read(saved.resultPath), /identity is invalid/);
      const {run} = await saved.api({action: "open-run", runId: saved.id});
      assert.notEqual(run.integrity.status, "verified");
      await put(saved.root, saved.manifestPath, saved.manifestBytes);
    });
  }
  await context.test("malformed JSON", async () => {
    await put(saved.root, saved.manifestPath, Buffer.from("{not JSON}"));
    await assert.rejects(saved.files.read(saved.resultPath), SyntaxError);
    await put(saved.root, saved.manifestPath, saved.manifestBytes);
  });
  await context.test("missing manifest", async () => {
    await unlink(join(saved.root, saved.manifestPath));
    await assert.rejects(saved.files.read(saved.resultPath), error => error?.code === "ENOENT");
    await put(saved.root, saved.manifestPath, saved.manifestBytes);
  });
  await context.test("hard-linked manifest", async () => {
    const alias = join(saved.root, "manifest-hardlink.json");
    await link(join(saved.root, saved.manifestPath), alias);
    await assert.rejects(saved.files.read(saved.resultPath), /bounded regular manifest/);
    assert.notEqual((await saved.api({action: "open-run", runId: saved.id})).run.integrity.status, "verified");
    await unlink(alias);
    assert.equal((await saved.files.read(saved.resultPath)).sha256, hash(saved.result));
  });
});

test("hard-linked result files remain unreadable even with a valid RNA manifest", async () => {
  const saved = await fixture("linked-result", encode({fixture: true}));
  const alias = join(saved.root, "result-hardlink.json");
  await link(join(saved.root, saved.resultPath), alias);
  await assert.rejects(saved.files.read(saved.resultPath), /[Hh]ard-linked|bounded single-link/);
  assert.notEqual((await saved.api({action: "open-run", runId: saved.id})).run.integrity.status, "verified");
  await unlink(alias);
});
