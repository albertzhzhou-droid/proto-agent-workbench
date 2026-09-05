import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProteinStructureService, validateAccession, validateAlphaFoldDownload, validateOfficialStructureUrl, validateStructureText } from "../src/main/services/protein-structures.ts";
import { mapProteinStructure, chooseUnambiguousChain } from "../src/renderer/protein-structure-mapping.ts";
import { parseDesignIr } from "../src/renderer/design-visualization.ts";
import { proteinStructureFixture, PDB_FIXTURE } from "./helpers/protein-structure-fixture.mjs";
import { parsePDB } from "molstar/lib/mol-io/reader/pdb/parser.js";
import { trajectoryFromPDB } from "molstar/lib/mol-model-formats/structure/pdb.js";
import { extractProteinChains, bindProteinContextLoss } from "../src/renderer/molstar-protein-viewer.ts";
import { validateProteinCamera, validateProteinViewState } from "../src/shared/protein-view-state.ts";

const CAMERA = { mode: "perspective", fov: Math.PI / 4, position: [0, 0, 90], target: [0, 0, 0], up: [0, 1, 0], radius: 10, radiusMax: 20, fog: 0, clipFar: true, minNear: 5, minFar: 0 };
const VIEW = { modelIndex: 0, chainId: "0:A", representation: "cartoon", color: "chain", selectedRange: { start: 1, end: 3 }, explicitStartOneBased: null, camera: CAMERA };

test("camera and view restore reject nonfinite, degenerate, unsupported and out-of-sequence state", () => {
  assert.deepEqual(validateProteinCamera(CAMERA), CAMERA);
  for (const camera of [{ ...CAMERA, fov: Infinity }, { ...CAMERA, position: [0, 0, 0] }, { ...CAMERA, up: [0, 0, 1] }, { ...CAMERA, target: [0, NaN, 0] }]) assert.throws(() => validateProteinCamera(camera));
  assert.deepEqual(validateProteinViewState(VIEW, 3, false), VIEW);
  assert.throws(() => validateProteinViewState({ ...VIEW, selectedRange: { start: 1, end: 4 } }, 3, false), /selection/);
  assert.throws(() => validateProteinViewState({ ...VIEW, color: "confidence" }, 3, false), /options/);
  assert.throws(() => validateProteinViewState({ ...VIEW, modelIndex: 64 }, 3, false), /options/);
});

test("WebGL loss notifies once and disposal detaches the native listener", () => {
  const canvas = new EventTarget(); let losses = 0;
  const dispose = bindProteinContextLoss(canvas, () => { losses += 1; });
  const loss = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(loss); canvas.dispatchEvent(new Event("webglcontextlost"));
  assert.equal(loss.defaultPrevented, true); assert.equal(losses, 1);
  dispose(); canvas.dispatchEvent(new Event("webglcontextlost")); assert.equal(losses, 1);
});

