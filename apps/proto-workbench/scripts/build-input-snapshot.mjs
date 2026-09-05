import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = "apps/proto-workbench";
export const BUILD_INPUT_ROOTS = Object.freeze([
  "src", "parts", "schemas", "connectors", "workflows", "literature/seed_sources.json", ".codex/skills", "pyproject.toml", "uv.lock", "LICENSE", "README.md",
  ...["src", "scripts", "licenses", "node_modules", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc",
    "electron.vite.config.ts", "vite.config.mjs", "tsconfig.json", "index.html", "THIRD_PARTY_NOTICES.md",
    "runtime/workspace-template", "runtime/trust", "runtime/proto-agent/README.md"].map(path => `${APP}/${path}`),
]);
export const DESKTOP_QA_INPUT_ROOTS = Object.freeze([...BUILD_INPUT_ROOTS.filter(path => path !== `${APP}/node_modules`),
  `${APP}/runtime/proto-agent/proto-agent`, `${APP}/runtime/proto-agent/proto-agent-mcp`,
]);

const slash = value => value.replaceAll("\\", "/");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const IO_CONCURRENCY = 8;
async function mapBounded(items, callback) {
  let next = 0;
  const results = new Array(items.length);
  // Settle every owned task before returning a failure; no late copies continue
  // after the caller reports a failed capture or releases its build lease.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(IO_CONCURRENCY, items.length) }, async () => {
    for (let index; (index = next++) < items.length;) results[index] = await callback(items[index]);
  }));
  const failed = workers.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}
function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`Build input path escapes its root: ${path}`);
  }
  return slash(rel);
}
function ignored(path) {
  const generatedTemplate = `${APP}/runtime/workspace-template/`;
  if (path.startsWith(generatedTemplate)) {
    const managed = path.slice(generatedTemplate.length);
    if (managed === ".codex/skills" || managed.startsWith(".codex/skills/") ||
        managed === "connectors/proto_workbench.json" || managed === "workflows/design_review.json") return true;
  }
  return path.split("/").some(part => ["__pycache__", ".cache", ".vite", ".vite-temp", ".npm-cache"].includes(part) || part.startsWith(".ignored_"));
}
async function fileHash(path, sizeBytes) {
  if (sizeBytes <= 8 * 1024 * 1024) return hash(await readFile(path));
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}
async function stableRecord(path, relativePath) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Build input must be a regular file: ${relativePath}`);
  const sha256 = await fileHash(path, Number(before.size));
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error(`Build input changed while hashing: ${relativePath}`);
  }
  return { path: relativePath, kind: "file", sizeBytes: Number(after.size), sha256 };
}

export async function captureBuildInputs(root, roots = BUILD_INPUT_ROOTS) {
  const canonicalRoot = resolve(root);
  const records = [];
  const files = [];
  for (const input of [...roots].sort()) {
    const absolute = resolve(canonicalRoot, input);
    within(canonicalRoot, absolute);
    // All ancestors of allowlisted roots must be real directories.
    let parent = dirname(absolute);
    while (parent !== canonicalRoot) {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Build input root crosses a link: ${input}`);
      parent = dirname(parent);
    }
    await visit(absolute, slash(input));
  }
  records.push(...await mapBounded(files, ({ absolute, path }) => stableRecord(absolute, path)));
  records.sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(records.map(record => record.path)).size !== records.length) throw new Error("Build input roots overlap.");
  return { schemaVersion: "proto-workbench.build-inputs.v1", roots: [...roots], fileCount: records.length,
    totalBytes: records.reduce((sum, record) => sum + (record.sizeBytes ?? 0), 0), treeSha256: hash(JSON.stringify(records)), records };

  async function visit(absolute, path) {
    if (ignored(path)) return;
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      // pnpm junctions are allowed only inside the copied dependency tree. They
      // are recreated against the private copy, never linked to source bytes.
      if (!path.startsWith(`${APP}/node_modules/`)) throw new Error(`Source inputs cannot contain links: ${path}`);
      const target = await realpath(absolute);
      const targetPath = within(join(canonicalRoot, APP, "node_modules"), target);
      const canonicalTarget = `${APP}/node_modules/${targetPath}`;
      if (ignored(canonicalTarget)) throw new Error(`Dependency link targets an excluded path: ${path}`);
      const targetStat = await lstat(target);
      records.push({ path, kind: targetStat.isDirectory() ? "directory-link" : "file-link", target: canonicalTarget });
    } else if (metadata.isDirectory()) {
      records.push({ path, kind: "directory" });
      for (const child of (await readdir(absolute)).sort()) await visit(join(absolute, child), `${path}/${child}`);
    } else if (metadata.isFile()) files.push({ absolute, path });
    else throw new Error(`Unsupported build input entry: ${path}`);
  }
}

