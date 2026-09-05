import { createRequire } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_NSIS_CWD_LENGTH = 240;
export const MAX_NSIS_FILE_PATH_LENGTH = 259;
const APP = "apps/proto-workbench";

function inside(root, path, label) {
  const suffix = relative(resolve(root), resolve(path));
  if (!suffix || suffix === ".." || suffix.startsWith("..\\") || suffix.startsWith("../") || isAbsolute(suffix)) {
    throw new Error(`${label} must remain inside its private build boundary: ${path}`);
  }
  return suffix;
}

export function assertNsisCwdLength(path) {
  if (path.length > MAX_NSIS_CWD_LENGTH) {
    throw new Error(`NSIS working directory is ${path.length} characters; maximum is ${MAX_NSIS_CWD_LENGTH}. Shorten the private staging path before building: ${path}`);
  }
}

async function nsisWorkingDirectory(repository) {
  const app = join(repository, APP);
  const appRequire = createRequire(join(app, "package.json"));
  const builderRequire = createRequire(appRequire.resolve("electron-builder/package.json"));
  // Use the same installed path resolver as NsisTarget, without downloading or
  // executing any external tool. Node resolves pnpm links to their real paths.
  const { getTemplatePath } = builderRequire("app-builder-lib/out/util/pathManager.js");
  const cwd = await realpath(getTemplatePath("nsis"));
  inside(join(app, "node_modules"), cwd, "Resolved NSIS templates");
  return cwd;
}

async function nsisRequiredFiles(repository, cwd) {
  const files = [];
  async function walk(directory, depth = 0) {
    if (depth > 16 || files.length > 4096) throw new Error("NSIS template inventory exceeds its bounded scope.");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`NSIS templates cannot contain a linked input: ${path}`);
      if (stat.isDirectory()) await walk(path, depth + 1);
      else if (stat.isFile()) {
        inside(cwd, await realpath(path), "NSIS template file");
        files.push({ kind: "template", relativePath: inside(repository, path, "NSIS template file") });
      } else throw new Error(`NSIS templates require regular files: ${path}`);
    }
  }
  await walk(cwd);
  const app = join(repository, APP), metadata = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  const config = metadata.build ?? {}, resourceRoot = resolve(app, config.directories?.buildResources ?? "build");
  inside(repository, resourceRoot, "NSIS build resources");
  // Include the configured local resources and standard fallback candidates.
  // Do not recursively enumerate app/build: it also contains retained releases.
  const resources = new Set(["icon.ico", "installerIcon.ico", "uninstallerIcon.ico", "installerHeaderIcon.ico",
    "installerHeader.bmp", "installerSidebar.bmp", "uninstallerSidebar.bmp", "installer.nsi", "installer.nsh",
    "license.txt", "license.rtf", "license.html"].map(name => join(resourceRoot, name)));
  for (const value of [config.icon, config.win?.icon]) if (typeof value === "string") resources.add(resolve(app, value));
  for (const key of ["license", "include", "script", "installerIcon", "uninstallerIcon", "installerHeaderIcon", "installerHeader", "installerSidebar", "uninstallerSidebar"]) {
    const value = config.nsis?.[key];
    if (typeof value === "string") { resources.add(resolve(app, value)); resources.add(resolve(resourceRoot, value)); }
  }
  const associations = config.fileAssociations ? (Array.isArray(config.fileAssociations) ? config.fileAssociations : [config.fileAssociations]) : [];
  for (const association of associations) if (typeof association.icon === "string") {
    resources.add(resolve(app, association.icon)); resources.add(resolve(resourceRoot, association.icon));
  }
  for (const path of resources) files.push({ kind: "resource-candidate", relativePath: inside(repository, path, "NSIS resource") });
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function bindRequiredFiles(privateRoot, files) {
  const paths = files.map(file => {
    const path = resolve(privateRoot, file.relativePath);
    inside(privateRoot, path, "Private NSIS input");
    if (path.length > MAX_NSIS_FILE_PATH_LENGTH) throw new Error(`NSIS input path is ${path.length} characters; maximum is ${MAX_NSIS_FILE_PATH_LENGTH}: ${path}`);
    return { ...file, path, length: path.length };
  });
  return { requiredPaths: paths, maximumFilePath: MAX_NSIS_FILE_PATH_LENGTH, maximumFilePathLength: Math.max(0, ...paths.map(item => item.length)) };
}

export async function projectPackagePaths(sourceRoot, privateRoot) {
  sourceRoot = await realpath(sourceRoot);
  privateRoot = resolve(privateRoot);
  inside(join(sourceRoot, "build"), privateRoot, "Private repository");
  const sourceNsisCwd = await nsisWorkingDirectory(sourceRoot);
  const nsisRelativePath = inside(sourceRoot, sourceNsisCwd, "Source NSIS templates");
  const nsisCwd = resolve(privateRoot, nsisRelativePath);
  assertNsisCwdLength(nsisCwd);
  const inputs = bindRequiredFiles(privateRoot, await nsisRequiredFiles(sourceRoot, sourceNsisCwd));
  return { schemaVersion: "proto-workbench.package-paths.v2", phase: "projected", sourceRoot, privateRoot,
    sourceNsisCwd, nsisRelativePath, nsisCwd, length: nsisCwd.length, maximum: MAX_NSIS_CWD_LENGTH, ...inputs };
}

export async function verifyPackagePaths(privateRoot, projected) {
  privateRoot = await realpath(privateRoot);
  if (projected.schemaVersion !== "proto-workbench.package-paths.v2" || projected.phase !== "projected" ||
      relative(privateRoot, resolve(projected.privateRoot)) !== "") throw new Error("Private working-directory projection does not bind this repository.");
  const nsisCwd = await nsisWorkingDirectory(privateRoot);
  const nsisRelativePath = inside(privateRoot, nsisCwd, "Private NSIS templates");
  assertNsisCwdLength(nsisCwd);
  if (relative(nsisCwd, resolve(projected.nsisCwd)) !== "" || nsisRelativePath !== projected.nsisRelativePath) {
    throw new Error("Actual NSIS working directory differs from its captured projection.");
  }
  const inputs = bindRequiredFiles(privateRoot, await nsisRequiredFiles(privateRoot, nsisCwd));
  if (JSON.stringify(inputs.requiredPaths) !== JSON.stringify(projected.requiredPaths)) throw new Error("Actual NSIS input inventory differs from its captured projection.");
  return { ...projected, phase: "actual", nsisCwd, length: nsisCwd.length, ...inputs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const option = name => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`); return process.argv[i + 1]; };
    let report;
    if (process.argv[2] === "project") report = await projectPackagePaths(option("--source"), option("--private"));
    else if (process.argv[2] === "verify") report = await verifyPackagePaths(option("--private"), JSON.parse((await readFile(option("--projected"), "utf8")).replace(/^\uFEFF/, "")));
    else throw new Error("Expected project or verify package-path command.");
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) { process.stderr.write(`${error}\n`); process.exitCode = 1; }
}
