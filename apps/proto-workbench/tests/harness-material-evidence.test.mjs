import test from "node:test";
import assert from "node:assert/strict";
import {verifyMaterialEvidence} from "../src/main/services/harness-material-evidence.ts";

const a = {resourceId: "igem:00101ed1-6d04-4863-b347-7a32fa095f74", sequenceSha256: "ad04141962efe3b13437737d648cac44738ec28ad58b92bdbdc2c712554f85e5", length: 37, sourceReferences: ["iGEM Registry", "00101ed1-6d04-4863-b347-7a32fa095f74", "https://registry.example/00101ed1-6d04-4863-b347-7a32fa095f74"], licenseIds: ["CC-BY-4.0"]};
const b = {resourceId: "uniprot:P00634", sequenceSha256: "b".repeat(64), length: 471, sourceReferences: ["UniProt", "P00634", "https://uniprot.example/P00634"], licenseIds: ["CC0-1.0"]};
const requirement = {minimumRecords: 2, fields: ["sequence_sha256", "source", "license", "length"]};
const row = record => `| ${record.resourceId} | ${record.sequenceSha256} | ${record.length} | ${record.sourceReferences.join(" ")} | ${record.licenseIds[0]} |`;
const table = records => "| Resource ID | Sequence SHA-256 | Length | Source | License |\n| --- | --- | --- | --- | --- |\n" + records.map(row).join("\n");
const codes = diagnostics => diagnostics.map(item => item.code);

test("exact same-resource metadata succeeds in a Markdown table", () => {
  assert.deepEqual(verifyMaterialEvidence([a, b], [table([a, b])], requirement), []);
});

test("real lost-two-character SHA regression cannot complete a saved material report", () => {
  const wrong = {...a, sequenceSha256: "ad04141962efe3b134377d648cac44738ec28ad58b92bdbdc2c712554f85e5"};
  assert.equal(wrong.sequenceSha256.length, 62);
  const diagnostics = verifyMaterialEvidence([a, b], [table([wrong, b])], requirement);
  assert.ok(codes(diagnostics).includes("MATERIAL_HASH_MISMATCH"));
  assert.ok(diagnostics.some(item => item.resourceId === a.resourceId && item.field === "sequence_sha256"));
});

test("correct hash elsewhere cannot conceal a wrong hash in another saved report", () => {
  const diagnostics = verifyMaterialEvidence([a], [table([a]), table([{...a, sequenceSha256: "c".repeat(64)}])], {...requirement, minimumRecords: 1});
  assert.ok(codes(diagnostics).includes("MATERIAL_HASH_MISMATCH"));
});

test("swapping record hashes, source URLs or licenses fails their associations", () => {
  for (const field of ["sequenceSha256", "sourceReferences", "licenseIds", "length"]) {
    const diagnostics = verifyMaterialEvidence([a, b], [table([{...a, [field]: b[field]}, {...b, [field]: a[field]}])], requirement);
    assert.ok(diagnostics.length, field);
    assert.ok(diagnostics.some(item => item.resourceId === a.resourceId), field);
    assert.ok(diagnostics.some(item => item.resourceId === b.resourceId), field);
  }
});

test("all requested source references must be retained, not merely a provider word", () => {
  const diagnostics = verifyMaterialEvidence([a], [table([{...a, sourceReferences: ["iGEM Registry"]}])], {...requirement, minimumRecords: 1});
  assert.ok(diagnostics.some(item => item.field === "source" && item.code === "MATERIAL_FIELD_MISSING"));
});

test("protein summary and rights table can split fields while keeping exact protein identity", () => {
  const summary = JSON.stringify([{id: b.resourceId, sequence_sha256: b.sequenceSha256, length: b.length}]);
  const evidence = `| ID | Source | License |\n|---|---|---|\n|${b.resourceId}|${b.sourceReferences.join(" ")}|${b.licenseIds[0]}|`;
  assert.deepEqual(verifyMaterialEvidence([b], [summary, evidence], {...requirement, minimumRecords: 1}), []);
});

