import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ProteinStructureService } from "../src/main/services/protein-structures.ts";
import { proteinStructureFixture, PDB_FIXTURE } from "./helpers/protein-structure-fixture.mjs";
import { proteinLandscapeRows, renderProteinLandscapeSvg } from "../src/shared/protein-landscape.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
async function decode(_format, bytes, expected) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, expected.width); assert.equal(info.height, expected.height);
  const colors = new Set();
  for (let offset = 0; offset < data.length; offset += 128) colors.add(data.subarray(offset, offset + 4).toString("hex"));
  return { decoder: "test-sharp-independent", width: info.width, height: info.height, pixelSha256: hash(data), sampledColorCount: colors.size };
}
async function fixtureTest(callback, sequence = "AGC") {
  const root = await mkdtemp(join(tmpdir(), "proto-protein-landscape-"));
  try {
    const fixture = proteinStructureFixture(sequence);
    await writeFile(join(root, fixture.target.artifactPath), fixture.text);
    await callback({ root, fixture, service: new ProteinStructureService(root, { verifyTracksImage: decode }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("sequence-only SVG and PNG independently reopen with source/selection metadata and unchanged IR", async () => fixtureTest(async ({ root, fixture, service }) => {
  const request = { target: fixture.target, selectedRange: { start: 1, end: 3 }, structure: null };
  const prepared = await service.prepareTracks(request);
  assert.deepEqual(prepared.metadata.rows.map((row) => row.available), [true, true, false, false]);
  assert.equal(prepared.metadata.structure, null);
  assert.match(prepared.svg, /Sequence-only figure/);
  assert.equal(prepared.svgSha256, hash(prepared.svg));
  for (const format of ["svg", "png"]) {
    const png = format === "png" ? await sharp(Buffer.from(prepared.svg)).png().toBuffer() : undefined;
    const receipt = await service.exportTracks({ request, format, svgSha256: prepared.svgSha256, ...(png ? { png } : {}) });
    const bytes = await readFile(join(root, receipt.relativePath));
    assert.equal(hash(bytes), receipt.sha256); assert(receipt.sampledColorCount > 2);
    const metadata = JSON.parse(await readFile(join(root, receipt.metadataRelativePath), "utf8"));
    assert.deepEqual(metadata.selectedRange, { start: 1, end: 3 });
    assert.equal(metadata.artifactSha256, fixture.target.artifactSha256);
    assert.equal(metadata.sequenceSha256, fixture.target.sequenceSha256);
    assert.equal((await sharp(bytes).metadata()).width, 1600);
    assert.equal((await sharp(bytes).metadata()).height, 620);
    assert.deepEqual(JSON.parse(await readFile(join(root, receipt.verificationRelativePath), "utf8")), receipt);
  }
  assert.equal(await readFile(join(root, fixture.target.artifactPath), "utf8"), fixture.text);
}));

test("main reparses actual coordinates for mapping and refuses guessed fragments or B-factor confidence", async () => fixtureTest(async ({ root, fixture, service }) => {
  await writeFile(join(root, "coordinates.pdb"), PDB_FIXTURE);
  const coordinates = await service.importLocal(fixture.target, join(root, "coordinates.pdb"));
  const request = { target: fixture.target, selectedRange: null, structure: { attachmentId: coordinates.attachment.id, modelIndex: 0, chainId: "0:A", explicitStartOneBased: null } };
  const unmapped = await service.prepareTracks(request);
  assert.equal(unmapped.metadata.structure.mappingStatus, "unmapped");
  assert.equal(unmapped.metadata.rows[2].available, false);
  const mapped = await service.prepareTracks({ ...request, structure: { ...request.structure, explicitStartOneBased: 2 } });
  assert.equal(mapped.metadata.structure.mappingStatus, "explicit-partial");
  assert.equal(mapped.metadata.structure.observedResidues, 3);
  assert.deepEqual(mapped.metadata.rows[2].values, [0, 1, 1, 1, 0]);
  assert.equal(mapped.metadata.rows[3].available, false);
  assert.ok(mapped.metadata.rows[3].values.every((value) => value === null));
  await assert.rejects(service.prepareTracks({ ...request, structure: { ...request.structure, chainId: "0:absent" } }), /absent/);
  await assert.rejects(service.prepareTracks({ ...request, structure: { ...request.structure, modelIndex: 63 } }), /model index/);
}, "MAGCQ"));

test("landscape rejects stale source, prepared digest, ranges and malformed PNG instead of persisting a misleading figure", async () => fixtureTest(async ({ root, fixture, service }) => {
  const request = { target: fixture.target, selectedRange: null, structure: null };
  const prepared = await service.prepareTracks(request);
  await assert.rejects(service.exportTracks({ request, format: "svg", svgSha256: "0".repeat(64) }), /changed/);
  await assert.rejects(service.exportTracks({ request, format: "png", svgSha256: prepared.svgSha256, png: new Uint8Array(24) }), /bytes/);
  await assert.rejects(service.prepareTracks({ ...request, selectedRange: { start: 0, end: 4 } }), /range/);
  await assert.rejects(service.prepareTracks({ ...request, selectedRange: { start: 2, end: 1 } }), /range/);
  await writeFile(join(root, fixture.target.artifactPath), `${fixture.text}\n`);
  await assert.rejects(service.exportTracks({ request, format: "svg", svgSha256: prepared.svgSha256 }), /changed|digest/);
}));

test("vector labels escape markup and unavailable or zero measurements remain honest", () => {
  const values = proteinLandscapeRows("GGG");
  assert.deepEqual(values.rows[0].values, [0, 0, 0]);
  const { svg } = renderProteinLandscapeSvg({ proteinName: '<script>alert("x")</script>', proteinId: "fixture:a&b", length: 3,
    selectedRange: null, structure: null, artifactSha256: "a".repeat(64), sequenceSha256: "b".repeat(64), ...values });
  assert(!svg.includes("<script>")); assert(!/\b(?:href|onload)=/.test(svg));
  assert.match(svg, /&lt;script&gt;/); assert.match(svg, /fixture:a&amp;b/);
  assert(!svg.includes('height="0.000" fill="#7da379"'));
});
