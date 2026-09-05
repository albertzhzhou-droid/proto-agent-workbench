import assert from "node:assert/strict";
import { readFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";

/** Bounded native UI measurements; no model request, synthetic governance claim or stress loop. */
export async function runScientificNativePerformance({ page, report, check, screenshot, waitUntil, workspace, fileTree, fixtureRoot, proteinGeometryPixels }) {
  const document = (title) => page.locator(".design-document").filter({ hasText: title }).first();
  const settledFrames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readyDna = async () => {
    await settledFrames();
    await page.locator(".design-computation-status").waitFor({ state: "hidden", timeout: 60_000 });
    await page.locator(".map-engine-pane .cgview-canvas-host canvas").first().waitFor();
    await settledFrames();
  };
  const loadProtein = async () => {
    await document("protein-observatory-phoa").click();
    await page.getByLabel("Saved attachments").selectOption(report.proteinAttachment.id);
    await settledFrames();
    await waitUntil(async () => await page.getByLabel(/^Chain/).isEnabled(), 60_000);
    assert.equal(await page.locator(".protein-structure-fallback").count(), 0);
    await settledFrames();
    return await waitUntil(async () => { const pixels = await proteinGeometryPixels(); return pixels.ratio > .005 ? pixels : undefined; }, 8000);
  };
  const measurements = { synthetic: report.syntheticFixture, inventoryLoadMs: report.inventoryLoadMs,
    scope: "100 kbp / 2,000 explicitly synthetic features for layout and selection; eligible 896 bp DNA for governed export; actual PDB 1B8J for resource switching", switches: [] };
  report.performance = measurements;

  await check("100 kbp 2000-feature native initial display", async () => {
    const started = performance.now();
    await document("SYNTHETIC_PERFORMANCE_100K_2000").click();
    await readyDna();
    measurements.firstDisplayMs = performance.now() - started;
    measurements.inventoryAndFirstDisplayMs = measurements.inventoryLoadMs + measurements.firstDisplayMs;
    measurements.initialLoadTargetMet = measurements.inventoryAndFirstDisplayMs <= 3000;
    assert.equal(await page.locator(".visualization-summary-mode").count(), 0, "Medium fixture must use actual interactive renderers.");
    assert(await page.getByRole("button", { name: "PNG", exact: true }).isDisabled(), "Synthetic fixture must retain the governed export block.");
    await screenshot("perf-01-synthetic-100kbp-2000");
    return { firstDisplayMs: measurements.firstDisplayMs, inventoryAndFirstDisplayMs: measurements.inventoryAndFirstDisplayMs, targetMs: 3000, targetMet: measurements.initialLoadTargetMet, syntheticExport: "blocked as expected; no governed eligibility was invented" };
  });

  await check("medium DNA native selection latency", async () => {
    const labels = await page.locator(".part-row-select").evaluateAll((elements) => elements.filter((element) => element.getAttribute("aria-pressed") !== "true").slice(0, 20).map((element) => element.getAttribute("aria-label")));
    assert.equal(labels.length, 20);
    const samples = [];
    for (const label of labels) {
      const button = page.getByRole("button", { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      const measured = button.evaluate((element) => new Promise((resolve, reject) => {
        let started;
        const observer = new MutationObserver(() => {
          if (started === undefined || element.getAttribute("aria-pressed") !== "true") return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(performance.now() - started); }));
        });
        const onClick = () => { started = performance.now(); };
        element.addEventListener("click", onClick, { once: true, capture: true });
        observer.observe(element, { attributes: true, attributeFilter: ["aria-pressed"] });
        const timer = setTimeout(() => { observer.disconnect(); element.removeEventListener("click", onClick, true); reject(new Error("Native selection never updated its accessible state.")); }, 3000);
      }));
      await button.click();
      samples.push(await measured);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    measurements.selection = { samplesMs: samples, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], targetMs: 100,
      method: "Captured native DOM click to committed aria-pressed selection plus two animation frames; Playwright transport and pre-click scrolling excluded." };
    measurements.selection.targetMet = measurements.selection.p95Ms <= 100;
    await screenshot("perf-02-synthetic-selection");
    return measurements.selection;
  });

  await check("governed native PNG export latency and independent reopen", async () => {
    await document("native_visualization_qa").click(); await readyDna();
    const started = performance.now();
    await page.getByRole("button", { name: "PNG", exact: true }).click();
    const receipt = page.getByRole("region", { name: "Latest map export verification" });
    await receipt.waitFor({ timeout: 60_000 }); assert.match(await receipt.innerText(), /Independently reopened/);
    const elapsedMs = performance.now() - started;
    const files = (await fileTree(join(workspace, "build", "visualization-exports"))).filter((path) => path.endsWith(".png"));
    assert.equal(files.length, 1);
    const bytes = await readFile(files[0]); const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    assert(decoded.info.width > 0 && decoded.info.height > 0);
    measurements.governedExport = { elapsedMs, targetMs: 5000, targetMet: elapsedMs <= 5000, path: files[0], bytes: bytes.length,
      width: decoded.info.width, height: decoded.info.height, scope: "Eligible 896 bp native DNA; synthetic 100 kbp export deliberately excluded by the product governance gate." };
    return measurements.governedExport;
  });

  await check("20 native document switches keep visible resources bounded", async () => {
    const session = await page.context().newCDPSession(page);
    const sample = async (index, kind, elapsedMs) => ({ index, kind, elapsedMs, workers: page.workers().map((worker) => worker.url()),
      ...await page.evaluate(() => ({ canvases: document.querySelectorAll("canvas").length, molecularCanvases: document.querySelectorAll(".protein-molecular-stage canvas").length, visibility: document.visibilityState })),
      heap: await session.send("Runtime.getHeapUsage"), dom: await session.send("Memory.getDOMCounters") });
    await document("SYNTHETIC_PERFORMANCE_100K_2000").click(); await readyDna();
    const dnaBaseline = await sample(0, "synthetic-dna", 0);
    await loadProtein(); await session.send("HeapProfiler.collectGarbage");
    const baseline = await sample(0, "protein", 0);
    measurements.resourceBaselines = { dna: dnaBaseline, protein: baseline };
    for (let index = 1; index <= 20; index += 1) {
      const started = performance.now();
      if (index % 2) { await document("SYNTHETIC_PERFORMANCE_100K_2000").click(); await readyDna(); }
      else await loadProtein();
      const expected = index % 2 ? dnaBaseline : baseline;
      await waitUntil(async () => page.workers().length <= expected.workers.length, 2000);
      const current = await sample(index, index % 2 ? "synthetic-dna" : "protein", performance.now() - started);
      measurements.switches.push(current);
      assert.equal(current.molecularCanvases, index % 2 ? 0 : 1, "Detached or duplicated molecular canvases remain after a settled switch.");
      assert.equal(current.workers.length, expected.workers.length, "Active worker count must match the separately measured baseline for the same document kind.");
      assert.deepEqual([...current.workers].sort(), [...expected.workers].sort(), "Active worker types must match the same document's settled baseline.");
    }
    await session.send("HeapProfiler.collectGarbage"); await settledFrames();
    const final = await sample(20, "protein-after-gc", 0);
    measurements.resources = { baseline, final, retainedHeapDeltaBytes: final.heap.usedSize - baseline.heap.usedSize, domNodeDelta: final.dom.nodes - baseline.dom.nodes,
      listenerDelta: final.dom.jsEventListeners - baseline.dom.jsEventListeners, interpretation: "One settled molecular canvas and bounded active workers across all switches. GC-normalized heap/DOM counters are observational and are not proof that every driver allocation is released." };
    assert.equal(final.molecularCanvases, baseline.molecularCanvases);
    assert.equal(final.workers.length, baseline.workers.length);
    await screenshot("perf-03-after-20-document-switches");
    await session.detach();
    return measurements.resources;
  });
  await check("one megabase native window navigation and full coordinates", async () => {
    const source = join(fixtureRoot, "synthetic-1mbp-2000.ir.json");
    const bytes = await readFile(source); const fixture = JSON.parse(bytes.toString("utf8"));
    assert.equal(fixture.constructs[0].length, 1_000_000); assert.equal(fixture.constructs[0].parts.length, 2000);
    const destination = join(workspace, "build", "synthetic-1mbp-2000.ir.json"); await copyFile(source, destination);
    const started = performance.now();
    await page.getByRole("button", { name: "Refresh artifacts", exact: true }).click();
    await document(fixture.design_id).waitFor({ timeout: 60_000 }); await document(fixture.design_id).click();
    const window = page.getByRole("region", { name: "Windowed DNA sequence review" });
    await window.waitFor();
    await settledFrames(); await window.getByText("Preparing sequence window…", { exact: true }).waitFor({ state: "hidden", timeout: 60_000 });
    const initialDisplayMs = performance.now() - started;
    const slider = page.getByRole("slider", { name: "DNA sequence window start" });
    assert.equal(await slider.inputValue(), "0");
    await window.getByRole("button", { name: "Next", exact: true }).click();
    await waitUntil(async () => await slider.inputValue() === "8000");
    await slider.focus(); await slider.press("End");
    await waitUntil(async () => await slider.inputValue() === "992000");
    await settledFrames(); await window.getByText("Preparing sequence window…", { exact: true }).waitFor({ state: "hidden" });
    assert.match((await window.locator("header").innerText()).replaceAll(",", ""), /992001–1000000/);
    await page.getByLabel("Filter feature names and types").fill("synthetic_1999");
    await page.locator(".design-computation-status").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /^Select synthetic_1999, misc_feature/ }).click();
    const selection = (await page.locator(".selection-card").innerText()).replaceAll(",", "");
    assert(selection.includes("999501") && selection.includes("1000000"), "Selection must retain full-construct rather than window-local coordinates.");
    assert(await page.getByRole("button", { name: "PNG", exact: true }).isDisabled());
    assert((await window.locator(".dna-window-seqviz").innerText()).length > 100, "Actual sequence letters must be visible in the bounded window.");
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.getByRole("button", { name: `Use ${theme} theme`, exact: true }).click();
      await window.scrollIntoViewIfNeeded(); await screenshot(`perf-04-one-megabase-window-${theme}`);
    }
    measurements.oneMegabase = { path: destination, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), initialDisplayMs,
      fullLength: 1_000_000, window: [992001, 1000000], selectedFeature: [999501, 1000000], governance: "synthetic/unverified; export blocked" };
    return measurements.oneMegabase;
  });
  await check("native performance acceptance targets", async () => {
    assert(measurements.initialLoadTargetMet, `Initial medium artifact inventory plus display took ${measurements.inventoryAndFirstDisplayMs.toFixed(1)} ms (target 3000).`);
    assert(measurements.selection.targetMet, `Selection p95 ${measurements.selection.p95Ms.toFixed(1)} ms exceeded 100 ms.`);
    assert(measurements.governedExport.targetMet, `Governed PNG export took ${measurements.governedExport.elapsedMs.toFixed(1)} ms (target 5000).`);
    return { initialLoad: true, selection: true, governedExport: true };
  });
}