test("JSON field order cannot move metadata to a different record", () => {
  const record = value => ({source: {provider: value.sourceReferences[0], record_id: value.sourceReferences[1], url: value.sourceReferences[2]}, license: {id: value.licenseIds[0]}, sequence_sha256: value.sequenceSha256, length: value.length, resource_id: value.resourceId});
  assert.deepEqual(verifyMaterialEvidence([a, b], [JSON.stringify({records: [record(a), record(b)]}, null, 2)], requirement), []);
  assert.ok(verifyMaterialEvidence([a, b], [JSON.stringify({records: [record({...a, sequenceSha256: b.sequenceSha256}), record(b)]})], requirement).length);
});

test("one-resource prose sections and uppercase full hashes remain supported", () => {
  const report = [a, b].map(record => `## ${record.resourceId}\nSequence SHA256: ${record.sequenceSha256.toUpperCase()}\nLength: ${record.length}\nSource: ${record.sourceReferences.join(" ")}\nLicense: ${record.licenseIds[0]}`).join("\n\n");
  assert.deepEqual(verifyMaterialEvidence([a, b], [report], requirement), []);
});

test("unknown namespace identities and duplicate receipt conflicts cannot pass", () => {
  assert.ok(codes(verifyMaterialEvidence([a], [table([a]) + "\nigem:invented-resource"], {...requirement, minimumRecords: 1})).includes("MATERIAL_ID_UNKNOWN"));
  assert.ok(codes(verifyMaterialEvidence([a, {...a, sequenceSha256: "f".repeat(64)}], [table([a])], {...requirement, minimumRecords: 1})).includes("MATERIAL_RECEIPT_CONFLICT"));
});

test("duplicate citations do not satisfy a distinct-record count", () => {
  assert.ok(codes(verifyMaterialEvidence([a, b], [table([a, a])], requirement)).includes("MATERIAL_RECORD_COUNT"));
});

test("unrequested fields are optional but a stated wrong protein length still fails", () => {
  assert.deepEqual(verifyMaterialEvidence([b], [b.resourceId], {minimumRecords: 1, fields: []}), []);
  const report = JSON.stringify({id: b.resourceId, length: 470});
  assert.ok(verifyMaterialEvidence([b], [report], {minimumRecords: 1, fields: []}).some(item => item.field === "length" && item.code === "MATERIAL_FIELD_MISMATCH"));
});

test("unrelated artifact hashes are not relabelled as sequence hash claims", () => {
  const report = table([a]) + "\nArtifact SHA256: " + "e".repeat(64);
  assert.deepEqual(verifyMaterialEvidence([a], [report], {...requirement, minimumRecords: 1}), []);
});

test("resource IDs and source URL paths keep their exact case", () => {
  assert.ok(verifyMaterialEvidence([b], [table([{...b, resourceId: "uniprot:p00634"}])], {...requirement, minimumRecords: 1}).length);
  assert.ok(verifyMaterialEvidence([b], [table([{...b, sourceReferences: ["UniProt", "P00634", "https://uniprot.example/p00634"]}])], {...requirement, minimumRecords: 1}).some(item => item.field === "source"));
});

test("extra invented plain protein IDs fail even when the required real record is also present", () => {
  const protein = {...b, resourceId: "phoa"};
  const valid = {id: protein.resourceId, sequence_sha256: protein.sequenceSha256, length: protein.length, source: protein.sourceReferences.join(" "), license: protein.licenseIds[0]};
  assert.ok(codes(verifyMaterialEvidence([protein], [JSON.stringify([valid, {...valid, id: "invented"}])], {...requirement, minimumRecords: 1})).includes("MATERIAL_ID_UNKNOWN"));
  assert.ok(codes(verifyMaterialEvidence([protein], [table([protein, {...protein, resourceId: "invented"}])], {...requirement, minimumRecords: 1})).includes("MATERIAL_ID_UNKNOWN"));
});

