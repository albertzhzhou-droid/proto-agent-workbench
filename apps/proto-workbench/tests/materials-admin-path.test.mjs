import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  packagedMaterialsCliPath,
  resolveMaterialsRootPath,
  materializedPartsSelectionDigest,
  validateMaterializedPartsArtifact,
  validateMaterializedPartsResult,
} from "../src/main/services/materials-admin.ts";

test("packaged Materials CLI follows the PyInstaller onedir resource layout", () => {
  const resourcesPath = resolve("fixture-resources");
  assert.equal(
    packagedMaterialsCliPath(resourcesPath),
    join(
      resourcesPath,
      "runtime",
      "proto-agent",
      "proto-agent",
      "proto-agent.exe",
    ),
  );
});

test("explicit absolute materials root overrides development and packaged defaults", () => {
  const configuredRoot = resolve("external-materials");
  for (const isPackaged of [false, true]) {
    assert.equal(resolveMaterialsRootPath({
      configuredRoot,
      isPackaged,
      documentsPath: resolve("documents"),
      repoRoot: resolve("repo"),
    }), configuredRoot);
  }
});

test("materials root defaults stay outside the source and packaged application bundles", () => {
  const repoRoot = resolve("workspace", "Proto CLI");
  const documentsPath = resolve("fixture-documents");
  assert.equal(resolveMaterialsRootPath({
    isPackaged: false,
    documentsPath,
    repoRoot,
  }), resolve(repoRoot, "..", "Proto CLI Materials"));
  assert.equal(resolveMaterialsRootPath({
    isPackaged: true,
    documentsPath,
    repoRoot,
  }), join(documentsPath, "Proto CLI Materials"));
});

test("relative materials root overrides fail closed", () => {
  assert.throws(() => resolveMaterialsRootPath({
    configuredRoot: "relative-materials",
    isPackaged: false,
    documentsPath: resolve("documents"),
    repoRoot: resolve("repo"),
  }), /must be an absolute path/u);
});

test("materials activation IPC forwards bounded operator evidence to the CLI", async () => {
  const source = await readFile(resolve("src", "main", "index.ts"), "utf8");
  assert.match(source, /IPC\.materialsActivate[\s\S]*?`--operator=\$\{evidence\.operator\}`[\s\S]*?`--approval-reference=\$\{evidence\.approval_reference\}`/);
  assert.match(source, /IPC\.materialsRollback[\s\S]*?`--operator=\$\{evidence\.operator\}`[\s\S]*?`--approval-reference=\$\{evidence\.approval_reference\}`/);
  assert.doesNotMatch(source, /materialsActivate[\s\S]{0,240}"human"/);
  assert.doesNotMatch(source, /materialsRollback[\s\S]{0,240}"human"/);
});

test("materialized design selections remain bound to the requested snapshot, digest, path, and count", () => {
  const request = {
    resource_ids: ["igem:second", "igem:first"],
    chassis: "ecoli_k12",
    snapshot: "public-reviewed-2026.09",
  };
  // Fixed compatibility vector from Python's json.dumps(sort_keys=True,
  // separators=(",", ":"), ensure_ascii=False) implementation.
  const digest = "a3c19ff36cc20fd96aab1ba0de8d79a2497ec8f67e711c0fc3ffaee3f0a011a3";
  assert.equal(materializedPartsSelectionDigest(request), digest);
  const result = {
    ok: true,
    snapshot_id: request.snapshot,
    selection_digest: digest,
    parts_path: `build/materials/selections/${digest}/parts.json`,
    part_count: request.resource_ids.length,
  };
  assert.deepEqual(validateMaterializedPartsResult(result, request), result);
  for (const invalid of [
    { ...result, snapshot_id: "different-snapshot" },
    { ...result, selection_digest: "not-a-digest" },
    { ...result, selection_digest: digest.toUpperCase() },
    { ...result, parts_path: "build/materials/selected-parts.json" },
    { ...result, parts_path: `build/materials/selections/${"b".repeat(64)}/parts.json` },
    { ...result, part_count: 1 },
  ]) {
    assert.throws(
      () => validateMaterializedPartsResult(invalid, request),
      /failed its snapshot, digest, path, or count binding/u,
    );
  }
});

