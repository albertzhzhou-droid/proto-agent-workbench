import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TYPOGRAPHY_PROFILES = Object.freeze(["auto", "local", "public"]);
const aliases = Object.freeze({
  "Anthropic Sans Text": "Proto Sans Text",
  "Anthropic Sans Display": "Proto Sans Display",
  "Anthropic Serif Text": "Proto Serif Text",
  "Anthropic Serif Display": "Proto Serif Display",
  "Anthropic Mono Web": "Proto Mono",
});
const publicFaces = [
  ...["normal", "italic"].flatMap(style => [
    { family: "Newsreader", aliases: ["Proto Serif Text", "Proto Serif Display"], style, weight: "200 800", file: `newsreader/Newsreader${style === "italic" ? "-Italic" : ""}[opsz,wght].woff2` },
    { family: "Hanken Grotesk", aliases: ["Proto Sans Text", "Proto Sans Display"], style, weight: "100 900", file: `hanken-grotesk/HankenGrotesk${style === "italic" ? "-Italic" : ""}[wght].woff2` },
    { family: "Commit Mono", aliases: ["Proto Mono"], style, weight: "200 700", file: "commit-mono/CommitMonoV143-VF.woff2" },
  ]),
];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const fontExtension = /\.(?:otf|ttf|woff2?)$/i;
const slash = value => value.replaceAll("\\", "/");

