import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyModuleIntegrity } from "../src/main/services/module-integrity.ts";
import {
  collectConfiguredExtraResources,
  collectConfiguredRuntimeResources,
  collectTreeFiles,
} from "./packaging-resources.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_PREFIX = "proto-workbench-asar-verify-";
const asar = loadElectronBuilderAsar();

if (isMainModule()) {
  try {
    const command = process.argv[2];
    const result = command === "snapshot"
      ? await snapshotPackagingInputs(projectRoot)
      : command === "release-snapshot"
        ? await snapshotReleaseTree(requiredFlag("--root"))
      : command === "verify"
        ? await verifyPackagedPayload({ projectRoot, unpackedRoot: requiredFlag("--unpacked") })
        : (() => { throw new Error("Expected snapshot, release-snapshot, or verify command."); })();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: errorCode(error), message: String(error) })}\n`);
    process.exitCode = 1;
  }
}

export async function snapshotReleaseTree(root) {
  const canonicalRoot = resolve(root);
  const records = [];
  await visit(canonicalRoot, "");
  records.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: "proto-workbench.release-tree.v1",
    fileCount: records.length,
    totalBytes: records.reduce((total, record) => total + record.sizeBytes, 0),
    treeSha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
    topLevelExecutables: records
      .filter((record) => !record.path.includes("/") && record.path.toLowerCase().endsWith(".exe"))
      .map((record) => record.path),
    executableArtifacts: records.filter((record) => !record.path.includes("/") && record.path.toLowerCase().endsWith(".exe")),
  };

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Release output cannot contain symbolic links: ${relativePath}`);
      if (entry.isDirectory()) {
        await visit(absolute, relativePath);
      } else if (entry.isFile()) {
        const before = await stableFileMetadata(absolute);
        const sha256 = await sha256File(absolute);
        const after = await stableFileMetadata(absolute);
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new Error(`Release output changed while it was hashed: ${relativePath}`);
        }
        records.push({ path: relativePath, sizeBytes: Number(after.size), sha256 });
      } else {
        throw new Error(`Release output contains an unsupported filesystem entry: ${relativePath}`);
      }
    }
  }
}

export async function snapshotPackagingInputs(root) {
  const canonicalRoot = resolve(root);
  const packageJsonBytes = await readFile(join(canonicalRoot, "package.json"));
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  const iconPath = packageJson?.build?.win?.icon;
  const builderInputs = typeof iconPath === "string"
    ? (await collectTreeFiles(canonicalRoot, iconPath, iconPath)).map((entry) => ({ ...entry, scope: "builder" }))
    : [];
  const inputs = [
    { path: "package.json", sourcePath: "package.json", scope: "app" },
    ...(await collectTreeFiles(canonicalRoot, "out", "out")).map((entry) => ({ ...entry, scope: "app" })),
    ...(await collectConfiguredExtraResources(canonicalRoot, packageJson)).map((entry) => ({ ...entry, scope: "resource" })),
    ...builderInputs,
  ];
  const uniqueInputs = uniqueArtifactSources(inputs);
  const records = [];
  let totalBytes = 0;
  for (const input of uniqueInputs) {
    const absolute = safeJoin(canonicalRoot, input.sourcePath);
    const before = await stableFileMetadata(absolute);
    const sha256 = await sha256File(absolute);
    const after = await stableFileMetadata(absolute);
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`Packaging input changed while it was hashed: ${input.scope}:${input.path}`);
    }
    totalBytes += Number(after.size);
    records.push({ scope: input.scope, path: input.path, sizeBytes: Number(after.size), sha256 });
  }
  return {
    schemaVersion: "proto-workbench.package-inputs.v1",
    fileCount: records.length,
    totalBytes,
    treeSha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  };
}