test("bounded JSON traversal cannot silently skip later material claims", () => {
  const record = {id: b.resourceId, sequence_sha256: b.sequenceSha256, length: b.length, source: b.sourceReferences.join(" "), license: b.licenseIds[0]};
  const report = JSON.stringify({records: [{...record, sequence_sha256: "e".repeat(64)}, ...Array.from({length: 20_000}, () => ({})), record]});
  assert.ok(codes(verifyMaterialEvidence([b], [report], {...requirement, minimumRecords: 1})).includes("MATERIAL_REPORT_LIMIT"));
});

const jsonRecord = record => ({
  resource_id: record.resourceId, sequence_sha256: record.sequenceSha256, length: record.length,
  source: {provider: record.sourceReferences[0], record_id: record.sourceReferences[1], url: record.sourceReferences[2]},
  license: record.licenseIds[0],
});
const one = {...requirement, minimumRecords: 1};

test("malformed duplicate hashes cannot borrow a correct copy from another row", () => {
  for (const sequence_sha256 of ["deadbeef", "not-a-digest", 42, null, {example: a.sequenceSha256}]) {
    const diagnostics = verifyMaterialEvidence([a], [table([a]), JSON.stringify({...jsonRecord(a), sequence_sha256})], one);
    assert.ok(codes(diagnostics).includes("MATERIAL_HASH_MISMATCH"), JSON.stringify(sequence_sha256));
  }
  assert.ok(codes(verifyMaterialEvidence([a], [table([a]), table([{...a, sequenceSha256: "deadbeef"}])], one)).includes("MATERIAL_HASH_MISMATCH"));
});

test("negative, fractional and nested lengths cannot become a correct integer", () => {
  for (const length of [-37, "-37", 37.5, "37.0", {length: 37}, null]) {
    const diagnostics = verifyMaterialEvidence([a], [JSON.stringify({...jsonRecord(a), length})], one);
    assert.ok(diagnostics.some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === "length"), JSON.stringify(length));
  }
});

test("fabricated source fields cannot borrow exact source values from notes", () => {
  const record = {...a, sourceFields: jsonRecord(a).source};
  const source = {provider: "Fabricated provider", record_id: "Wrong-ID", url: a.sourceReferences[2]};
  const report = JSON.stringify({...jsonRecord(a), source, notes: a.sourceReferences.join(" ")});
  assert.ok(verifyMaterialEvidence([record], [report], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === "source"));
});

test("provider, record identity and URL remain bound to their individual roles", () => {
  const record = {...a, sourceFields: jsonRecord(a).source};
  const source = {...record.sourceFields, provider: record.sourceFields.record_id, record_id: record.sourceFields.provider};
  assert.ok(verifyMaterialEvidence([record], [JSON.stringify({...jsonRecord(a), source})], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === "source"));
});

test("a second fabricated URL claim fails even beside a fully correct record", () => {
  const documents = [JSON.stringify(jsonRecord(a)), JSON.stringify({resource_id: a.resourceId, source: {url: "fabricated-not-a-url"}})];
  assert.ok(verifyMaterialEvidence([a], documents, one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === "source"));
});

test("negated or embellished license text is not the recorded license identity", () => {
  for (const license of ["NOT CC-BY-4.0", "CC-BY-4.0 withdrawn", {notes: "CC-BY-4.0"}]) {
    assert.ok(verifyMaterialEvidence([a], [JSON.stringify({...jsonRecord(a), license})], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === "license"));
  }
});

