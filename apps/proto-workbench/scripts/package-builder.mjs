import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const samePath = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
function contained(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error(`Builder path escapes its private boundary: ${path}`);
}
async function canonical(path) {
  const absolute = resolve(path);
  if (!samePath(absolute, await realpath(absolute))) throw new Error(`Builder path must not cross a reparse point: ${path}`);
  return absolute;
}

// app-builder-lib exposes these two public methods and build(options, packager).
// Its default lazy discovery runs `pnpm exec pwd`, which pnpm 11 can turn into
// an installation. The fixed workspace uses the same npm read-only collector
// as the verified release path, without invoking package-manager discovery.
export function createReadOnlyPackager(builder, options, verifiedAppRoot) {
  if (resolve(options.projectDir) !== resolve(verifiedAppRoot) || options.config?.npmRebuild !== false) throw new Error("Read-only packaging requires the bound app root and npmRebuild=false.");
  if (typeof builder.Packager?.prototype.getPackageManager !== "function" || typeof builder.Packager?.prototype.getWorkspaceRoot !== "function") throw new Error("Installed builder lacks the public workspace/collector API.");
  class ReadOnlyPackager extends builder.Packager {
    async getPackageManager() { return "npm"; }
    async getWorkspaceRoot() { return verifiedAppRoot; }
  }
  return new ReadOnlyPackager(options);
}

export async function loadPrivateBuilder({ sourceRoot, privateRoot, releaseRoot }) {
  sourceRoot = await canonical(sourceRoot);
  privateRoot = await canonical(privateRoot);
  const privateId = basename(privateRoot);
  if (!/^[a-f0-9]{32}$/.test(privateId) || !samePath(dirname(privateRoot), join(sourceRoot, "build"))) throw new Error("Builder requires a full-GUID private repository directly under the source build directory.");
  const appRoot = await canonical(join(privateRoot, "apps/proto-workbench"));
  const originalBuildRoot = await canonical(join(sourceRoot, "apps/proto-workbench/build"));
  releaseRoot = resolve(releaseRoot);
  if (!samePath(dirname(releaseRoot), originalBuildRoot) || !/^release-staging-[a-f0-9]{32}$/.test(basename(releaseRoot))) throw new Error("Builder output must be a full-GUID release staging directory.");
  try {
    await lstat(releaseRoot);
    throw new Error("Builder release staging must not already exist.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const appRequire = createRequire(join(appRoot, "package.json"));
  const electronBuilderPackage = await canonical(appRequire.resolve("electron-builder/package.json"));
  contained(join(appRoot, "node_modules"), electronBuilderPackage);
  const builderRequire = createRequire(electronBuilderPackage);
  const libraryPath = await canonical(builderRequire.resolve("app-builder-lib"));
  contained(join(appRoot, "node_modules"), libraryPath);
  const libraryPackage = builderRequire.resolve("app-builder-lib/package.json");
  const metadata = JSON.parse(await readFile(libraryPackage, "utf8"));
  const options = { projectDir: appRoot, win: ["nsis", "portable"], publish: "never", config: { npmRebuild: false, directories: { output: releaseRoot } } };
  const builder = builderRequire("app-builder-lib");
  const packager = createReadOnlyPackager(builder, options, appRoot);
  const policy = { schemaVersion: "proto-workbench.builder-policy.v1", appRoot, privateRoot, releaseRoot,
    collector: await packager.getPackageManager(), workspaceRoot: await packager.getWorkspaceRoot(),
    workspaceDiscovery: "disabled-by-public-packager-methods", npmRebuild: false, publish: "never",
    libraryPath, libraryVersion: metadata.version, librarySha256: createHash("sha256").update(await readFile(libraryPath)).digest("hex") };
  return { builder, packager, options, policy };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flag = name => { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`); return process.argv[index + 1]; };
    const prepared = await loadPrivateBuilder({sourceRoot:flag("--source"),privateRoot:flag("--private"),releaseRoot:flag("--release")});
    const receipt = resolve(flag("--receipt"));
    const evidenceRoot = await canonical(join(flag("--source"), "apps/proto-workbench/build", `i-${basename(prepared.policy.privateRoot)}`));
    if (!samePath(dirname(receipt), evidenceRoot) || basename(receipt) !== "builder-policy.json") throw new Error("Builder receipt must bind to its private input evidence directory.");
    await writeFile(receipt, `${JSON.stringify(prepared.policy,null,2)}\n`, {flag:"wx"});
    process.stdout.write(`Builder policy: ${JSON.stringify(prepared.policy)}\n`);
    await prepared.builder.build(prepared.options, prepared.packager);
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}
