import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

export async function runScientificNativeMediumExport({ page, report, check, screenshot, waitUntil, workspace, fileTree }) {
  report.testScope = "Governed 100kbp/2000-feature native SVG and PNG export timing; no inference";
  const residency = () => page.evaluate(async () => (await window.workbench.models.list()).filter(model => model.loadedInstances?.length).map(model => ({ key: model.providerModelId, instances: model.loadedInstances.map(instance => ({ id: instance.id, contextLength: instance.contextLength })), ownedByThisWorkbench: model.workbenchInstance?.ownedByWorkbench ?? false })));
  report.timingEnvironment = { startedAt: new Date().toISOString(), modelsLoadedByThisQa: false, residentModelsBefore: await residency(), quietWindowAuthority: "Coordinator acknowledgement of no active generation; any loaded idle model residency is recorded separately." };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const path = join(workspace, "build", "governed-medium.ir.json");
  const initial = hash(await readFile(path));
  await check("native governed 100kbp 2000-feature SVG and PNG export", async () => {
    const document = page.locator(".design-document").filter({ hasText: "GOVERNED_SOFTWARE_EXPORT_100K_2000" }).first();
    await document.waitFor(); await document.click();
    await page.getByRole("button", { name: "PNG", exact: true }).waitFor();
    await waitUntil(async () => await page.getByRole("button", { name: "PNG", exact: true }).isEnabled());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await screenshot("medium-01-governed-100kbp-2000-features");
    const exports = [];
    for (const format of ["SVG", "PNG"]) {
      const previous = new Set(await fileTree(join(workspace, "build")));
      const started = performance.now();
      await page.getByRole("button", { name: format, exact: true }).click();
      const receipt = page.getByRole("region", { name: "Latest map export verification" });
      await receipt.waitFor();
      const result = await waitUntil(async () => {
        const candidates = (await fileTree(join(workspace, "build", "visualization-exports"))).filter((item) => item.endsWith(`.${format.toLowerCase()}`) && !previous.has(item));
        if (candidates.length !== 1) return;
        const text = await receipt.innerText();
        if (!text.includes("Independently reopened") || !text.includes(basename(candidates[0]))) return;
        return candidates[0];
      });
      const elapsedMs = performance.now() - started;
      const bytes = await readFile(result); const decoded = await sharp(bytes).metadata();
      assert(decoded.width > 100 && decoded.height > 100);
      assert(elapsedMs <= 5000, `Governed medium ${format} export exceeded five seconds: ${elapsedMs.toFixed(2)}ms.`);
      exports.push({ format, elapsedMs, path: result, sha256: hash(bytes), bytes: bytes.length, width: decoded.width, height: decoded.height, independentlyDecoded: "sharp" });
    }
    assert.equal(hash(await readFile(path)), initial);
    await screenshot("medium-02-independent-native-export-receipt");
    report.timingEnvironment.residentModelsAfter = await residency();
    report.timingEnvironment.finishedAt = new Date().toISOString();
    return { fixture: report.governedMediumFixture, sourceIrUnchanged: true, exports, timingScope: "Actual native export click through completed main-process independent reopen; 100000bp, 1000 governed occurrences plus 1000 user annotations. Software workload, no biological functionality claim." };
  });
}