test("a later wrong hash beyond 32K characters cannot be silently truncated", () => {
  const report = `## ${a.resourceId}\nSequence SHA256: ${a.sequenceSha256}\nLength: ${a.length}\nSource: ${a.sourceReferences.join(" ")}\nLicense: ${a.licenseIds[0]}\n` + "padding ".repeat(5000) + `\nSequence SHA256: ${"e".repeat(64)}`;
  assert.ok(codes(verifyMaterialEvidence([a], [report], one)).includes("MATERIAL_HASH_MISMATCH"));
});

test("uppercase explicit ID keys cannot hide an invented plain protein identity", () => {
  const record = {...a, resourceId: "toy_protein_a"};
  const report = JSON.stringify([jsonRecord(record), {ID: "invented_toy_protein", length: 99, sequence_sha256: "f".repeat(64)}]);
  assert.ok(codes(verifyMaterialEvidence([record], [report], one)).includes("MATERIAL_ID_UNKNOWN"));
});

test("correct source and digest examples without typed fields cannot satisfy metadata", () => {
  const {resource_id, ...unboundMetadata} = jsonRecord(a);
  const report = JSON.stringify({resource_id, notes: unboundMetadata});
  assert.ok(codes(verifyMaterialEvidence([a], [report], one)).includes("MATERIAL_FIELD_MISSING"));
});

test("numeric-only SHA and zero-padded source identifiers stay exact in Markdown", () => {
  const record = {...a, sequenceSha256: "1234567890".repeat(6) + "1234", sourceReferences: ["0012"], sourceFields: {record_id: "0012"}};
  assert.deepEqual(verifyMaterialEvidence([record], [table([record])], one), []);
});

test("duplicate JSON keys cannot erase a prior wrong digest or source claim", () => {
  const record = JSON.stringify(jsonRecord(a));
  const duplicateHash = record.replace('"sequence_sha256":', '"sequence_sha256":"deadbeef","sequence_sha256":');
  const duplicateSource = record.replace('"provider":', '"provider":"Fabricated provider","provider":');
  for (const report of [duplicateHash, duplicateSource, `\`\`\`json\n${duplicateHash}\n\`\`\``]) {
    assert.ok(verifyMaterialEvidence([a], [report], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && /Duplicate/.test(item.message)));
  }
});

test("source negations in non-ASCII text cannot be mistaken for formatting", () => {
  for (const prefix of ["并非 ", "不是 ", "非 ", "❌ ", "не "]) {
    const report = JSON.stringify({...jsonRecord(a), source: prefix + a.sourceReferences.join("; ")});
    assert.ok(verifyMaterialEvidence([a], [report], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === "source"), prefix);
  }
  assert.deepEqual(verifyMaterialEvidence([a], [JSON.stringify({...jsonRecord(a), source: "来源：" + a.sourceReferences.join("；")})], one), []);
});

test("conflicting known identities cannot hide invalid claims beside good records", () => {
  const report = JSON.stringify([jsonRecord(a), jsonRecord(b), {resource_id: a.resourceId, protein_id: b.resourceId, length: -37}]);
  assert.ok(verifyMaterialEvidence([a, b], [report], requirement).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && /conflicting identities/.test(item.message)));
});