export async function verifyPackagedPayload(options) {
  const canonicalProjectRoot = resolve(options.projectRoot);
  const unpackedRoot = resolve(options.unpackedRoot);
  const resourcesRoot = join(unpackedRoot, "resources");
  const asarPath = join(resourcesRoot, "app.asar");
  await requireRegularFile(asarPath, "Packaged app.asar");

  const extractedRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    asar.extractAll(asarPath, extractedRoot);
    const sourceManifestPath = join(canonicalProjectRoot, "out", "module-manifest.json");
    const packagedManifestPath = join(extractedRoot, "out", "module-manifest.json");
    const [sourceManifestBytes, packagedManifestBytes, sourcePackageBytes, packagedPackageBytes] = await Promise.all([
      readFile(sourceManifestPath),
      readFile(packagedManifestPath),
      readFile(join(canonicalProjectRoot, "package.json")),
      readFile(join(extractedRoot, "package.json")),
    ]);
    if (!sourceManifestBytes.equals(packagedManifestBytes)) {
      throw new Error("Packaged module manifest does not match the locked source manifest.");
    }

    const sourcePackage = JSON.parse(sourcePackageBytes.toString("utf8"));
    const packagedPackage = JSON.parse(packagedPackageBytes.toString("utf8"));
    assertPackagedMetadata(sourcePackage, packagedPackage);

    const report = await verifyModuleIntegrity({
      appRoot: extractedRoot,
      resourceRoot: resourcesRoot,
      enforce: true,
      expectedAppVersion: packagedPackage.version,
    });
    const failedModules = report.modules.filter((module) => module.status !== "verified");
    if (!report.ok || failedModules.length) {
      const summary = failedModules.map((module) => `${module.moduleId}:${module.status}`).join(", ");
      throw new Error(`Packaged module integrity verification failed: ${summary || "unknown module failure"}`);
    }

    const manifest = JSON.parse(packagedManifestBytes.toString("utf8"));
    const artifactMap = uniqueManifestArtifacts(manifest.modules);
    const sourceAppPaths = (await collectTreeFiles(canonicalProjectRoot, "out", "out"))
      .map((artifact) => artifact.path)
      .filter((path) => path !== "out/module-manifest.json")
      .sort();
    const packagedAppPaths = (await collectTreeFiles(extractedRoot, "out", "out"))
      .map((artifact) => artifact.path)
      .filter((path) => path !== "out/module-manifest.json")
      .sort();
    const manifestAppPaths = [...artifactMap.values()]
      .filter((artifact) => artifact.scope === "app")
      .map((artifact) => artifact.path)
      .sort();
    if (JSON.stringify(sourceAppPaths) !== JSON.stringify(manifestAppPaths)
        || JSON.stringify(packagedAppPaths) !== JSON.stringify(manifestAppPaths)) {
      throw new Error("Source, packaged, and manifested application files do not have the same exact path set.");
    }

    const configuredRuntime = await collectConfiguredRuntimeResources(canonicalProjectRoot, sourcePackage);
    const configuredPaths = configuredRuntime.map((resource) => resource.path).sort();
    const packagedPaths = (await collectTreeFiles(resourcesRoot, "runtime", "runtime"))
      .map((resource) => resource.path)
      .sort();
    const manifestPaths = [...artifactMap.values()]
      .filter((artifact) => artifact.scope === "resource" && artifact.path.startsWith("runtime/"))
      .map((artifact) => artifact.path)
      .sort();
    if (JSON.stringify(configuredPaths) !== JSON.stringify(manifestPaths)
        || JSON.stringify(packagedPaths) !== JSON.stringify(manifestPaths)) {
      throw new Error("Configured, packaged, and manifested runtime resources do not have the same exact path set.");
    }

    return {
      schemaVersion: "proto-workbench.packaged-integrity.v1",
      unpackedRoot,
      asarSha256: await sha256File(asarPath),
      manifestSha256: createHash("sha256").update(packagedManifestBytes).digest("hex"),
      verifiedModules: report.modules.length,
      verifiedArtifacts: artifactMap.size,
      verifiedAppFiles: manifestAppPaths.length,
      verifiedRuntimeResources: configuredPaths.length,
    };
  } finally {
    await removeManagedTemporaryDirectory(extractedRoot);
  }
}

export function createAsarPackage(source, destination) {
  return asar.createPackage(source, destination);
}

function assertPackagedMetadata(sourcePackage, packagedPackage) {
  for (const field of ["name", "productName", "version", "main", "type"]) {
    if (packagedPackage[field] !== sourcePackage[field]) {
      throw new Error(`Packaged application metadata does not match source field: ${field}`);
    }
  }
  if (JSON.stringify(packagedPackage.dependencies ?? {}) !== JSON.stringify(sourcePackage.dependencies ?? {})) {
    throw new Error("Packaged application dependencies do not match the source package.");
  }
}

function uniqueManifestArtifacts(modules) {
  if (!Array.isArray(modules)) throw new Error("Packaged module manifest has no modules array.");
  const artifacts = new Map();
  for (const module of modules) {
    if (!Array.isArray(module?.artifacts)) continue;
    for (const artifact of module.artifacts) {
      if (!artifact || typeof artifact !== "object") continue;
      const key = `${artifact.scope}:${artifact.path}`;
      const previous = artifacts.get(key);
      if (previous && (previous.sha256 !== artifact.sha256 || previous.sizeBytes !== artifact.sizeBytes)) {
        throw new Error(`Manifest contains conflicting artifact identities: ${key}`);
      }
      artifacts.set(key, artifact);
    }
  }
  return artifacts;
}

function uniqueArtifactSources(inputs) {
  const paths = new Map();
  for (const input of inputs) {
    const key = `${input.scope}:${input.path}`;
    if (paths.has(key)) throw new Error(`Two package inputs target the same payload path: ${key}`);
    paths.set(key, input);
  }
  return [...paths.values()].sort((left, right) =>
    `${left.scope}:${left.path}`.localeCompare(`${right.scope}:${right.path}`));
}

async function stableFileMetadata(path) {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Packaging input is not a regular file: ${path}`);
  return { size: metadata.size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs };
}

async function requireRegularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file.`);
  }
}

function safeJoin(root, relativePath) {
  const absolute = resolve(root, ...relativePath.split("/"));
  const fromRoot = relative(resolve(root), absolute);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`Packaging input escapes its root: ${relativePath}`);
  return absolute;
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function removeManagedTemporaryDirectory(path) {
  const canonical = resolve(path);
  const tempRoot = resolve(tmpdir());
  const fromTemp = relative(tempRoot, canonical);
  if (fromTemp.startsWith("..") || isAbsolute(fromTemp) || !fromTemp.startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unmanaged verification directory: ${path}`);
  }
  await rm(canonical, { recursive: true, force: true });
}

function requiredFlag(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing required ${name} argument.`);
  return value;
}

function errorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/manifest/i.test(message)) return "PACKAGE_MANIFEST_INVALID";
  if (/runtime resource/i.test(message)) return "PACKAGE_RUNTIME_SET_MISMATCH";
  if (/changed/i.test(message)) return "PACKAGE_INPUT_CHANGED";
  return "PACKAGE_INTEGRITY_FAILED";
}

function loadElectronBuilderAsar() {
  const require = createRequire(import.meta.url);
  const electronBuilderPackage = require.resolve("electron-builder/package.json");
  const electronBuilderRequire = createRequire(electronBuilderPackage);
  const appBuilderPackage = electronBuilderRequire.resolve("app-builder-lib/package.json");
  return createRequire(appBuilderPackage)("@electron/asar");
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
