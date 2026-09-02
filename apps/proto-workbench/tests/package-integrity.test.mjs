import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAsarPackage,
  snapshotPackagingInputs,
  snapshotReleaseTree,
  verifyPackagedPayload,
} from "../scripts/verify-packaged-integrity.mjs";
import { CORE_MODULES, OPTIONAL_MODULES } from "../src/shared/modules.ts";

test("package input snapshots detect a trust-tree mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proto-package-snapshot-"));
  await mkdir(join(root, "out"), { recursive: true });
  await mkdir(join(root, "runtime", "trust"), { recursive: true });
  await writeFile(join(root, "out", "index.js"), "export {};\n", "utf8");
  await writeFile(join(root, "runtime", "trust", "root.json"), '{"version":1}\n', "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({
    version: "0.1.2",
    build: {
      extraResources: [{ from: "runtime/trust", to: "runtime/trust", filter: ["**/*.json"] }],
    },
  }), "utf8");

  const before = await snapshotPackagingInputs(root);
  await writeFile(join(root, "runtime", "trust", "root.json"), '{"version":2}\n', "utf8");
  const after = await snapshotPackagingInputs(root);
  assert.equal(before.fileCount, after.fileCount);
  assert.notEqual(before.treeSha256, after.treeSha256);
});

test("release-tree snapshots bind top-level installers and every packaged byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "proto-release-tree-"));
  await mkdir(join(root, "win-unpacked", "resources"), { recursive: true });
  await writeFile(join(root, "Proto Workbench-0.1.2-x64-setup.exe"), "setup", "utf8");
  await writeFile(join(root, "Proto Workbench-0.1.2-x64-portable.exe"), "portable", "utf8");
  const payload = join(root, "win-unpacked", "resources", "app.asar");
  await writeFile(payload, "asar-a", "utf8");

  const before = await snapshotReleaseTree(root);
  assert.deepEqual(before.topLevelExecutables, [
    "Proto Workbench-0.1.2-x64-portable.exe",
    "Proto Workbench-0.1.2-x64-setup.exe",
  ]);
  await writeFile(payload, "asar-b", "utf8");
  const after = await snapshotReleaseTree(root);
  assert.equal(before.fileCount, after.fileCount);
  assert.notEqual(before.treeSha256, after.treeSha256);
});

test("post-package verification reads app.asar and rejects final trust-resource tampering", async () => {
  const fixture = await packagedFixture();
  const verified = await verifyPackagedPayload({
    projectRoot: fixture.projectRoot,
    unpackedRoot: fixture.unpackedRoot,
  });
  assert.equal(verified.verifiedModules, CORE_MODULES.length + OPTIONAL_MODULES.length);
  assert.equal(verified.verifiedRuntimeResources, CORE_MODULES.length + OPTIONAL_MODULES.length + 1);
  assert.match(verified.asarSha256, /^[a-f0-9]{64}$/);

  await writeFile(fixture.packagedTrustPath, '{"trusted":false}\n', "utf8");
  await assert.rejects(
    () => verifyPackagedPayload({ projectRoot: fixture.projectRoot, unpackedRoot: fixture.unpackedRoot }),
    /Packaged module integrity verification failed: core\.governance:tampered/,
  );

  await writeFile(fixture.packagedTrustPath, '{"trusted":true}\n', "utf8");
  await writeFile(join(fixture.unpackedRoot, "resources", "runtime", "unmanifested.json"), "{}\n", "utf8");
  await assert.rejects(
    () => verifyPackagedPayload({ projectRoot: fixture.projectRoot, unpackedRoot: fixture.unpackedRoot }),
    /do not have the same exact path set/,
  );
});