test("explicit null or empty identity fields cannot disappear beside valid records", () => {
  for (const resource_id of [null, "", 42]) {
    const report = JSON.stringify([jsonRecord(a), {resource_id, sequence_sha256: "bad"}]);
    assert.ok(verifyMaterialEvidence([a], [report], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH"));
  }
});

const richRecord = {...a, sourceFields: {...jsonRecord(a).source, release: "2025-04-03T12:01:02Z", revision: "2025-04-03T12:01:02Z"}, licenseFields: {id: a.licenseIds[0], redistribution_status: "REDISTRIBUTABLE", url: "https://license.example/legalcode"}};
const richReport = record => `# Resource\n- resource_id: \`${record.resourceId}\`\n- sequence_sha256: \`${record.sequenceSha256}\`\n- length: ${record.length}\n- source: provider "${record.sourceFields.provider}", record_id \`${record.sourceFields.record_id}\`, release/revision \`${record.sourceFields.release}\`, url ${record.sourceFields.url}\n- license (rights): id \`${record.licenseFields.id}\`, redistribution_status \`${record.licenseFields.redistribution_status}\`, url ${record.licenseFields.url}`;

test("truthful labeled source versions and rights metadata remain exact in prose", () => {
  assert.deepEqual(verifyMaterialEvidence([richRecord], [richReport(richRecord)], one), []);
});

test("combined source version labels must match both receipt roles", () => {
  const record = {...richRecord, sourceFields: {...richRecord.sourceFields, revision: "2026-01-01"}};
  assert.ok(verifyMaterialEvidence([record], [richReport(richRecord)], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === "source"));
});

test("wrong source versions, rights status and license URLs cannot borrow nearby truthful text", () => {
  for (const [value, field] of [[richRecord.sourceFields.release, "source"], [richRecord.licenseFields.redistribution_status, "license"], [richRecord.licenseFields.url, "license"]]) {
    const report = richReport(richRecord).replace(value, "fabricated-value") + `\nUnrelated notes: ${value}`;
    assert.ok(verifyMaterialEvidence([richRecord], [report], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === field));
  }
});

test("nested JSON metadata is checked and duplicate version keys cannot erase claims", () => {
  const record = {...jsonRecord(richRecord), source: richRecord.sourceFields, license: richRecord.licenseFields};
  assert.deepEqual(verifyMaterialEvidence([richRecord], [JSON.stringify(record)], one), []);
  const wrong = {...record, license: {...record.license, url: "https://fabricated.invalid/"}};
  assert.ok(verifyMaterialEvidence([richRecord], [JSON.stringify(wrong)], one).some(item => item.field === "license"));
  const duplicate = JSON.stringify(record).replace('"release":', '"release":"fabricated","release":');
  assert.ok(verifyMaterialEvidence([richRecord], [duplicate], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && /Duplicate/.test(item.message)));
});

test("mixed Markdown and JSON reports support actual values without accepting bad copies", () => {
  const document = `Evidence token: Literal-AbC\n\n\`\`\`json\n${JSON.stringify([jsonRecord(a), jsonRecord(b)], null, 2)}\n\`\`\`\nReview remains required.`;
  assert.deepEqual(verifyMaterialEvidence([a, b], [document], requirement), []);
  const badBlock = `\n\`\`\`json\n${JSON.stringify({...jsonRecord(a), sequence_sha256: "bad"})}\n\`\`\``;
  assert.ok(verifyMaterialEvidence([a, b], [document + badBlock], requirement).some(item => item.code === "MATERIAL_HASH_MISMATCH"));
  assert.ok(verifyMaterialEvidence([a, b], [document + '\n```json\n{"broken":\n```'], requirement).length);
});

test("metadata after a JSON block cannot attach to a prior unrelated resource heading", () => {
  const report = `# ${a.resourceId}\n\`\`\`json\n${JSON.stringify({resource_id: b.resourceId, length: b.length})}\n\`\`\`\nlength: ${a.length}`;
  assert.ok(verifyMaterialEvidence([a, b], [report], {minimumRecords: 2, fields: ["length"]}).some(item => item.code === "MATERIAL_FIELD_MISSING" && item.resourceId === a.resourceId));
});

test("unknown typed source roles cannot borrow another known source value", () => {
  const report = JSON.stringify({...jsonRecord(richRecord), source: {...richRecord.sourceFields, invented_role: richRecord.sourceFields.provider}, license: richRecord.licenseFields});
  assert.ok(verifyMaterialEvidence([richRecord], [report], one).some(item => item.code === "MATERIAL_FIELD_MISMATCH" && item.field === "source"));
  assert.doesNotThrow(() => verifyMaterialEvidence([richRecord], [richReport(richRecord).replace('provider "iGEM Registry"', 'provider "iGEM\\q Registry"')], one));
});
