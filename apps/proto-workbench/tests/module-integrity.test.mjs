import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";
import { verifyModuleIntegrity } from "../src/main/services/module-integrity.ts";
import { CORE_MODULES, OPTIONAL_MODULES } from "../src/shared/modules.ts";

test("a verified manifest gives every module an independently visible SHA-256", async () => {
  const fixture = await integrityFixture();
  const report = await verifyModuleIntegrity({
    appRoot: fixture.appRoot,
    resourceRoot: fixture.resourceRoot,
    enforce: true,
    expectedAppVersion: "0.1.2",
  });
  assert.equal(report.ok, true);
  assert.equal(report.enforced, true);
  assert.equal(report.modules.length, CORE_MODULES.length + OPTIONAL_MODULES.length);
  for (const module of report.modules) {
    assert.equal(module.status, "verified");
    assert.match(module.moduleSha256, /^[a-f0-9]{64}$/);
    assert.equal(module.disposition, module.core ? "loaded" : "available");
  }
});

test("optional tampering is quarantined without weakening verified core modules", async () => {
  const fixture = await integrityFixture();
  await writeFile(fixture.optionalPaths.get("evidence.crossref"), "tampered", "utf8");
  const report = await verifyModuleIntegrity({
    appRoot: fixture.appRoot,
    resourceRoot: fixture.resourceRoot,
    enforce: true,
    expectedAppVersion: "0.1.2",
  });
  assert.equal(report.ok, true);
  assert.equal(report.modules.find((module) => module.moduleId === "evidence.crossref")?.disposition, "quarantined");
  assert.equal(report.modules.find((module) => module.moduleId === "core.audit")?.status, "verified");
});

test("core tampering blocks startup and the append-only audit record survives", async () => {
  const fixture = await integrityFixture();
  await writeFile(fixture.corePaths.get("core.audit"), "tampered", "utf8");
  const report = await verifyModuleIntegrity({
    appRoot: fixture.appRoot,
    resourceRoot: fixture.resourceRoot,
    enforce: true,
    expectedAppVersion: "0.1.2",
  });
  assert.equal(report.ok, false);
  assert.equal(report.modules.find((module) => module.moduleId === "core.audit")?.disposition, "blocked-startup");

  const database = new AppDatabase(":memory:");
  try {
    const audited = database.appendModuleAudit(report);
    assert.match(audited.auditId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(database.listModuleAudits(1), [audited]);
  } finally {
    database.close();
  }
});

test("tampering a packaged trust root blocks startup through core governance", async () => {
  const fixture = await integrityFixture();
  await writeFile(fixture.trustPath, '{"checkpoint":"tampered"}\n', "utf8");
  const report = await verifyModuleIntegrity({
    appRoot: fixture.appRoot,
    resourceRoot: fixture.resourceRoot,
    enforce: true,
    expectedAppVersion: "0.1.2",
  });
  const governance = report.modules.find((module) => module.moduleId === "core.governance");
  assert.equal(report.ok, false);
  assert.equal(governance?.status, "tampered");
  assert.equal(governance?.disposition, "blocked-startup");
  assert.ok(governance?.diagnostics.some((diagnostic) => /runtime\/trust\/checkpoint\.json/.test(diagnostic)));
});

test("a packaged build cannot proceed without an integrity manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "proto-workbench-no-manifest-"));
  const report = await verifyModuleIntegrity({ appRoot: root, resourceRoot: root, enforce: true });
  assert.equal(report.ok, false);
  assert.equal(report.modules.every((module) => module.disposition === (module.core ? "blocked-startup" : "quarantined")), true);
});

async function integrityFixture() {
  const root = await mkdtemp(join(tmpdir(), "proto-workbench-integrity-"));
  const appRoot = join(root, "app");
  const resourceRoot = join(root, "resources");
  await mkdir(join(appRoot, "out", "modules"), { recursive: true });
  await mkdir(join(resourceRoot, "modules"), { recursive: true });
  await mkdir(join(resourceRoot, "runtime", "modules"), { recursive: true });
  await mkdir(join(resourceRoot, "runtime", "trust"), { recursive: true });
  const corePaths = new Map();
  const optionalPaths = new Map();
  const modules = [];
  const trustPath = join(resourceRoot, "runtime", "trust", "checkpoint.json");
  const trustContent = '{"checkpoint":"trusted"}\n';
  await writeFile(trustPath, trustContent, "utf8");
  const trustArtifact = {
    scope: "resource",
    path: "runtime/trust/checkpoint.json",
    sizeBytes: Buffer.byteLength(trustContent),
    sha256: sha256(trustContent),
  };

  for (const descriptor of [...CORE_MODULES, ...OPTIONAL_MODULES]) {
    const safeId = descriptor.id.replaceAll(".", "-");
    const scope = descriptor.core ? "app" : "resource";
    const relativePath = descriptor.core ? `out/modules/${safeId}.bin` : `modules/${safeId}.bin`;
    const absolutePath = join(scope === "app" ? appRoot : resourceRoot, ...relativePath.split("/"));
    const content = `module:${descriptor.id}:v${descriptor.version}`;
    await writeFile(absolutePath, content, "utf8");
    const artifact = {
      scope,
      path: relativePath,
      sizeBytes: Buffer.byteLength(content),
      sha256: sha256(content),
    };
    const identity = {
      schemaVersion: "proto-workbench.module.v1",
      moduleId: descriptor.id,
      version: descriptor.version,
      core: descriptor.core,
      label: descriptor.label,
      resourceTier: descriptor.resourceTier,
      tools: [...descriptor.tools].sort(),
    };
    const identityContent = `${JSON.stringify(identity, null, 2)}\n`;
    const identityPath = `runtime/modules/${descriptor.id}.json`;
    await writeFile(join(resourceRoot, ...identityPath.split("/")), identityContent, "utf8");
    const identityArtifact = {
      scope: "resource",
      path: identityPath,
      sizeBytes: Buffer.byteLength(identityContent),
      sha256: sha256(identityContent),
    };
    const entry = {
      moduleId: descriptor.id,
      version: descriptor.version,
      core: descriptor.core,
      artifacts: descriptor.id === "core.governance"
        ? [identityArtifact, artifact, trustArtifact]
        : [identityArtifact, artifact],
    };
    modules.push({ ...entry, moduleSha256: moduleDigest(entry) });
    (descriptor.core ? corePaths : optionalPaths).set(descriptor.id, absolutePath);
  }

  const manifest = {
    schemaVersion: "proto-workbench.modules.v1",
    appVersion: "0.1.2",
    generatedAt: new Date().toISOString(),
    hashAlgorithm: "SHA-256",
    modules,
  };
  await writeFile(join(appRoot, "out", "module-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assert.equal((await readFile(join(appRoot, "out", "module-manifest.json"), "utf8")).length > 0, true);
  return { appRoot, resourceRoot, corePaths, optionalPaths, trustPath };
}

function moduleDigest(entry) {
  return sha256(JSON.stringify({
    moduleId: entry.moduleId,
    version: entry.version,
    core: entry.core,
    artifacts: [...entry.artifacts].sort((left, right) =>
      `${left.scope}:${left.path}`.localeCompare(`${right.scope}:${right.path}`)),
  }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
