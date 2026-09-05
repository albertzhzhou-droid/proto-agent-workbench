import test from "node:test";
import assert from "node:assert/strict";
import {materialEvidenceRecords} from "../src/main/services/mission-material-contract.ts";

const requirement = recordKind => ({kind: "materials", recordKind, minimumRecords: 1, fields: ["source", "license"]});
const receipt = (tool, data, ok = true) => ({tool, data, ok});
const metadata = () => ({
  source: {provider: "Example Registry", record_id: "0012", url: "https://registry.example/records/0012", release: "2025-02-03T04:05:06Z", revision: "rev-B", retrieved_at: "2026-04-05T06:07:08Z", sequence_sha256: "a".repeat(64)},
  license: {id: "EXAMPLE-1.0", redistribution_status: "REDISTRIBUTABLE", url: "https://license.example/EXAMPLE-1.0", attribution: "Example contributor"},
});

test("catalogue source and rights metadata preserve exact scalar receipt types and values", () => {
  const row = {resource_id: "catalogue:opaque-record", ...metadata()};
  for (const input of [receipt("proto_materials_search", {matches: [row]}), receipt("proto_materials_get", {resource: row})]) {
    const [actual] = materialEvidenceRecords([input], requirement("catalogue"));
    assert.deepEqual(actual.sourceFields, row.source);
    assert.deepEqual(actual.licenseFields, row.license);
    assert.deepEqual(actual.sourceReferences, [row.source.provider, row.source.record_id, row.source.url]);
    assert.deepEqual(actual.licenseIds, [row.license.id]);
    assert.equal(actual.sourceFields.record_id, "0012");
  }
});

test("optional metadata is not coerced, flattened or promoted into required core references", () => {
  const row = {resource_id: "catalogue:opaque-record", source: {...metadata().source, empty: "", count: 12, enabled: true, absent: null, nested: {provider: "other"}, list: ["other"]}, license: {...metadata().license, version: 2, verified: false, notes: {id: "other"}}};
  const [actual] = materialEvidenceRecords([receipt("proto_materials_get", {resource: row})], requirement("catalogue"));
  assert.equal(actual.sourceFields.empty, "");
  for (const key of ["count", "enabled", "absent", "nested", "list"]) assert.equal(Object.hasOwn(actual.sourceFields, key), false);
  for (const key of ["version", "verified", "notes"]) assert.equal(Object.hasOwn(actual.licenseFields, key), false);
  assert.deepEqual(actual.sourceReferences, [row.source.provider, row.source.record_id, row.source.url]);
  assert.deepEqual(actual.licenseIds, [row.license.id]);
});

test("protein metadata remains bound to the inspected output identity rather than provenance identity", () => {
  const row = {id: "selected_protein", resource_id: "catalogue:upstream-record", ...metadata()};
  const [actual] = materialEvidenceRecords([receipt("proto_protein_inspect", {proteins: [row]})], requirement("protein"));
  assert.equal(actual.resourceId, row.id);
  assert.deepEqual(actual.sourceFields, row.source);
  assert.deepEqual(actual.licenseFields, row.license);
});

test("failed receipts and arbitrary workspace content cannot donate material metadata", () => {
  const row = {resource_id: "catalogue:opaque-record", ...metadata()};
  assert.deepEqual(materialEvidenceRecords([
    receipt("proto_materials_get", {resource: row}, false),
    receipt("workspace_read", {resource: row, matches: [row]}),
    receipt("proto_protein_inspect", {proteins: [{id: "other", ...row}]}),
  ], requirement("catalogue")), []);
});