test("saved views reopen exact camera and selection, replace safely and reject binding tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "proto-structure-view-test-"));
  try {
    const fixture = proteinStructureFixture();
    await writeFile(join(root, fixture.target.artifactPath), fixture.text);
    await writeFile(join(root, "coordinates.pdb"), PDB_FIXTURE);
    const service = new ProteinStructureService(root);
    const data = await service.importLocal(fixture.target, join(root, "coordinates.pdb"));
    const input = { target: fixture.target, attachmentId: data.attachment.id };
    assert.equal(await service.readView(input), null);
    const saved = await service.saveView({ ...input, view: VIEW });
    assert.deepEqual((await service.readView(input)).view, VIEW);
    const rotated = { ...VIEW, camera: { ...CAMERA, position: [20, 0, 80] } };
    await service.saveView({ ...input, view: rotated });
    assert.deepEqual((await service.readView(input)).view, rotated);
    const directory = join(root, "build", "protein-structures", "views");
    const files = await readdir(directory); assert.equal(files.length, 1);
    const path = join(directory, files[0]);
    const tampered = JSON.parse(await readFile(path, "utf8")); tampered.contentSha256 = "0".repeat(64);
    await writeFile(path, JSON.stringify(tampered));
    await assert.rejects(service.readView(input), /does not match/);
    assert.equal(saved.contentSha256, data.attachment.contentSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function chain(sequence = "AGC", residues = [...sequence].map((oneLetter, polymerIndex) => ({ key: `0:A:${polymerIndex + 1}:${polymerIndex + 10}:`,
  oneLetter, polymerIndex, labelSeqId: polymerIndex + 1, authSeqId: polymerIndex + 10, insertionCode: "", confidence: null }))) {
  return { id: "0:A", modelIndex: 0, labelAsymId: "A", authAsymId: "A", sequence, residues };
}

test("structure mapping preserves deposited numbering and missing residues", () => {
  const model = chain(); model.residues.splice(1, 1);
  const mapping = mapProteinStructure("AGC", model);
  assert.equal(mapping.status, "exact");
  assert.deepEqual(mapping.positions.map((item) => [item.proteinIndex, item.residue.authSeqId]), [[0, 10], [2, 12]]);
  assert.equal(mapping.coverage, 2 / 3);
});

test("real Molstar PDB parser preserves numbering and does not infer local-file confidence", async () => {
  const parsed = await parsePDB(PDB_FIXTURE).run();
  assert.equal(parsed.isError, false);
  const trajectory = await trajectoryFromPDB(parsed.result).run();
  const local = extractProteinChains(trajectory.representative, false, 0);
  assert.equal(local[0].sequence, "AGC");
  assert.deepEqual(local[0].residues.map((item) => item.authSeqId), [10, 11, 12]);
  assert.ok(local[0].residues.every((item) => item.confidence === null));
  const predicted = extractProteinChains(trajectory.representative, true, 0);
  assert.deepEqual(predicted[0].residues.map((item) => item.confidence), [95, 82, 41]);
  assert.equal(mapProteinStructure("AGC", local[0]).status, "exact");
  trajectory.representative.atomicConformation.x[0] = Infinity;
  assert.throws(() => extractProteinChains(trajectory.representative, false, 0), /coordinates/);
});

test("partial, mutated, ambiguous and duplicate residue mappings fail closed", () => {
  assert.equal(mapProteinStructure("MAGCQ", chain()).status, "unmapped");
  assert.equal(mapProteinStructure("MAGCQ", chain(), 2).status, "explicit-partial");
  assert.equal(mapProteinStructure("MAGCQ", chain(), 1).status, "unmapped");
  assert.equal(mapProteinStructure("MASCQ", chain(), 2).status, "unmapped");
  assert.equal(mapProteinStructure("AXC", chain("AXC")).status, "unmapped");
  const duplicate = chain(); duplicate.residues[1].polymerIndex = 0;
  assert.equal(mapProteinStructure("AGC", duplicate).status, "unmapped");
  assert.equal(chooseUnambiguousChain("AGC", [chain(), { ...chain(), id: "0:B" }]), "");
  assert.equal(chooseUnambiguousChain("AGC", [chain()]), "0:A");
});

test("only fixed official structure endpoints and matching AlphaFold entries are allowed", () => {
  assert.equal(validateAccession("pdb", "1gfl"), "1GFL");
  assert.equal(validateAccession("alphafold", "P42212"), "P42212");
  for (const id of ["../secret", "https://127.0.0.1", "1GFL?x=1"]) assert.throws(() => validateAccession("pdb", id));
  for (const url of ["http://files.rcsb.org/download/1GFL.cif", "https://127.0.0.1/test", "https://files.rcsb.org.evil.test/download/1GFL.cif", "https://user@files.rcsb.org/download/1GFL.cif", "https://files.rcsb.org/download/1GFL.cif?secret=x"]) assert.throws(() => validateOfficialStructureUrl(url));
  assert.equal(validateAlphaFoldDownload("https://alphafold.ebi.ac.uk/files/AF-P42212-F1-model_v6.cif", "P42212"), "https://alphafold.ebi.ac.uk/files/AF-P42212-F1-model_v6.cif");
  assert.throws(() => validateAlphaFoldDownload("https://alphafold.ebi.ac.uk/files/AF-P12345-F1-model_v6.cif", "P42212"));
  assert.throws(() => validateStructureText(Buffer.from("<html>not coordinates</html>"), "mmcif"));
  assert.throws(() => validateStructureText(Buffer.from("ATOM  \0"), "pdb"));
});

test("local attachments bind exact IR and content; local confidence claims are withheld", async () => {
  const root = await mkdtemp(join(tmpdir(), "proto-structures-test-"));
  try {
    const fixture = proteinStructureFixture();
    assert.equal(parseDesignIr(fixture.ir).ok, true, JSON.stringify(parseDesignIr(fixture.ir).diagnostics));
    await writeFile(join(root, fixture.target.artifactPath), fixture.text);
    await writeFile(join(root, "coordinates.pdb"), PDB_FIXTURE);
    const service = new ProteinStructureService(root);
    const data = await service.importLocal(fixture.target, join(root, "coordinates.pdb"));
    assert.equal(data.attachment.source.classification, "unknown");
    assert.equal(data.attachment.source.url, null);
    assert.equal(data.attachment.source.license, "NOASSERTION");
    assert.equal(data.text, PDB_FIXTURE);
    assert.equal((await service.list(fixture.target)).length, 1);
    const again = await service.importLocal(fixture.target, join(root, "coordinates.pdb"));
    assert.equal(data.attachment.id, again.attachment.id);
    await assert.rejects(service.read({ target: fixture.target, attachmentId: "../../coordinates" }), /ID/);
    const coordinatePath = join(root, "build", "protein-structures", fixture.target.sequenceSha256, `${data.attachment.id}.pdb`);
    await writeFile(coordinatePath, PDB_FIXTURE.replace("95.00", "94.00"));
    await assert.rejects(service.read({ target: fixture.target, attachmentId: data.attachment.id }), /digest mismatch/);
    await writeFile(join(root, fixture.target.artifactPath), `${fixture.text}\n`);
    await assert.rejects(service.list(fixture.target), /artifact changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("structure downloads reject redirects and streamed size violations", async () => {
  const root = await mkdtemp(join(tmpdir(), "proto-structures-network-"));
  try {
    const fixture = proteinStructureFixture(); await writeFile(join(root, fixture.target.artifactPath), fixture.text);
    let options;
    const redirecting = new ProteinStructureService(root, { fetch: async (_url, init) => { options = init; return { ok: true, redirected: true }; } });
    await assert.rejects(redirecting.fetch({ target: fixture.target, provider: "pdb", accession: "1GFL" }), /redirects/);
    assert.equal(options.redirect, "error"); assert.ok(options.signal);
    const huge = new ProteinStructureService(root, { fetch: async () => new Response("x", { headers: { "content-length": "9999999999" } }) });
    await assert.rejects(huge.fetch({ target: fixture.target, provider: "pdb", accession: "1GFL" }), /bound/);
    const hijacked = new ProteinStructureService(root, { fetch: async () => new Response(JSON.stringify([{ entryId: "AF-P42212-F1", uniprotAccession: "P42212", cifUrl: "https://127.0.0.1/internal" }])) });
    await assert.rejects(hijacked.fetch({ target: fixture.target, provider: "alphafold", accession: "P42212" }), /official/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
