import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { decodeSvgForVerification, MAP_DECODER_DOCUMENT_URL } from "../src/main/services/map-image-decoder.ts";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

/** Diagnostic only: retain actual temporary request bytes; never bypass export validation. */
export async function runScientificNativeMapDiagnostic({ page, report, check, screenshot, waitUntil, workspace, evidence, callMain }) {
  report.testScope = "Diagnostic only: actual medium SVG request and independent IMG canvas/capture pixels. No export/performance acceptance claim.";
  const output = join(workspace, "build", "visualization-exports");
  const retained = join(evidence, "actual-medium-request.svg");
  await mkdir(output, { recursive: true });
  await check("retain exact native SVG request without bypassing failed export validation", async () => {
    await page.locator(".design-document").filter({ hasText: "GOVERNED_SOFTWARE_EXPORT_100K_2000" }).first().click();
    const button = page.getByRole("button", { name: "SVG", exact: true });
    await waitUntil(async () => await button.isEnabled());
    let bytes, temporaryName, stopped = false;
    const monitor = (async () => {
      const deadline = Date.now() + 30_000;
      while (!stopped && Date.now() < deadline && !bytes) {
        for (const name of await readdir(output)) {
          if (!name.endsWith(".image.tmp")) continue;
          const candidate = await readFile(join(output, name)).catch(() => undefined);
          if (candidate && candidate.length > 32 && candidate.length <= 16 * 1024 * 1024 && candidate.subarray(0, 300).toString("utf8").includes("<svg")) {
            bytes = candidate; temporaryName = name; await writeFile(retained, bytes, { flag: "wx" }); break;
          }
        }
        if (!bytes) await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    try { await button.click(); await waitUntil(async () => bytes, 30_000); }
    finally { stopped = true; await monitor; }
    assert(bytes, "Actual export temporary bytes were not observed.");
    await waitUntil(async () => !(await readdir(output)).includes(temporaryName), 20_000);
    const productStatus = await page.locator(".map-export-status").innerText().catch(async () => (await page.locator("body").innerText()).split("LATEST MAP EXPORT").at(-1));
    const decoded = await sharp(bytes).metadata();
    const png = await sharp(bytes).png().toBuffer();
    await writeFile(join(evidence, "actual-medium-librsvg.png"), png, { flag: "wx" });
    const metadataMatch = bytes.toString("utf8").match(/<metadata\b[^>]*id=["']proto-workbench-map-export["'][^>]*>([\s\S]*?)<\/metadata>/i);
    report.mapDiagnostic = { requestPath: retained, sha256: digest(bytes), bytes: bytes.length, width: decoded.width, height: decoded.height, temporaryName, productStatus, embeddedMetadata: metadataMatch?.[1], librsvgPngSha256: digest(png), exportDirectoryAfter: await readdir(output) };
    await screenshot("diagnostic-01-actual-native-export-status");
    return report.mapDiagnostic;
  });
  await check("same SVG bytes IMG canvas pixels compared with hidden native capture", async () => {
    const bytes = await readFile(retained); const expected = { width: report.mapDiagnostic.width, height: report.mapDiagnostic.height };
    await callMain(`
      if (globalThis.__protoQaImageWindow) throw new Error("Diagnostic window already exists.");
      const partition = "qa-map-diagnostic-" + process.getBuiltinModule("crypto").randomUUID();
      const isolated = electron.session.fromPartition(partition, { cache: false });
      isolated.setPermissionRequestHandler((_c,_p,cb)=>cb(false)); isolated.setPermissionCheckHandler(()=>false);
      isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, cb)=>cb({cancel: details.url !== ${JSON.stringify(MAP_DECODER_DOCUMENT_URL)} && !details.url.startsWith("blob:")}));
      globalThis.__protoQaImageWindow = new electron.BrowserWindow({show:false,paintWhenInitiallyHidden:true,width:${expected.width},height:${expected.height},useContentSize:true,backgroundColor:"#fff",webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false,partition}});
      globalThis.__protoQaImageWindow.webContents.setWindowOpenHandler(()=>({action:"deny"}));
      return true;
    `);
    try {
      const result = await decodeSvgForVerification({
        loadURL: url => callMain(`await globalThis.__protoQaImageWindow.loadURL(${JSON.stringify(url)}); return true;`),
        executeJavaScript: script => callMain(`return await globalThis.__protoQaImageWindow.webContents.executeJavaScript(${JSON.stringify(script)});`),
      }, bytes, expected);
      const comparison = await callMain(`
        const win = globalThis.__protoQaImageWindow;
        const fs = process.getBuiltinModule("fs"), crypto = process.getBuiltinModule("crypto");
        const measure = image => {
          const bitmap=image.resize({width:128,height:128,quality:"best"}).toBitmap(), colors=new Set();
          for(let i=0;i<bitmap.length;i+=4) colors.add(bitmap.subarray(i,i+4).toString("hex"));
          return {size:image.getSize(),sampledColors:colors.size,sampleSha256:crypto.createHash("sha256").update(bitmap).digest("hex")};
        };
        const capture = await win.webContents.capturePage({x:0,y:0,width:${expected.width},height:${expected.height}});
        fs.writeFileSync(${JSON.stringify(join(evidence, "actual-medium-hidden-capture.png"))},capture.toPNG(),{flag:"wx"});
        const canvasResult = await win.webContents.executeJavaScript(${JSON.stringify(`(() => { const image=document.getElementById("map"), canvas=document.createElement("canvas"); canvas.width=${expected.width};canvas.height=${expected.height};const context=canvas.getContext("2d");context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0);return {url:canvas.toDataURL("image/png"), imageRect:image.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}}; })()`)});
        const canvasBytes=Buffer.from(canvasResult.url.split(",")[1],"base64");
        fs.writeFileSync(${JSON.stringify(join(evidence, "actual-medium-img-canvas.png"))},canvasBytes,{flag:"wx"});
        return {capture:measure(capture),canvas:measure(electron.nativeImage.createFromBuffer(canvasBytes)),imageRect:canvasResult.imageRect,viewport:canvasResult.viewport};
      `);
      report.mapDiagnostic.comparison = { decode: result, ...comparison };
      await writeFile(join(evidence, "map-diagnostic.json"), JSON.stringify(report.mapDiagnostic, null, 2), { flag: "wx" });
      return report.mapDiagnostic.comparison;
    } finally { await callMain(`const win=globalThis.__protoQaImageWindow; if(win&&!win.isDestroyed())win.destroy();delete globalThis.__protoQaImageWindow;return true;`).catch(()=>undefined); }
  });
}