function containedFile(root, name) {
  if (typeof name !== "string" || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")) throw Error("Invalid typography asset path.");
  const path = resolve(root, name), rel = relative(resolve(root), path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("Typography asset escapes its root.");
  for (let cursor = path; cursor !== dirname(resolve(root)); cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw Error("Linked typography assets are not accepted.");
  }
  return path;
}
function verifiedFiles(root, records) {
  const seen = new Set();
  return records.map(record => {
    const path = containedFile(root, record.file);
    if (seen.has(record.file)) throw Error("Duplicate typography asset.");
    seen.add(record.file);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw Error(`Missing typography asset: ${record.file}`);
    const bytes = readFileSync(path);
    if (!/^[a-f0-9]{64}$/.test(record.sha256) || digest(bytes) !== record.sha256 || (record.bytes !== undefined && record.bytes !== bytes.length)) throw Error(`Typography asset digest mismatch: ${record.file}`);
    return { file: record.file, sha256: record.sha256, bytes: bytes.length, path };
  });
}

/** A single choice supplies the native renderer, browser development server and Chem. */
export function selectTypography(appRoot, requested = process.env.PROTO_TYPOGRAPHY_PROFILE || "auto") {
  if (!TYPOGRAPHY_PROFILES.includes(requested)) throw Error(`Invalid typography profile: ${requested}`);
  const root = resolve(appRoot, "src/renderer/assets/fonts");
  let local;
  if (requested !== "public") {
    const manifest = join(root, "anthropic/manifest.json");
    local = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
    if (!Array.isArray(local) || local.length !== 46 || local.some(face => !aliases[face.family] || !["normal", "italic"].includes(face.style))) throw Error("Local typography metadata is incomplete.");
  }
  const localComplete = local?.every(face => existsSync(containedFile(join(root, "anthropic"), face.file))) ?? false;
  const profile = requested === "auto" ? (localComplete ? "local" : "public") : requested;
  if (profile === "local") {
    if (!localComplete) throw Error("Local typography requires all 46 original Anthropic files; use public for redistribution.");
    return { profile, root: join(root, "anthropic"), files: verifiedFiles(join(root, "anthropic"), local),
      faces: local.map(face => ({ ...face, aliases: [aliases[face.family]], format: "opentype" })) };
  }
  const publicRoot = join(root, "public"), manifest = JSON.parse(readFileSync(join(publicRoot, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest.files)) throw Error("Public typography manifest is missing its files.");
  const files = verifiedFiles(publicRoot, manifest.files);
  const expected = [...new Set(publicFaces.map(face => face.file))].sort();
  const actual = files.filter(file => fontExtension.test(file.file)).map(file => file.file).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error("Public typography must contain exactly the reviewed five WOFF2 assets.");
  for (const name of ["newsreader/OFL.txt", "hanken-grotesk/OFL.txt", "commit-mono/LICENSE-FONT"]) {
    if (!files.some(file => file.file === name)) throw Error(`Public typography license is missing: ${name}`);
  }
  return { profile, root: publicRoot, files, faces: publicFaces.map(face => ({ ...face, format: "woff2" })) };
}

export function typographyCss(selection, prefix = "./assets/fonts/") {
  const folder = selection.profile === "local" ? "anthropic" : "public";
  const lines = [`/* Selected typography: ${selection.profile}. Original font bytes are unchanged. */`, `:root { --proto-typography-profile: "${selection.profile}"; }`];
  for (const face of selection.faces) {
    for (const family of [face.family, ...face.aliases]) {
      const url = `${prefix}${folder}/${face.file}`;
      lines.push(`@font-face { font-family: ${JSON.stringify(family)}; src: url(${JSON.stringify(url)}) format(${JSON.stringify(face.format)}); font-style: ${face.style}; font-weight: ${face.weight}; font-display: swap; }`);
    }
  }
  return `${lines.join("\n")}\n`;
}
function walk(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Linked generated typography resource: ${path}`);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
export function typographyReceipt(selection) {
  return { schemaVersion: "proto-workbench.typography.v1", profile: selection.profile,
    families: [...new Set(selection.faces.map(face => face.family))],
    files: selection.files.map(({ path: _path, ...file }) => file) };
}

/** Only the generated Chem font directory is replaced; original local files are untouched. */
export function syncChemTypography(appRoot, selection = selectTypography(appRoot), { isolated = false } = {}) {
  const app = resolve(appRoot);
  const ui = isolated ? join(app, "runtime/chem-ui-profiles", selection.profile) : join(app, "runtime/chem-ui");
  const fonts = join(ui, "fonts");
  for (const path of [app, join(app, "runtime"), ...(isolated ? [join(app, "runtime/chem-ui-profiles")] : []), ui, fonts]) {
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || resolve(realpathSync(path)).toLowerCase() !== path.toLowerCase())) throw Error("Chem typography output must not cross a link.");
  }
  const expected = isolated ? join("runtime", "chem-ui-profiles", selection.profile, "fonts") : join("runtime", "chem-ui", "fonts");
  if (!["public", "local"].includes(selection.profile) || relative(app, fonts) !== expected) throw Error("Invalid generated font boundary.");
  walk(fonts); // Reject redirected descendants before recursive removal.
  if (existsSync(fonts)) rmSync(fonts, { recursive: true });
  mkdirSync(fonts, { recursive: true });
  const folder = selection.profile === "local" ? "anthropic" : "public";
  for (const file of selection.files) {
    const target = join(fonts, folder, file.file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.path, target);
  }
  for (const source of walk(join(app, "src/chem-ui"))) {
    const target = join(ui, relative(join(app, "src/chem-ui"), source));
    if (target === join(ui, "fonts.css")) continue;
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
  }
  writeFileSync(join(ui, "fonts.css"), typographyCss(selection, "./fonts/"));
  writeFileSync(join(ui, "typography-profile.json"), `${JSON.stringify(typographyReceipt(selection), null, 2)}\n`);
  return ui;
}

/** Check actual generated bytes, not just the requested environment variable. */
export function assertTypographyOutput(appRoot, outputRoot, expected = "public") {
  if (!["public", "local"].includes(expected)) throw Error("Output verification needs an explicit typography profile.");
  const selection = selectTypography(appRoot, expected);
  const receipt = JSON.parse(readFileSync(join(outputRoot, "typography-profile.json"), "utf8"));
  if (JSON.stringify(receipt) !== JSON.stringify(typographyReceipt(selection))) throw Error("Typography output receipt does not match the selected profile.");
  const allowed = new Set(selection.files.filter(file => fontExtension.test(file.file)).map(file => file.sha256));
  const codicon = join(appRoot, "node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf");
  const iconHash = existsSync(codicon) ? digest(readFileSync(codicon)) : undefined;
  const privateManifest = join(appRoot, "src/renderer/assets/fonts/anthropic/manifest.json");
  const privateHashes = new Set(existsSync(privateManifest) ? JSON.parse(readFileSync(privateManifest, "utf8")).map(file => file.sha256) : []);
  const observed = new Set();
  for (const path of walk(outputRoot)) {
    const bytes = readFileSync(path), actual = digest(bytes);
    if (expected === "public" && privateHashes.has(actual)) throw Error(`Private font bytes in public output: ${relative(outputRoot, path)}`);
    if (fontExtension.test(path)) {
      // Monaco's icon font is independent of the selected text families. Admit
      // only the exact bytes from the installed locked dependency, never a name.
      if (actual === iconHash && path.endsWith(".ttf")) continue;
      if (!allowed.has(actual) || (expected === "public" && !path.endsWith(".woff2"))) throw Error(`Unapproved font in ${expected} output: ${relative(outputRoot, path)}`);
      observed.add(actual);
    }
    if (expected === "public" && path.endsWith(".css") && /Anthropic|\.otf(?:["')?]|$)|data:font\/(?:otf|opentype)/i.test(readFileSync(path, "utf8"))) throw Error("Public CSS contains a private font reference.");
  }
  if ([...allowed].some(hash => !observed.has(hash))) throw Error("Generated output is missing selected font bytes.");
  if (expected === "public") for (const file of selection.files.filter(file => !fontExtension.test(file.file))) {
    const target = join(outputRoot, "fonts/public", file.file);
    if (!existsSync(target) || digest(readFileSync(target)) !== file.sha256) throw Error(`Public output license missing or changed: ${file.file}`);
  }
  return { profile: expected, fontFiles: observed.size, output: slash(resolve(outputRoot)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const command = process.argv[2], profile = process.argv[3] || "public";
    if (command === "verify") {
      const kind = process.argv[4] || "desktop";
      if (!["desktop", "renderer"].includes(kind)) throw Error("Output kind must be desktop or renderer.");
      console.log(JSON.stringify([assertTypographyOutput(app, join(app, kind === "renderer" ? "dist" : "out/renderer"), profile), assertTypographyOutput(app, join(app, "runtime/chem-ui"), profile)]));
    } else if (command === "inspect") console.log(JSON.stringify(typographyReceipt(selectTypography(app, process.argv[3] || process.env.PROTO_TYPOGRAPHY_PROFILE || "auto"))));
    else throw Error("Use typography-profile.mjs inspect [auto|local|public] or verify [public|local] [desktop|renderer].");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