test("materialized parts artifact binds canonical JSON, snapshot, chassis, exact IDs, and sequence hashes", () => {
  const request = {
    resource_ids: ["igem:second", "igem:first"],
    chassis: "ecoli_k12",
    snapshot: "public-reviewed-2026.09",
  };
  const digest = materializedPartsSelectionDigest(request);
  const receipt = {
    ok: true,
    snapshot_id: request.snapshot,
    selection_digest: digest,
    parts_path: `build/materials/selections/${digest}/parts.json`,
    part_count: 2,
  };
  const payload = materializedPayload(request, digest);
  assert.deepEqual(validateMaterializedPartsArtifact(materializedArtifact(payload), request, receipt), receipt);

  const attacks = [
    { name: "snapshot", mutate: (value) => { value.version = "other-snapshot"; } },
    { name: "chassis", mutate: (value) => { value.chassis = "other_chassis"; } },
    { name: "digest", mutate: (value) => { value.library_id = `selection:${"b".repeat(64)}`; } },
    { name: "order", mutate: (value) => { value.parts.reverse(); } },
    { name: "identity", mutate: (value) => { value.parts[0].resource_id = "igem:forged"; } },
    { name: "count", mutate: (value) => { value.parts.pop(); } },
    { name: "sequence hash", mutate: (value) => { value.parts[0].sequence = "TTTT"; } },
    { name: "eligibility", mutate: (value) => { value.parts[0].design_eligibility = false; } },
  ];
  for (const attack of attacks) {
    const forged = structuredClone(payload);
    attack.mutate(forged);
    assert.throws(
      () => validateMaterializedPartsArtifact(materializedArtifact(forged), request, receipt),
      /failed|invalid/u,
      attack.name,
    );
  }

  const nonCanonical = `${JSON.stringify(payload, null, 2)}\n`;
  assert.throws(
    () => validateMaterializedPartsArtifact({ content: nonCanonical, sha256: sha256(nonCanonical) }, request, receipt),
    /not canonical JSON/u,
  );
  const artifact = materializedArtifact(payload);
  assert.throws(
    () => validateMaterializedPartsArtifact({ ...artifact, sha256: "0".repeat(64) }, request, receipt),
    /file hash binding/u,
  );
});

test("Materials page materialization reads and validates the generated artifact before returning", async () => {
  const source = await readFile(resolve("src", "main", "index.ts"), "utf8");
  assert.match(source, /IPC\.materialsMaterialize[\s\S]*?mcpClient\.call\("proto_materials_materialize", \{ \.\.\.input \}\)[\s\S]*?validateMaterializedPartsResult\(result, input\)[\s\S]*?workspaceFiles\.read\(validated\.parts_path\)[\s\S]*?validateMaterializedPartsArtifact\(artifact, input, validated\)/u);
});

function materializedPayload(request, digest) {
  return {
    chassis: request.chassis,
    library_id: `selection:${digest}`,
    notice: "Materialized from an auditable external catalog. Human review required; not a wet-lab readiness claim.",
    parts: [
      materializedPart("igem:first", "ACGT"),
      materializedPart("igem:second", "GGCC"),
    ],
    schema_version: "proto-agent.parts-library.v1",
    version: request.snapshot,
  };
}

function materializedPart(resourceId, sequence) {
  const sequenceSha256 = sha256(sequence);
  return {
    description: `Reviewed ${resourceId}`,
    description_zh: "已审查记录",
    design_eligibility: true,
    evidence_refs: [`https://example.test/${resourceId}`],
    id: resourceId,
    license: {
      attribution: "Fixture source",
      id: "CC0-1.0",
      redistribution_status: "REDISTRIBUTABLE",
      rights_notes: "Fixture rights",
      url: "https://creativecommons.org/publicdomain/zero/1.0",
    },
    name: resourceId,
    resource_id: resourceId,
    review_status: "DESIGN_ELIGIBLE",
    safety_flags: [],
    safety_status: "NO_FLAG",
    sequence,
    sequence_kind: "DNA",
    sequence_sha256: sequenceSha256,
    source: {
      content_sha256: sha256(`source:${resourceId}`),
      provider: "fixture",
      record_id: resourceId.split(":", 2)[1],
      release: "v1",
      retrieved_at: "2026-09-02T00:00:00Z",
      revision: "v1",
      sequence_sha256: sequenceSha256,
      url: `https://example.test/${resourceId}`,
    },
    type: resourceId === "igem:first" ? "promoter" : "terminator",
  };
}

function materializedArtifact(payload) {
  const content = `${canonicalJson(payload)}\n`;
  return { content, sha256: sha256(content) };
}

function canonicalJson(value) {
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
