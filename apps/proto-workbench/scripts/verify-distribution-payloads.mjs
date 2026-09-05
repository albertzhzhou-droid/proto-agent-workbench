import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotReleaseTree } from "./verify-packaged-integrity.mjs";

export async function assertNsisArchiveTool(path) {
  const tool = await regular(path);
  const dependencies = basename(path).toLowerCase() === "7z.exe" ? [await regular(join(dirname(path), "7z.dll"))] : [];
  const capabilities = await sevenZip(path, ["i"]);
  if (!/^.*\sNsis\s+nsis\b/im.test(capabilities)) throw new Error("An NSIS-capable full 7z.exe or 7zz.exe is required; Electron Builder's limited 7za executable cannot verify installer containers.");
  return { ...tool, dependencies, version: capabilities.match(/^7-Zip[^\r\n]+/m)?.[0] ?? "unavailable" };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error(`Expected non-empty regular file: ${path}`);
  return { path, sizeBytes: stat.size, sha256: await sha256(path) };
}
async function sevenZip(executable, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "", failure;
    const timer = setTimeout(() => { failure = new Error("Archive verification exceeded 120 seconds."); child.kill(); }, 120_000);
    child.stdout.on("data", bytes => { output += bytes; if (output.length > 32 * 1024 * 1024) { failure = new Error("Archive listing exceeds 32 MiB."); child.kill(); } });
    child.stderr.on("data", bytes => { error += bytes; if (error.length > 65536) { failure = new Error("Archive diagnostics exceed limit."); child.kill(); } });
    child.on("error", cause => { clearTimeout(timer); reject(cause); });
    child.on("close", code => { clearTimeout(timer); if (failure || code !== 0) reject(failure ?? new Error(`7zip failed (${code}): ${error.slice(0, 4096)}`)); else resolveResult(output); });
  });
}

export function validateArchiveListing(listing) {
  const separator = listing.indexOf("----------");
  if (separator < 0) throw new Error("Archive has no technical file listing.");
  const blocks = listing.slice(separator + 10).trim().split(/\r?\n\r?\n/).filter(Boolean);
  if (!blocks.length || blocks.length > 65_536) throw new Error("Archive entry count is outside verification bounds.");
  let total = 0;
  const seen = new Set();
  for (const block of blocks) {
    const pairs = Object.fromEntries(block.split(/\r?\n/).map(line => { const at = line.indexOf(" = "); return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 3)]; }));
    const path = (pairs.Path ?? "").replaceAll("\\", "/");
    if (!path || path.startsWith("/") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)) || /[\x00-\x1f]/.test(path)) throw new Error("Unsafe archive path.");
    if (Object.keys(pairs).some(key => /link/i.test(key)) || /^l/.test(pairs.Attributes ?? "")) throw new Error("Archive links are not permitted.");
    const folded = path.toLowerCase();
    if (seen.has(folded)) throw new Error("Archive paths collide on Windows.");
    seen.add(folded);
    const size = pairs.Size === undefined || pairs.Size === "" ? 0 : Number(pairs.Size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid archive entry size.");
    total += size;
  }
  if (total > 4 * 1024 ** 3) throw new Error("Archive expansion exceeds 4 GiB.");
  return { entries: blocks.length, totalBytes: total };
}

async function extractArchive(executable, archive, destination) {
  const listing = validateArchiveListing(await sevenZip(executable, ["l", "-slt", "-sccUTF-8", archive]));
  await mkdir(destination); // Every extraction is fresh; never overwrite a release.
  await sevenZip(executable, ["x", "-y", "-bd", "-bso0", "-bsp0", `-o${destination}`, archive]);
  return listing;
}
async function findPayload(root) {
  const asars = [], archives = [];
  async function visit(path, depth) {
    if (depth > 5) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Extracted archive contains a link.");
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.name === "app.asar" && basename(path) === "resources") asars.push(dirname(path));
      else if (/^app-(?:64|32|arm64)\.(?:7z|zip)$/i.test(entry.name)) archives.push(full);
    }
  }
  await visit(root, 0);
  if (asars.length === 1 && archives.length === 0) return { root: asars[0] };
  if (asars.length === 0 && archives.length === 1) return { archive: archives[0] };
  throw new Error(`Expected exactly one application payload (app roots=${asars.length}, embedded archives=${archives.length}).`);
}