export function assertSameBuildInputs(expected, actual, boundary) {
  if (expected.schemaVersion !== "proto-workbench.build-inputs.v1" || actual.treeSha256 !== expected.treeSha256 ||
      actual.fileCount !== expected.fileCount || actual.totalBytes !== expected.totalBytes) {
    throw new Error(`Build inputs changed across ${boundary}; publication is blocked.`);
  }
}

export async function createBuildInputSnapshot({ sourceRoot, destinationRoot, roots = BUILD_INPUT_ROOTS }) {
  sourceRoot = resolve(sourceRoot);
  destinationRoot = resolve(destinationRoot);
  const existing = await lstat(destinationRoot).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) throw new Error("Build input destination must not exist.");
  // Caller owns the transaction namespace; reject copied inputs containing it.
  for (const input of roots) {
    const inputRoot = resolve(sourceRoot, input);
    if (destinationRoot === inputRoot || destinationRoot.startsWith(`${inputRoot}/`) || destinationRoot.startsWith(`${inputRoot}\\`)) {
      throw new Error("Build input destination cannot be inside a copied input.");
    }
  }
  const snapshot = await captureBuildInputs(sourceRoot, roots);
  await mkdir(destinationRoot, { recursive: true });
  const directories = [...new Set(snapshot.records.map(record => record.kind === "directory"
    ? join(destinationRoot, record.path) : dirname(join(destinationRoot, record.path))))];
  await mapBounded(directories, path => mkdir(path, { recursive: true }));
  await mapBounded(snapshot.records.filter(record => record.kind === "file"), record =>
    copyFile(join(sourceRoot, record.path), join(destinationRoot, record.path))); // No hardlinks.
  for (const record of snapshot.records.filter(item => item.kind.endsWith("-link"))) {
    const destination = join(destinationRoot, record.path);
    const target = join(destinationRoot, record.target);
    await symlink(process.platform === "win32" && record.kind === "directory-link" ? target : relative(dirname(destination), target),
      destination, record.kind === "directory-link" ? (process.platform === "win32" ? "junction" : "dir") : "file");
  }
  // The complete destination read verifies both copied bytes and the exact path
  // set once. A second per-copy hash would repeat that same full read.
  const verified = await Promise.allSettled([
    captureBuildInputs(sourceRoot, roots), captureBuildInputs(destinationRoot, roots),
  ]);
  for (const result of verified) if (result.status === "rejected") throw result.reason;
  assertSameBuildInputs(snapshot, verified[0].value, "source capture");
  assertSameBuildInputs(snapshot, verified[1].value, "private input capture");
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    const option = name => { const at = process.argv.indexOf(name); if (at < 0 || !process.argv[at + 1]) throw new Error(`Missing ${name}`); return process.argv[at + 1]; };
    const manifestPath = option("--manifest");
    if (command === "create") {
      const profile = process.argv.includes("--profile") ? option("--profile") : "release";
      if (!["release", "desktop-qa"].includes(profile)) throw new Error("Unknown build input profile.");
      const snapshot = await createBuildInputSnapshot({ sourceRoot: option("--source"), destinationRoot: option("--destination"), roots: profile === "desktop-qa" ? DESKTOP_QA_INPUT_ROOTS : BUILD_INPUT_ROOTS });
      if (profile === "desktop-qa") {
        // Initial development QA only. Release always copies dependencies.
        await symlink(resolve(option("--source"), APP, "node_modules"), resolve(option("--destination"), APP, "node_modules"), process.platform === "win32" ? "junction" : "dir");
        snapshot.dependencyIsolation = "Shared frozen dependency tree for development QA; not release isolation.";
      }
      await writeFile(manifestPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
      process.stdout.write(`${JSON.stringify({ ok: true, fileCount: snapshot.fileCount, treeSha256: snapshot.treeSha256 })}\n`);
    } else if (command === "verify") {
      const expected = JSON.parse(await readFile(manifestPath, "utf8"));
      assertSameBuildInputs(expected, await captureBuildInputs(option("--root"), expected.roots), "build completion");
      process.stdout.write(`${JSON.stringify({ ok: true, treeSha256: expected.treeSha256 })}\n`);
    } else throw new Error("Expected create or verify.");
  } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