async function packagedFixture() {
  const root = await mkdtemp(join(tmpdir(), "proto-packaged-integrity-"));
  const projectRoot = join(root, "project");
  const appSource = join(root, "app-source");
  const unpackedRoot = join(root, "win-unpacked");
  const resourcesRoot = join(unpackedRoot, "resources");
  await Promise.all([
    mkdir(join(projectRoot, "out"), { recursive: true }),
    mkdir(join(projectRoot, "runtime", "modules"), { recursive: true }),
    mkdir(join(projectRoot, "runtime", "trust"), { recursive: true }),
    mkdir(join(appSource, "out"), { recursive: true }),
    mkdir(join(resourcesRoot, "runtime", "modules"), { recursive: true }),
    mkdir(join(resourcesRoot, "runtime", "trust"), { recursive: true }),
  ]);

  const packageJson = `${JSON.stringify({
    name: "proto-workbench-fixture",
    version: "0.1.2",
    build: {
      extraResources: [
        { from: "runtime/modules", to: "runtime/modules", filter: ["**/*.json"] },
        { from: "runtime/trust", to: "runtime/trust", filter: ["**/*.json"] },
      ],
    },
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(join(projectRoot, "package.json"), packageJson, "utf8"),
    writeFile(join(appSource, "package.json"), packageJson, "utf8"),
  ]);

  const trustContent = '{"trusted":true}\n';
  const trustArtifact = artifact("resource", "runtime/trust/root.json", trustContent);
  const packagedTrustPath = join(resourcesRoot, "runtime", "trust", "root.json");
  await Promise.all([
    writeFile(join(projectRoot, "runtime", "trust", "root.json"), trustContent, "utf8"),
    writeFile(packagedTrustPath, trustContent, "utf8"),
  ]);

  const modules = [];
  for (const descriptor of [...CORE_MODULES, ...OPTIONAL_MODULES]) {
    const descriptorContent = `${JSON.stringify({
      schemaVersion: "proto-workbench.module.v1",
      moduleId: descriptor.id,
      version: descriptor.version,
      core: descriptor.core,
      label: descriptor.label,
      resourceTier: descriptor.resourceTier,
      tools: [...descriptor.tools].sort(),
    }, null, 2)}\n`;
    const descriptorRelative = `runtime/modules/${descriptor.id}.json`;
    await Promise.all([
      writeFile(join(projectRoot, ...descriptorRelative.split("/")), descriptorContent, "utf8"),
      writeFile(join(resourcesRoot, ...descriptorRelative.split("/")), descriptorContent, "utf8"),
    ]);
    const artifacts = [artifact("resource", descriptorRelative, descriptorContent)];
    if (descriptor.id === "core.governance") artifacts.push(trustArtifact);
    const entry = { moduleId: descriptor.id, version: descriptor.version, core: descriptor.core, artifacts };
    modules.push({ ...entry, moduleSha256: moduleDigest(entry) });
  }

  const manifest = `${JSON.stringify({
    schemaVersion: "proto-workbench.modules.v1",
    appVersion: "0.1.2",
    generatedAt: "2026-09-01T00:00:00.000Z",
    hashAlgorithm: "SHA-256",
    modules,
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(join(projectRoot, "out", "module-manifest.json"), manifest, "utf8"),
    writeFile(join(appSource, "out", "module-manifest.json"), manifest, "utf8"),
  ]);
  await createAsarPackage(appSource, join(resourcesRoot, "app.asar"));
  return { projectRoot, unpackedRoot, packagedTrustPath };
}

function artifact(scope, path, content) {
  return {
    scope,
    path,
    sizeBytes: Buffer.byteLength(content),
    sha256: sha256(content),
  };
}

function moduleDigest(entry) {
  return sha256(JSON.stringify({
    moduleId: entry.moduleId,
    version: entry.version,
    core: entry.core,
    artifacts: [...entry.artifacts]
      .sort((left, right) => `${left.scope}:${left.path}`.localeCompare(`${right.scope}:${right.path}`))
      .map((artifactEntry) => ({
        scope: artifactEntry.scope,
        path: artifactEntry.path,
        sizeBytes: artifactEntry.sizeBytes,
        sha256: artifactEntry.sha256,
      })),
  }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