export async function verifyDistributionPayloads({ releaseRoot, unpackedRoot, evidenceRoot, archiveExecutable }) {
  for (const path of [releaseRoot, unpackedRoot, evidenceRoot, archiveExecutable]) if (!isAbsolute(path)) throw new Error("Absolute verification paths are required.");
  const evidenceRelative = relative(resolve(releaseRoot), resolve(evidenceRoot));
  if (!evidenceRelative || (!evidenceRelative.startsWith("..") && !isAbsolute(evidenceRelative))) throw new Error("Verification evidence must stay outside the release tree.");
  const tool = await assertNsisArchiveTool(archiveExecutable);
  const expected = await snapshotReleaseTree(unpackedRoot);
  const distributions = (await readdir(releaseRoot)).filter(path => /\.exe$/i.test(path));
  if (distributions.length !== 2 || distributions.filter(path => /-setup\.exe$/i.test(path)).length !== 1 || distributions.filter(path => /-portable\.exe$/i.test(path)).length !== 1) throw new Error("Expected exactly one setup and one Portable executable.");
  await mkdir(evidenceRoot); // Do not reuse evidence from another candidate.
  const results = [];
  for (const name of distributions.sort()) {
    const artifact = await regular(join(releaseRoot, name));
    const kind = /-setup\.exe$/i.test(name) ? "installer" : "portable";
    const outer = join(evidenceRoot, kind);
    const container = await extractArchive(archiveExecutable, artifact.path, outer);
    let payload = await findPayload(outer);
    if (payload.archive) {
      const destination = join(evidenceRoot, `${kind}-payload`);
      await extractArchive(archiveExecutable, payload.archive, destination);
      payload = await findPayload(destination);
    }
    if (!payload.root) throw new Error("Nested payload archives are not supported.");
    const actual = await snapshotReleaseTree(payload.root);
    if (expected.treeSha256 !== actual.treeSha256 || expected.fileCount !== actual.fileCount || expected.totalBytes !== actual.totalBytes) throw new Error(`${kind} payload differs from the verified unpacked application.`);
    if (artifact.sha256 !== await sha256(artifact.path)) throw new Error(`${kind} changed during archive verification.`);
    results.push({ kind, artifact, container, payloadRoot: payload.root, payload: actual,
      payloadStatus: "verified-exact-unpacked-bytes", launchStatus: "not-run", installerExecution: kind === "installer" ? "not-run; embedded payload extraction does not test installer OS integration" : "not-applicable" });
  }
  if (tool.sha256 !== await sha256(archiveExecutable)) throw new Error("Archive verifier changed while running.");
  for (const dependency of tool.dependencies) if (dependency.sha256 !== await sha256(dependency.path)) throw new Error("Archive decoder library changed while running.");
  const report = { schemaVersion: "proto-workbench.distribution-payloads.v1", archiveTool: tool, unpackedPayload: expected, distributions: results };
  await writeFile(join(evidenceRoot, "distribution-payloads.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flag = name => { const at = process.argv.indexOf(name); if (at < 0 || !process.argv[at + 1]) throw new Error(`Missing ${name}`); return process.argv[at + 1]; };
    const archiveExecutable = flag("--7zip");
    const tool = await assertNsisArchiveTool(archiveExecutable);
    process.stdout.write(`${JSON.stringify({ ok: true, ...(process.argv.includes("--probe") ? { tool } : await verifyDistributionPayloads({ releaseRoot: flag("--release"), unpackedRoot: flag("--unpacked"), evidenceRoot: flag("--evidence"), archiveExecutable })) })}\n`);
  } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
