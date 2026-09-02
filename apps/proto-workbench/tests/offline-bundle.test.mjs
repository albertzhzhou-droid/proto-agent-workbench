import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("packaged renderer keeps Monaco and its workers offline", async () => {
  const rendererRoot = resolve("out", "renderer");
  const assets = await readdir(resolve(rendererRoot, "assets"));
  const javaScriptAssets = assets.filter((name) => name.endsWith(".js"));
  assert.ok(javaScriptAssets.some((name) => name.startsWith("editor.worker-")), "Editor worker must be emitted");
  assert.ok(javaScriptAssets.some((name) => name.startsWith("json.worker-")), "JSON worker must be emitted");
  const content = (
    await Promise.all(javaScriptAssets.map((name) => readFile(resolve(rendererRoot, "assets", name), "utf8")))
  ).join("\n");
  assert.match(content, /editor\.worker-[\w-]+\.js/);
  assert.match(content, /json\.worker-[\w-]+\.js/);
  assert.doesNotMatch(content, /T7 promoter library v1|CRISPRi cascade design/);
  const html = await readFile(resolve(rendererRoot, "index.html"), "utf8");
  assert.match(html, /script-src 'self'/);
  assert.match(html, /worker-src 'self' blob:/);
  assert.doesNotMatch(html, /script-src[^;]*https?:/);
  await access(resolve("out", "preload", "index.cjs"));
  const main = await readFile(resolve("out", "main", "index.js"), "utf8");
  assert.match(main, /preload\/index\.cjs|preload\\index\.cjs/);
});
