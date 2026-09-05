import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectConfiguredRuntimeResources } from "../scripts/packaging-resources.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("Molstar and LM Studio SDK licenses are copied verbatim and configured as release resources", async () => {
  for (const [dependency, installed, copied] of [
    ["molstar", "molstar/LICENSE", "licenses/Molstar-MIT.txt"],
    ["@lmstudio/sdk", "@lmstudio/sdk/LICENSE", "licenses/LM-Studio-SDK-Apache-2.0.txt"],
  ]) {
    assert.ok(packageJson.dependencies[dependency]);
    const [original, distributed] = await Promise.all([
      readFile(new URL(`../node_modules/${installed}`, import.meta.url)),
      readFile(new URL(`../${copied}`, import.meta.url)),
    ]);
    assert.ok(original.equals(distributed), `${dependency} license bytes differ`);
    assert.ok(packageJson.build.extraResources.some(entry => entry.from === copied && entry.to === copied));
  }
});

test("package:win delegates the complete release transaction to one locked wrapper", async () => {
  assert.match(packageJson.scripts["build:sidecars"], /build-proto-sidecar\.ps1/);
  assert.match(packageJson.scripts["verify:sidecars"], /verify-sidecars\.ps1/);
  assert.match(packageJson.scripts["package:win"], /scripts\/package-win\.ps1/);
  assert.doesNotMatch(packageJson.scripts["package:win"], /electron-builder|build:sidecars/);

  const wrapper = await readFile(new URL("../scripts/package-win.ps1", import.meta.url), "utf8");
  const buildIndex = wrapper.indexOf('"build-proto-sidecar.ps1"');
  const verifyIndex = wrapper.indexOf('"verify-sidecars.ps1"');
  const desktopIndex = wrapper.indexOf('-Task Desktop -BuildLease');
  const packageIndex = wrapper.indexOf('-Label "Electron Builder"');
  assert.ok(buildIndex >= 0 && buildIndex < verifyIndex);
  assert.ok(verifyIndex < desktopIndex && desktopIndex < packageIndex);
  assert.match(wrapper, /Enter-ProjectBuildLease/);
  assert.match(wrapper, /Private build input capture/);
  assert.match(wrapper, /Original source verification before publication/);
  assert.match(wrapper, /if \(\$CandidateOnly\)/);
  assert.ok(wrapper.indexOf("if ($CandidateOnly)") < wrapper.indexOf("Move-Item -LiteralPath $ReleaseRoot -Destination $BackupRoot"));
  assert.match(wrapper, /-not \$RetainCandidate/);
  assert.match(wrapper, /release-staging-/);
  assert.match(wrapper, /Pre-package source snapshot/);
  assert.match(wrapper, /Post-package source snapshot/);
  assert.match(wrapper, /Staged packaged-payload verification/);
  assert.match(wrapper, /Published packaged-payload verification/);
  assert.match(wrapper, /Staged release-tree snapshot/);
  assert.match(wrapper, /Published release-tree snapshot/);
  assert.match(wrapper, /Assert-SameSnapshot/);
  assert.match(wrapper, /Assert-SameReleaseSnapshot/);
  assert.match(wrapper, /-setup\\\.exe\$/);
  assert.match(wrapper, /-portable\\\.exe\$/);
  assert.match(wrapper, /Restore-PreviousRelease/);

  const packagedVerifier = await readFile(new URL("../scripts/verify-packaged-integrity.mjs", import.meta.url), "utf8");
  assert.equal(packageJson.devDependencies["@electron/asar"], undefined);
  assert.match(packagedVerifier, /createRequire\(electronBuilderPackage\)/);
  assert.match(packagedVerifier, /createRequire\(appBuilderPackage\)\("@electron\/asar"\)/);
  assert.match(packagedVerifier, /collectTreeFiles\(resourcesRoot, "runtime", "runtime"\)/);

  const sidecarBuilder = await readFile(new URL("../scripts/build-proto-sidecar.ps1", import.meta.url), "utf8");
  assert.match(sidecarBuilder, /Enter-ProjectBuildLease/);
  assert.match(sidecarBuilder, /-ParentLease \$BuildLease/);

  const sidecarResources = packageJson.build.extraResources
    .filter((entry) => entry.to.startsWith("runtime/proto-agent"))
    .map((entry) => ({ from: entry.from, to: entry.to }))
    .sort((left, right) => left.to.localeCompare(right.to));
  assert.deepEqual(sidecarResources, [
    {
      from: "runtime/proto-agent/proto-agent",
      to: "runtime/proto-agent/proto-agent",
    },
    {
      from: "runtime/proto-agent/proto-agent-mcp",
      to: "runtime/proto-agent/proto-agent-mcp",
    },
    {
      from: "runtime/proto-agent/README.md",
      to: "runtime/proto-agent/README.md",
    },
  ]);
  assert.equal(
    packageJson.build.extraResources.some((entry) => entry.from === "runtime/proto-agent"),
    false,
  );
});

test("sidecar builder stages, validates, and publishes without the legacy scanner", async () => {
  const source = await readFile(new URL("../scripts/build-proto-sidecar.ps1", import.meta.url), "utf8");
  assert.match(source, /\.proto-agent-staging-/);
  assert.match(source, /\.proto-agent-backup-/);
  assert.match(source, /Enter-ProjectBuildLease/);
  assert.match(source, /Assert-SidecarRuntime -Root \$Staging/);
  assert.match(source, /Move-Item -LiteralPath \$Staging -Destination \$Destination/);
  assert.match(source, /Build-Sidecar -Name "proto-agent-mcp"/);
  assert.match(source, /Build-Sidecar -Name "proto-agent"/);
  assert.doesNotMatch(source, /proto-workbench-sidecar|proto_sidecar_entry|CollectGguf|collect-all/);
});

test("sidecar verifier binds the 7\/7 Skill catalogue, MCP tools, and byte hashes", async () => {
  const source = await readFile(new URL("../scripts/verify-sidecars.mjs", import.meta.url), "utf8");
  assert.match(source, /\["skills", "audit"\]/);
  assert.match(source, /status_counts\?\.available !== 7/);
  assert.match(source, /"proto_skills_list"/);
  assert.match(source, /"proto_skills_resolve"/);
  assert.match(source, /catalog_sha256 !== adminSkillAudit\.catalog_sha256/);
  assert.match(source, /connector_registry_sha256 !== adminSkillAudit\.connector_registry_sha256/);
  assert.match(source, /Packaged sidecar bytes changed during verification/);
});

test("module manifest derives every packaged runtime path and binds trust to a core module", async () => {
  const resources = await collectConfiguredRuntimeResources(fileURLToPath(new URL("..", import.meta.url)), packageJson);
  const trustPaths = resources
    .filter((resource) => resource.path.startsWith("runtime/trust/"))
    .map((resource) => resource.path);
  assert.deepEqual(trustPaths, [
    "runtime/trust/sigstore-public-good/SOURCE.json",
    "runtime/trust/sigstore-public-good/transparency/WITNESS_POLICY.json",
    "runtime/trust/sigstore-public-good/trusted_root.json",
    "runtime/trust/sigstore-public-good/tuf/15.root.json",
    "runtime/trust/sigstore-public-good/tuf/CHECKPOINT.json",
  ]);

  const source = await readFile(new URL("../scripts/generate-module-manifest.mjs", import.meta.url), "utf8");
  assert.match(source, /collectConfiguredRuntimeResources/);
  assert.match(source, /resourcesUnder\(runtimeResources, "runtime\/trust"\)/);
  assert.match(source, /core\.governance/);
  assert.match(source, /groups\.trust/);
});
