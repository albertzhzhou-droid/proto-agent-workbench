import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSameBuildInputs, captureBuildInputs } from "./build-input-snapshot.mjs";

const MODULES = "apps/proto-workbench/node_modules";
const METADATA = `${MODULES}/.modules.yaml`;
const hash = value => createHash("sha256").update(value).digest("hex");

export async function relocatePrivatePnpm({ sourceRoot, privateRoot, snapshot }) {
  sourceRoot = resolve(sourceRoot);
  privateRoot = resolve(privateRoot);
  if (sourceRoot === privateRoot) throw new Error("Dependency relocation requires an independent private root.");
  const record = snapshot.records.find(item => item.path === METADATA && item.kind === "file");
  if (!record) throw new Error("The release input manifest must include installed pnpm metadata.");
  const sourceBytes = await readFile(join(sourceRoot, METADATA));
  const privateBytes = await readFile(join(privateRoot, METADATA));
  if (hash(sourceBytes) !== record.sha256 || !privateBytes.equals(sourceBytes)) throw new Error("Source/private pnpm metadata differs from the captured bytes.");
  // pnpm 11 writes JSON-compatible YAML here. Unknown formats fail closed;
  // there is no speculative regex editing of package-manager metadata.
  let metadata;
  try { metadata = JSON.parse(sourceBytes.toString("utf8")); } catch { throw new Error("Expected pnpm 11 JSON-compatible .modules.yaml metadata."); }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || typeof metadata.virtualStoreDir !== "string") throw new Error("pnpm virtual store metadata is missing.");
  const sourceModules = join(sourceRoot, MODULES);
  const sourceStore = resolve(sourceModules, metadata.virtualStoreDir);
  if (sourceStore !== join(sourceModules, ".pnpm")) throw new Error("pnpm virtual store must point exactly at the captured source .pnpm directory.");
  const targetStore = join(privateRoot, MODULES, ".pnpm");
  const privateRelative = relative(privateRoot, targetStore);
  if (!privateRelative || privateRelative.startsWith("..") || isAbsolute(privateRelative)) throw new Error("Private virtual store escapes its copied root.");
  const normalized = Buffer.from(`${JSON.stringify({ ...metadata, virtualStoreDir: targetStore }, null, 2)}\n`);
  await writeFile(join(privateRoot, METADATA), normalized);
  const records = snapshot.records.map(item => item.path === METADATA ? { ...item, sizeBytes: normalized.length, sha256: hash(normalized) } : item);
  const derived = { ...snapshot, records, totalBytes: records.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0), treeSha256: hash(JSON.stringify(records)) };
  assertSameBuildInputs(derived, await captureBuildInputs(privateRoot, snapshot.roots), "private pnpm relocation");
  if (!sourceBytes.equals(await readFile(join(sourceRoot, METADATA)))) throw new Error("Original pnpm metadata changed during private relocation.");
  return { snapshot: derived, receipt: { schemaVersion: "proto-workbench.private-dependency-relocation.v1",
    algorithm: "pnpm.virtualStoreDir.v1", path: METADATA, sourceSha256: record.sha256, privateSha256: hash(normalized),
    sourceTreeSha256: snapshot.treeSha256, privateTreeSha256: derived.treeSha256,
    sourceVirtualStore: sourceStore, privateVirtualStore: targetStore,
    sourceUnchanged: true, installOrRebuild: false,
    note: "Only private pnpm virtualStoreDir metadata is relocated. Original Node dependency bytes and package-manager store are untouched." } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flag = name => { const at = process.argv.indexOf(name); if (at < 0 || !process.argv[at + 1]) throw new Error(`Missing ${name}`); return process.argv[at + 1]; };
    const result = await relocatePrivatePnpm({ sourceRoot: flag("--source"), privateRoot: flag("--private"), snapshot: JSON.parse(await readFile(flag("--input-manifest"), "utf8")) });
    await writeFile(flag("--private-manifest"), `${JSON.stringify(result.snapshot, null, 2)}\n`, { flag: "wx" });
    await writeFile(flag("--receipt"), `${JSON.stringify(result.receipt, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result.receipt })}\n`);
  } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
