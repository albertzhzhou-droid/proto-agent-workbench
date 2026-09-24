import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTypographyOutput, selectTypography, syncChemTypography, typographyCss } from "../scripts/typography-profile.mjs";
import { typographyPlugin } from "../scripts/typography-vite.mjs";
import { chemUiResourceType } from "../src/main/services/chem-workbench.ts";

const app = fileURLToPath(new URL("..", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fontsAt = root => join(root, "src/renderer/assets/fonts");
function fixture({ local = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "proto-typography-")), fonts = fontsAt(root);
  mkdirSync(join(fonts, "anthropic"), { recursive: true });
  cpSync(join(fontsAt(app), "public"), join(fonts, "public"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(fontsAt(app), "anthropic/manifest.json"), "utf8")).map((face, index) => {
    const bytes = Buffer.from(`fixture local font ${index}`);
    if (local) writeFileSync(join(fonts, "anthropic", face.file), bytes);
    return { ...face, sha256: sha(bytes), bytes: bytes.length };
  });
  writeFileSync(join(fonts, "anthropic/manifest.json"), JSON.stringify(manifest));
  mkdirSync(join(root, "src/chem-ui"), { recursive: true });
  writeFileSync(join(root, "src/chem-ui/paper-chem.css"), ':root{font-family:"Proto Sans Text"}');
  return { root, manifest };
}

test("auto preserves all 46 local faces, while public overrides their presence", () => {
  const { root, manifest } = fixture();
  const local = selectTypography(root, "auto"), publicProfile = selectTypography(root, "public");
  assert.equal(local.profile, "local");
  assert.equal(local.faces.length, 46);
  assert.equal(publicProfile.profile, "public");
  const css = typographyCss(publicProfile);
  assert.doesNotMatch(css, /Anthropic|\.otf/);
  for (const family of ["Newsreader", "Hanken Grotesk", "Commit Mono", "Proto Sans Text", "Proto Sans Display", "Proto Serif Text", "Proto Serif Display", "Proto Mono"]) assert.ok(css.includes(`"${family}"`));
  unlinkSync(join(fontsAt(root), "anthropic", manifest[0].file));
  assert.equal(selectTypography(root, "auto").profile, "public");
  assert.throws(() => selectTypography(root, "local"), /all 46/);
});

test("a clean public checkout needs no local binaries and rejects asset drift", () => {
  const { root } = fixture({ local: false });
  assert.equal(selectTypography(root, "auto").profile, "public");
  assert.throws(() => selectTypography(root, "unexpected"), /Invalid typography profile/);
  const profile = selectTypography(root, "public");
  writeFileSync(profile.files[0].path, "changed bytes");
  assert.throws(() => selectTypography(root, "public"), /digest mismatch/);
});

test("a complete but altered local collection fails without quietly changing the user's profile", () => {
  const { root, manifest } = fixture();
  writeFileSync(join(fontsAt(root), "anthropic", manifest[0].file), "tampered");
  assert.throws(() => selectTypography(root, "auto"), /digest mismatch/);
  assert.equal(selectTypography(root, "public").profile, "public");
});

test("switching generated Chem UI from local to public removes stale private copies only", () => {
  const { root, manifest } = fixture();
  const original = join(fontsAt(root), "anthropic", manifest[0].file), before = readFileSync(original);
  const ui = syncChemTypography(root, selectTypography(root, "local"));
  assert.equal(assertTypographyOutput(root, ui, "local").fontFiles, 46);
  syncChemTypography(root, selectTypography(root, "public"));
  assert.deepEqual(readdirSync(join(ui, "fonts")), ["public"]);
  assert.deepEqual(readFileSync(original), before);
  assert.equal(assertTypographyOutput(root, ui, "public").fontFiles, 5);
  writeFileSync(join(ui, "hidden-private-font.bin"), before);
  assert.throws(() => assertTypographyOutput(root, ui, "public"), /Private font bytes/);
});

test("public output requires the actual license files and rejects unapproved font bytes", () => {
  const { root } = fixture();
  const ui = syncChemTypography(root, selectTypography(root, "public"));
  const license = join(ui, "fonts/public/newsreader/OFL.txt"), original = readFileSync(license);
  unlinkSync(license);
  assert.throws(() => assertTypographyOutput(root, ui, "public"), /license missing or changed/);
  writeFileSync(license, original);
  writeFileSync(join(ui, "unapproved.otf"), "not a reviewed font");
  assert.throws(() => assertTypographyOutput(root, ui, "public"), /Unapproved font/);
});

test("renderer admits only the exact installed Monaco icon font independently of typography", () => {
  const { root } = fixture();
  const ui = syncChemTypography(root, selectTypography(root, "public"));
  const icon = join(root, "node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf");
  mkdirSync(dirname(icon), { recursive: true }); writeFileSync(icon, "fixture icon font");
  copyFileSync(icon, join(ui, "codicon-hashed.ttf"));
  assert.equal(assertTypographyOutput(root, ui, "public").fontFiles, 5);
  writeFileSync(join(ui, "codicon-hashed.ttf"), "replaced icon bytes");
  assert.throws(() => assertTypographyOutput(root, ui, "public"), /Unapproved font/);
});

test("Vite profile emits real OFL licenses and public CSS without missing local references", () => {
  const { root } = fixture({ local: false }), plugin = typographyPlugin(root), emitted = [];
  plugin.configResolved();
  assert.doesNotMatch(plugin.load(resolve(root, "src/renderer/fonts.css")), /Anthropic|\.otf/);
  plugin.generateBundle.call({ emitFile(asset) { emitted.push(asset); } });
  assert.equal(emitted.length, 4);
  for (const name of ["fonts/public/newsreader/OFL.txt", "fonts/public/hanken-grotesk/OFL.txt", "fonts/public/commit-mono/LICENSE-FONT"]) {
    assert.match(emitted.find(asset => asset.fileName === name).source.toString("utf8"), /SIL OPEN FONT LICENSE/i);
  }
});

test("concurrent source profiles keep their own Chem bytes and do not rewrite packaging inputs", () => {
  const { root } = fixture(), local = typographyPlugin(root, "local"), publicPlugin = typographyPlugin(root, "public");
  const localConfig = { command: "serve", define: {} }, publicConfig = { command: "serve", define: {} };
  const shared = syncChemTypography(root, selectTypography(root, "local"));
  const sharedBefore = readFileSync(join(shared, "fonts.css"));
  local.configResolved(localConfig);
  const localRoot = join(root, "runtime/chem-ui-profiles/local"), localBefore = readFileSync(join(localRoot, "fonts.css"));
  publicPlugin.configResolved(publicConfig);
  const publicRoot = join(root, "runtime/chem-ui-profiles/public"), publicBefore = readFileSync(join(publicRoot, "fonts.css"));
  assert.deepEqual(readFileSync(join(localRoot, "fonts.css")), localBefore);
  assert.deepEqual(readFileSync(join(shared, "fonts.css")), sharedBefore);
  assert.equal(JSON.parse(localConfig.define.__PROTO_TYPOGRAPHY_PROFILE__), "local");
  assert.equal(JSON.parse(publicConfig.define.__PROTO_TYPOGRAPHY_PROFILE__), "public");
  assert.equal(assertTypographyOutput(root, localRoot, "local").fontFiles, 46);
  assert.equal(assertTypographyOutput(root, publicRoot, "public").fontFiles, 5);
  // A subsequent public package/source build may replace the shared staging
  // tree without changing either already-pinned source-session directory.
  typographyPlugin(root, "public").configResolved({ command: "build", define: {} });
  assert.deepEqual(readFileSync(join(localRoot, "fonts.css")), localBefore);
  assert.deepEqual(readFileSync(join(publicRoot, "fonts.css")), publicBefore);
  assert.equal(assertTypographyOutput(root, shared, "public").fontFiles, 5);
});

test("Chem font routes admit only selected path forms and preserve correct MIME types", () => {
  assert.equal(chemUiResourceType("fonts/public/newsreader/Newsreader[opsz,wght].woff2"), "font/woff2");
  assert.equal(chemUiResourceType("fonts/anthropic/Anthropic Mono Web.otf"), "font/otf");
  for (const path of ["fonts/../../secrets", "fonts/public/newsreader/../secret.woff2", "fonts/public/unknown/font.woff2", "fonts/public/newsreader/font.js", "fonts/public/newsreader/sub/font.woff2", "fonts/anthropic/font.woff2"]) assert.equal(chemUiResourceType(path), undefined);
});
