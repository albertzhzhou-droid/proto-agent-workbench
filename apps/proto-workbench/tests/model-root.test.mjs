import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LM_STUDIO_BASE_URL } from "../src/main/services/lm-studio-provider.ts";

test("the desktop model path is fixed to LM Studio and does not instantiate legacy scanners or runtimes", async () => {
  const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifestGenerator = await readFile(new URL("../scripts/generate-module-manifest.mjs", import.meta.url), "utf8");
  const modules = await readFile(new URL("../src/shared/modules.ts", import.meta.url), "utf8");

  assert.equal(LM_STUDIO_BASE_URL, "http://127.0.0.1:1234");
  assert.match(main, /new LmStudioProvider\(\)/);
  assert.match(main, /modelService\.scan\(LM_STUDIO_BASE_URL\)/);
  assert.doesNotMatch(main, /new LlamaServerManager/);
  assert.doesNotMatch(main, /new ModelCatalogService/);
  assert.doesNotMatch(main, /resolveModelLibraryRoot/);
  assert.match(main, /Model directory selection is disabled/);
  assert.match(main, /Runtime selection is disabled/);
  assert.equal(
    packageJson.build.extraResources.some((entry) => entry.to === "runtime/llama.cpp"),
    false,
    "packaged builds must not include the legacy bundled model runtime",
  );
  assert.doesNotMatch(
    manifestGenerator,
    /runtime[\\/]llama\.cpp|groups\.llama|llamaFiles/,
    "the integrity manifest must not claim legacy runtime files that the package intentionally omits",
  );
  assert.match(modules, /LM Studio catalogue discovery, explicit instance lifecycle, ownership-safe unload/);
  assert.doesNotMatch(modules, /exact-context llama\.cpp lifecycle/);
});
