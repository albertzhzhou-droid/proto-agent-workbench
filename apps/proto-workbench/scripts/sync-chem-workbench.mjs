import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectTypography, syncChemTypography } from "./typography-profile.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(app, "../..");
const snapshot = join(app, "runtime/chem-workbench");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const walk = base => readdirSync(base, {withFileTypes:true}).flatMap(entry => {
  if (entry.name === "__pycache__" || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) return [];
  if (entry.isSymbolicLink()) throw new Error(`Linked snapshot resource rejected: ${entry.name}`);
  const path = join(base, entry.name);
  return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
});

// Source refresh is explicit. Normal builds package the reviewed snapshot and never
// silently import later scientific algorithm changes from a sibling checkout.
if (process.argv.includes("--source")) {
  const source = resolve(process.argv[process.argv.indexOf("--source") + 1]);
  const files = ["src", "scripts", "schemas", "examples", "third_party", "evaluations", "docs"]
    .flatMap(folder => existsSync(join(source, folder)) ? walk(join(source, folder)) : []);
  files.push(...["pyproject.toml", "uv.lock", "README.md", "LICENSE"].map(name => join(source,name)));
  const entries = {};
  for (const file of files.sort()) {
    const name = relative(source,file).replaceAll("\\", "/"), bytes = readFileSync(file);
    const destination = join(snapshot,name); mkdirSync(dirname(destination), {recursive:true});
    writeFileSync(destination, bytes); entries[name] = {sha256:hash(bytes),bytes:bytes.length};
  }
  for (const file of files) {
    const name = relative(source,file).replaceAll("\\", "/");
    if (hash(readFileSync(file)) !== entries[name].sha256) throw new Error("Chem source changed while snapshotting.");
  }
  let commit = null;
  try { commit = execFileSync("git", ["-c", `safe.directory=${source.replaceAll("\\", "/")}`, "-C", source, "rev-parse", "HEAD"], {encoding:"utf8",windowsHide:true}).trim(); } catch {}
  const manifest = {version:"chem-source-snapshot/v1",sourceRoot:source,sourceCommit:commit,
    capturedAt:new Date().toISOString(),includesUncommittedWorkingTree:true,
    sourceManifestHash:hash(JSON.stringify(entries)),files:entries};
  writeFileSync(join(snapshot,"snapshot-manifest.json"),JSON.stringify(manifest,null,2)+"\n");
}
const manifest = JSON.parse(readFileSync(join(snapshot,"snapshot-manifest.json"),"utf8"));
for (const [name,entry] of Object.entries(manifest.files)) {
  const bytes = readFileSync(join(snapshot,name));
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Chem snapshot mismatch: ${name}`);
}

// UI overlays are deliberately outside the immutable scientific source snapshot.
const typography = selectTypography(app);
const ui = syncChemTypography(app, typography);
console.log(JSON.stringify({snapshot,files:Object.keys(manifest.files).length,sourceManifestHash:manifest.sourceManifestHash,ui,typography:typography.profile}));
