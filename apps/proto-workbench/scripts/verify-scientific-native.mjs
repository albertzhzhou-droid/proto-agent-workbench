// Owned, isolated Electron UI verification. Only --harness loads one explicit owned model.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile, readdir, realpath, lstat, cp, utimes } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { AppDatabase } from "../src/main/services/database.ts";

const sourceApp = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRepository = resolve(sourceApp, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).map((argument) => argument.split(/=(.*)/s).slice(0, 2)));
const appRoot = resolve(args["--app-root"] ?? sourceApp);
const parent = resolve(sourceRepository, "build", "upgrade-20260904", "native-qa");
const appRepository = resolve(appRoot, "..", "..");
const continuationId = args["--reopen-existing"] ? `reopen-${randomUUID().slice(0, 8)}` : undefined;
const qaRoot = resolve(args["--reopen-existing"] ?? args["--qa-root"] ?? join(appRepository, "build", "upgrade-20260904", "native-qa", `r-${randomUUID().slice(0, 8)}`));
const scope = relative(parent, qaRoot);
assert(scope && !scope.startsWith("..") && !isAbsolute(scope), "QA root must be a new child of the controlled native-qa directory.");
const workspace = join(qaRoot, "workspace");
const profile = join(qaRoot, "profile");
const evidence = continuationId ? join(qaRoot, "evidence", continuationId) : join(qaRoot, "evidence");
const reportPath = join(qaRoot, continuationId ? `${continuationId}.json` : "report.json");
const python = join(sourceRepository, ".venv", "Scripts", "python.exe");
const executable = join(sourceApp, "node_modules", "electron", "dist", "electron.exe");
let browser, mainInspector, launcher, page, stage = "prepare", launchIndex = 0;
const report = { schema: "proto-workbench.scientific-native-qa.v1", startedAt: new Date().toISOString(), qaRoot, appRoot,
  mode: "owned native development Electron; actual renderer and main services", testScope: args["--performance"] === "true" ? "bounded medium-size native timings and 20 document switches" : args["--protein-only"] === "true" ? "protein only; DNA interaction excluded" : "DNA and protein", modelsLoaded: false, tests: [], pageErrors: [], consoleErrors: [], screenshots: [], cli: [] };
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function cli(arguments_, cwd = workspace) {
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(python, ["-B", "-m", "proto_agent.cli", ...arguments_], { cwd, shell: false, windowsHide: true,
      env: { ...minimalEnvironment(), PYTHONPATH: join(sourceRepository, "src") }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; if (stdout.length > 4_000_000) child.kill(); });
    child.stderr.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => { child.kill(); }, 60_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); resolvePromise({ arguments: arguments_, code, stdout, stderr }); });
  });
  report.cli.push(result);
  assert.equal(result.code, 0, `CLI failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim().startsWith("{") ? JSON.parse(result.stdout) : result.stdout;
}

async function prepare() {
  if (continuationId) {
    const originalBytes = await readFile(join(qaRoot, "report.json"));
    const original = JSON.parse(originalBytes);
    assert.equal(original.qaRoot, qaRoot); assert(original.cleanupGate?.passed);
    assert.equal(args["--resume-paused"] === "true" ? original.harnessNative?.activeRestart?.paused?.state : original.harnessNative?.finalProjection?.state, args["--resume-paused"] === "true" ? "paused" : "completed");
    const owner = JSON.parse(await readFile(join(qaRoot, "qa-owner.json"), "utf8"));
    assert.equal(owner.qaRoot, qaRoot); assert.equal(owner.appRoot, original.appRoot);
    report.originalEvidence = { path: join(qaRoot, "report.json"), sha256: hash(originalBytes), appRoot: original.appRoot };
    report.harnessNative = original.harnessNative;
    report.previousNativeFailure = report.harnessNative.failure; delete report.harnessNative.failure;
    report.initialSourceSha256 = original.initialSourceSha256; report.initialPartsSha256 = original.initialPartsSha256;
    report.testScope = "Read-only real completed-mission inspection after same-profile application restart into a verified newer snapshot; native map export is the only new workspace artifact";
    while (await lstat(join(qaRoot, launchIndex === 0 ? "owned-launch.json" : `owned-launch-${launchIndex + 1}.json`)).catch(() => undefined)) launchIndex += 1;
    assert(launchIndex > 0 && launchIndex < 5);
    await mkdir(evidence, { recursive: false });
    return;
  }
  await mkdir(qaRoot, { recursive: true });
  assert.equal((await readdir(qaRoot)).length, 0, "Refusing to reuse an existing profile or workspace.");
  for (const path of [workspace, profile, evidence, join(workspace, "parts"), join(workspace, "designs"), join(workspace, "build")]) await mkdir(path, { recursive: true });
  for (const directory of ["workflows", "connectors", "literature", ".codex/skills"]) await cp(join(sourceRepository, directory), join(workspace, directory), { recursive: true, errorOnExist: true, force: false });
  // The unchanged connector registry declares this toy baseline; every test design explicitly binds eligible.json.
  await copyFile(join(sourceRepository, "parts", "ecoli_k12_library.json"), join(workspace, "parts", "ecoli_k12_library.json"));
  const names = ["BBa_J23119", "BBa_B0034", "BBa_E0040", "BBa_B0015"];
  const ids = [];
  for (const name of names) {
    const found = await cli(["materials", "search", name, "--kind", "genetic_part", "--status", "DESIGN_ELIGIBLE", "--snapshot", "public-reviewed-2026.09"], sourceRepository);
    const matches = found.matches.filter((record) => record.name === name); assert.equal(matches.length, 1); ids.push(matches[0].resource_id);
  }
  await cli(["materials", "materialize", "ecoli_k12", ...ids, "--snapshot", "public-reviewed-2026.09", "--out", relative(sourceRepository, join(workspace, "parts", "eligible.json")).replaceAll("\\", "/")], sourceRepository);
  await cli(["parts", "search", "BBa_", "--parts", "parts/eligible.json"]);
  const source = `# Governed records used only for software UI verification; no biological validation.\ndesign native_visualization_qa chassis ecoli_k12\nconstruct reporter:\n  topology circular\n  promoter ${ids[0]} instance=p1\n  rbs ${ids[1]} instance=r1\n  cds ${ids[2]} instance=c1\n  terminator ${ids[3]} instance=t1\n`;
  await writeFile(join(workspace, "designs", "native-qa.proto"), source);
  await cli(["--parts", "parts/eligible.json", "check", "designs/native-qa.proto", "--json"]);
  await cli(["--parts", "parts/eligible.json", "compile", "designs/native-qa.proto", "--out", "build/native-qa.ir.json"]);
  await cli(["--parts", "parts/eligible.json", "workflow", "run", "designs/native-qa.proto"]);
  await cli(["--parts", "parts/eligible.json", "review", "run", "designs/native-qa.proto"]);
  await copyFile(join(sourceRepository, "build", "protein-upgrade-qa", "phoa.ir.json"), join(workspace, "build", "phoa.ir.json"));
  if (args["--medium-export"] === "true") {
    const fixtureRoot = join(parent, "governed-export-fixture");
    const fixture = JSON.parse(await readFile(join(fixtureRoot, "fixture.json"), "utf8"));
    assert.equal(fixture.sequenceLength, 100000); assert.equal(fixture.partOccurrences + fixture.userAnnotations, 2000);
    const bytes = await readFile(fixture.irPath); assert.equal(hash(bytes), fixture.irSha256);
    await copyFile(fixture.irPath, join(workspace, "build", "governed-medium.ir.json"));
    await cp(fixtureRoot, join(workspace, "build", "governed-medium-provenance"), { recursive: true, errorOnExist: true, force: false });
    report.governedMediumFixture = fixture;
  }
  if (args["--performance"] === "true") {
    const fixture = join(parent, "performance-fixtures", "synthetic-100kbp-2000.ir.json");
    const destination = join(workspace, "build", "synthetic-100kbp-2000.ir.json");
    await copyFile(fixture, destination); await utimes(destination, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    report.syntheticFixture = { path: destination, sha256: hash(await readFile(destination)), label: "Explicitly synthetic IUPAC fixture; no governed resource or biological claim", length: 100000, features: 2000 };
  }
  const proteinReport = JSON.parse(await readFile(join(sourceRepository, "build", "protein-upgrade-qa", "phoa-live-structure-report.json"), "utf8"));
  const attachment = proteinReport.attachment;
  const directory = join(workspace, "build", "protein-structures", attachment.sequenceSha256); await mkdir(directory, { recursive: true });
  for (const suffix of ["cif", "json"]) await copyFile(join(sourceRepository, "build", "protein-structures", attachment.sequenceSha256, `${attachment.id}.${suffix}`), join(directory, `${attachment.id}.${suffix}`));
  report.proteinAttachment = attachment; report.dnaIds = ids;
  const database = new AppDatabase(join(profile, "proto-workbench.sqlite"));
  try { database.setSetting("workspacePath", workspace); } finally { database.close(); }
  report.initialSourceSha256 = hash(source);
  report.initialPartsSha256 = hash(await readFile(join(workspace, "parts", "eligible.json")));
  await writeFile(join(qaRoot, "qa-owner.json"), JSON.stringify({ schema: "proto-workbench.native-qa-owner.v1", pid: process.pid, preparedAt: new Date().toISOString(), appRoot, qaRoot }));
}

function minimalEnvironment() {
  const names = ["SystemRoot", "WINDIR", "SystemDrive", "ProgramFiles", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"];
  return Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}
async function check(name, operation) {
  stage = name; const started = Date.now(); console.log(JSON.stringify({ stage }));
  try { const details = await operation(); report.tests.push({ name, status: "passed", elapsedMs: Date.now() - started, details }); }
  catch (error) { report.tests.push({ name, status: "failed", error: error.message }); throw error; }
  await persist();
}
async function persist() { await writeFile(reportPath, JSON.stringify(report, null, 2)); }
async function screenshot(name, locator = page) {
  const path = join(evidence, `${name}.png`);
  // Chromium CDP's page screenshot clips a zoomed Electron surface at the wrong
  // device scale. Capture the actual owned webContents for whole-window evidence.
  if (locator === page) {
    const capture = await callMain('const window = electron.BrowserWindow.getAllWindows()[0]; const image = await window.webContents.capturePage(); return { png: image.toPNG().toString("base64"), size: image.getSize(), contentSize: window.getContentSize(), zoom: window.webContents.getZoomFactor(), display: electron.screen.getDisplayMatching(window.getBounds()).scaleFactor };');
    await writeFile(path, Buffer.from(capture.png, "base64"));
    report.nativeCaptureState = { ...capture, png: undefined, dom: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale })) };
  } else await locator.screenshot({ path });
  const bytes = await readFile(path); const metadata = await sharp(bytes).metadata();
  report.screenshots.push({ path, sha256: hash(bytes), width: metadata.width, height: metadata.height, ...(locator === page ? { nativeSurface: report.nativeCaptureState } : {}) }); return bytes;
}
async function settledFrames() { await page.evaluate(() => new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)))); }
async function waitIdle() { await settledFrames(); await page.locator(".protein-structure-loading").waitFor({ state: "hidden", timeout: 60_000 }); await settledFrames(); }
async function proteinGeometryPixels() {
  const canvas = page.locator(".protein-molecular-stage canvas");
  assert.equal(await canvas.count(), 1, "Exactly one current molecular canvas must remain attached.");
  const { data, info } = await sharp(await canvas.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let colored = 0, sampled = 0;
  for (let y = Math.floor(info.height * .15); y < info.height * .8; y += 3) for (let x = Math.floor(info.width * .15); x < info.width * .85; x += 3) {
    const offset = (y * info.width + x) * 4; const rgb = [data[offset], data[offset + 1], data[offset + 2]]; sampled += 1;
    if (Math.max(...rgb) - Math.min(...rgb) > 30 && Math.max(...rgb) > 70) colored += 1;
  }
  return { colored, sampled, ratio: colored / sampled, width: info.width, height: info.height };
}
async function fileTree(path) { const result = []; for (const item of await readdir(path, { withFileTypes: true })) { const next = join(path, item.name); if (item.isDirectory()) result.push(...await fileTree(next)); else result.push(next); } return result; }
async function figureRecords() {
  const files = await fileTree(join(workspace, "build", "protein-structures"));
  const items = [];
  for (const path of files.filter((path) => path.endsWith(".json"))) { const data = JSON.parse(await readFile(path, "utf8")); if (data.schema === "proto-workbench.protein-figure.v1") items.push({ path, data }); }
  return items;
}
async function captureProtein() {
  const before = (await figureRecords()).length;
  await page.getByRole("button", { name: "Capture figure", exact: true }).click();
  await waitUntil(async () => {
    const message = await page.locator(".protein-structure-message").textContent().catch(() => "");
    if (message?.startsWith("Figure and evidence saved:")) return true;
    if (message && !(await page.getByRole("button", { name: "Capture figure", exact: true }).isDisabled())) throw new Error(message);
    return false;
  }, 60_000);
  const records = await figureRecords(); assert.equal(records.length, before + 1);
  const latest = records.sort((a, b) => a.data.exportedAt.localeCompare(b.data.exportedAt)).at(-1);
  const bytes = await readFile(latest.path.replace(/\.json$/, ".png")); const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(hash(bytes), latest.data.pngSha256); assert.equal(decoded.info.width, 1920); assert.equal(decoded.info.height, 1080);
  return latest;
}
async function resize(width, height, zoom = 1) {
  await callMain(`const window = electron.BrowserWindow.getAllWindows()[0]; window.setContentSize(${width}, ${height}); window.webContents.setZoomFactor(${zoom}); return true;`);
  await page.waitForFunction(({ width, zoom }) => Math.abs(window.innerWidth - width / zoom) <= 2, { width, zoom });
  await settledFrames();
}

async function reviewLayout(domain, zoom) {
  for (const label of ["Toggle task sidebar", "Toggle inspector"]) {
    const control = page.getByRole("button", { name: label, exact: true });
    const open = await control.getAttribute("aria-pressed") === "true";
    if (open === (zoom === 2)) await control.click();
  }
  if (domain === "dna") {
    const composer = page.locator(".dna-composer-heading");
    if (await composer.getAttribute("aria-expanded") === "true") await composer.click();
  }
  const surface = domain === "protein" ? page.locator(".protein-molecular-stage") : page.locator(".map-engine-pane");
  await surface.scrollIntoViewIfNeeded(); await settledFrames();
  const geometry = await surface.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, visibleWidth: Math.max(0, Math.min(innerWidth, bounds.right) - Math.max(0, bounds.left)), visibleHeight: Math.max(0, Math.min(innerHeight, bounds.bottom) - Math.max(0, bounds.top)) };
  });
  assert(geometry.visibleWidth >= 260 && geometry.visibleHeight >= 120, `The actual ${domain} canvas must remain meaningfully visible.`);
  if (zoom === 2) {
    const control = domain === "protein" ? page.getByRole("button", { name: "Reset", exact: true }) : page.getByRole("button", { name: "PNG", exact: true });
    await control.scrollIntoViewIfNeeded();
    const reachable = await control.evaluate((element) => {
      const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, visible: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight, unobscured: hit === element || element.contains(hit) };
    });
    assert(reachable.visible && reachable.unobscured, `The ${domain} control must remain reachable at200%.`);
    geometry.reachableControl = reachable;
    if (domain === "protein") { await control.click(); await waitIdle(); }
    else {
      const directory = join(workspace, "build", "visualization-exports");
      const before = new Set((await fileTree(directory)).filter((path) => path.endsWith(".svg")));
      await page.getByRole("button", { name: "SVG", exact: true }).click();
      const path = await waitUntil(async () => (await fileTree(directory)).find((candidate) => candidate.endsWith(".svg") && !before.has(candidate)));
      await waitUntil(async () => (await page.getByRole("region", { name: "Latest map export verification" }).innerText()).includes(path.split(/[\\/]/).at(-1)));
      const svg = await readFile(path), text = svg.toString("utf8"), theme = await page.locator("html").getAttribute("data-theme");
      const previewPath = join(evidence, `04-dna-200pct-${theme}-export-reopened.png`);
      const decoded = await sharp(svg).png().toFile(previewPath);
      assert(decoded.width > 100 && decoded.height > 100);
      geometry.export200 = { path, sha256: hash(svg), previewPath, width: decoded.width, height: decoded.height,
        rulerLabels: [...text.matchAll(/<text\b[^>]*>([^<]*(?:kbp| bp)[^<]*)<\/text>/g)].map((match) => match[1]) };
    }
    await surface.scrollIntoViewIfNeeded(); await settledFrames();
  }
  return geometry;
}

async function captureTracks(mapped) {
  const artifactPath = join(workspace, "build", "phoa.ir.json");
  const artifactHash = hash(await readFile(artifactPath));
  const receipts = [];
  for (const format of ["svg", "png"]) {
    await page.getByRole("button", { name: `Export tracks ${format.toUpperCase()}`, exact: true }).click();
    const status = page.getByRole("status", { name: "Protein track export verification" });
    await status.getByText(`${format.toUpperCase()} independently reopened`, { exact: true }).waitFor({ timeout: 60_000 });
    const relativePath = await status.locator("code").innerText();
    const absolutePath = join(workspace, relativePath);
    const bytes = await readFile(absolutePath);
    const stem = absolutePath.replace(/\.(svg|png)$/, "");
    const metadata = JSON.parse(await readFile(`${stem}.metadata.json`, "utf8"));
    const receipt = JSON.parse(await readFile(`${stem}.verification.json`, "utf8"));
    const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 1600); assert.equal(decoded.info.height, 620);
    assert.equal(hash(bytes), receipt.sha256); assert.equal(metadata.artifactSha256, artifactHash);
    assert.equal(metadata.rows[2].available, mapped); assert.equal(metadata.rows[3].available, false);
    if (mapped) { assert.equal(metadata.structure.mappingStatus, "explicit-partial"); assert.equal(metadata.structure.observedResidues, 449); }
    else assert.equal(metadata.structure, null);
    assert.equal(hash(await readFile(artifactPath)), artifactHash);
    receipts.push({ format, relativePath, sha256: receipt.sha256, sourceSha256: artifactHash, metadata });
  }
  await screenshot(`protein-tracks-${mapped ? "mapped" : "sequence-only"}`, page.locator(".protein-sequence-tracks"));
  return receipts;
}

async function waitUntil(operation, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await operation(); if (result) return result; await new Promise((resolvePromise) => setTimeout(resolvePromise, 200)); }
  throw new Error(`Owned native operation exceeded ${timeoutMs} milliseconds.`);
}

async function connectInspector(endpoint) {
  assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/i);
  const socket = new WebSocket(endpoint); let id = 0; const pending = new Map();
  await new Promise((resolvePromise, reject) => { socket.addEventListener("open", resolvePromise, { once: true }); socket.addEventListener("error", reject, { once: true }); setTimeout(() => reject(new Error("Owned main inspector connection timed out.")), 10_000).unref(); });
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); } });
  return { close: () => socket.close(), evaluate: (expression) => new Promise((resolvePromise, reject) => { const requestId = ++id; const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Owned main inspector evaluation timed out.")); }, 10_000); pending.set(requestId, { resolve: resolvePromise, reject, timer }); socket.send(JSON.stringify({ id: requestId, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }) };
}

async function callMain(body) {
  const result = await mainInspector.evaluate(`(async () => { const electron = process.getBuiltinModule("module").createRequire(process.cwd() + "/package.json")("electron"); ${body} })()`);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function launchOwned() {
  launchIndex += 1;
  const suffix = launchIndex === 1 ? "" : `-${launchIndex}`;
  const helper = join(sourceApp, "scripts", "owned-scientific-electron.ps1");
  launcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-AppRoot", appRoot, "-QaRoot", qaRoot, "-LaunchIndex", String(launchIndex), ...(continuationId && appRoot !== report.originalEvidence.appRoot ? ["-ContinueSnapshot"] : []), "-MaximumSeconds", args["--harness"] === "true" ? "1200" : "600", ...(args["--harness"] === "true" ? ["-OwnedModelMission"] : [])], { cwd: sourceRepository, shell: false, windowsHide: true, env: minimalEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
  report.launcherPid = launcher.pid; report.launcherStdout = ""; report.launcherStderr = "";
  report.launchLogs = { stdout: join(qaRoot, `electron${suffix}.stdout.log`), stderr: join(qaRoot, `electron${suffix}.stderr.log`), receipt: join(qaRoot, `owned-launch${suffix}.json`), stop: join(qaRoot, `stop-owned-app${suffix}`) };
  launcher.stdout.on("data", (data) => { report.launcherStdout += data; }); launcher.stderr.on("data", (data) => { report.launcherStderr += data; });
  launcher.on("error", (error) => { report.launcherError = error.message; });
  await persist();
  const endpoints = await waitUntil(async () => {
    if (launcher.exitCode !== null || report.launcherError) throw new Error(`Owned launcher failed: ${report.launcherError ?? report.launcherStderr}`);
    const log = await readFile(report.launchLogs.stderr, "utf8").catch(() => "");
    const browserEndpoint = log.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/i)?.[1];
    const inspectorEndpoint = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/i)?.[1];
    return browserEndpoint && inspectorEndpoint ? { browserEndpoint, inspectorEndpoint } : undefined;
  });
  report.debugEndpoints = endpoints;
  const receipt = await readFile(report.launchLogs.receipt, "utf8"); report.ownedPid = JSON.parse(receipt.replace(/^\uFEFF/, "")).pid; await persist();
  mainInspector = await connectInspector(endpoints.inspectorEndpoint);
  browser = await chromium.connectOverCDP(endpoints.browserEndpoint, { timeout: 20_000 });
  page = await waitUntil(async () => browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("file:")), 20_000);
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
}

async function stopOwned() {
  if (!launcher) return;
  mainInspector?.close(); mainInspector = undefined;
  await browser?.close().catch(() => undefined); browser = undefined;
  await writeFile(report.launchLogs.stop, new Date().toISOString());
  await waitUntil(async () => launcher.exitCode !== null || launcher.signalCode !== null, args["--harness"] === "true" ? 60_000 : 25_000).catch((error) => { report.cleanupError = error.message; });
  report.launcherExited = launcher.exitCode !== null || launcher.signalCode !== null;
  report.launchReceipt = await readFile(report.launchLogs.receipt, "utf8").then((data) => JSON.parse(data.replace(/^\uFEFF/, ""))).catch(() => null);
  report.ownedProcessExited = report.launchReceipt?.processExited === true;
  const failures = [];
  if (!report.launcherExited) failures.push("Owned launcher did not exit.");
  if (!report.ownedProcessExited) failures.push("Owned Electron parent did not exit.");
  if (report.launchReceipt?.error) failures.push(`Owned launcher reported an error: ${report.launchReceipt.error}`);
  if (!Array.isArray(report.launchReceipt?.remainingOwnedChildren)) failures.push("Final owned-child audit is missing.");
  if (report.launchReceipt?.remainingOwnedChildren?.length) failures.push("Verified owned child processes remain.");
  if (report.cleanupError) failures.push(report.cleanupError);
  report.cleanupGate = { passed: failures.length === 0, failures, remainingOwnedChildren: report.launchReceipt?.remainingOwnedChildren ?? null, rejectedUnownedDescendants: report.launchReceipt?.rejectedDescendants?.length ?? 0 };
  (report.launchHistory ??= []).push({ launchIndex, launcherPid: report.launcherPid, logs: report.launchLogs, receipt: report.launchReceipt, cleanupGate: report.cleanupGate });
  launcher = undefined;
  if (failures.length) { report.ok = false; report.failedStage ??= "owned process cleanup"; process.exitCode = 1; }
  await persist();
}

async function restartOwnedApplication({ requireCooperativeClose = false } = {}) {
  const previousPid = report.ownedPid;
  await stopOwned();
  assert(report.cleanupGate.passed, "Restart must not proceed while previous owned processes remain.");
  if (requireCooperativeClose) {
    assert(!report.launchReceipt.cleanupActions.some((action) => action.action === "kill-held-owned-process-only"), "Active restart proof requires cooperative application shutdown; fallback process termination is only cleanup.");
    assert.equal(report.launchReceipt.exitCode, 0, "Active restart requires clean application shutdown.");
  }
  await launchOwned();
  const actual = await callMain('return { userData: electron.app.getPath("userData"), pid: process.pid };');
  assert.equal(resolve(actual.userData), profile);
  assert.notEqual(actual.pid, previousPid, "Restart must create a different actual Electron process.");
  await page.getByText("Proto Workbench", { exact: true }).first().waitFor();
  const settings = await page.evaluate(() => window.workbench.app.getSettings());
  assert.equal(resolve(settings.workspacePath), workspace);
  await resize(1920, 1080);
  return page;
}

try {
  await prepare();
  if (args["--prepare-only"] === "true") { report.prepared = true; await persist(); console.log(JSON.stringify({ prepared: qaRoot })); }
  else {
    stage = "launch";
    for (const path of [qaRoot, workspace, profile]) assert.equal(await realpath(path), path);
    assert((await lstat(executable)).isFile());
    await launchOwned();
    await check("isolated native startup", async () => {
      const actual = await callMain('return { userData: electron.app.getPath("userData"), packaged: electron.app.isPackaged, version: process.versions.electron };');
      assert.equal(resolve(actual.userData), profile); assert.equal(actual.packaged, false);
      await page.getByText("Proto Workbench", { exact: true }).first().waitFor();
      const settings = await page.evaluate(() => window.workbench.app.getSettings());
      assert.equal(resolve(settings.workspacePath), workspace, "Actual startup workspace must stay inside this owned QA session.");
      actual.workspacePath = settings.workspacePath;
      const inventoryStarted = performance.now();
      await page.getByRole("button", { name: "Designs", exact: true }).click();
      await page.locator(".design-document").first().waitFor({ state: "attached" });
      report.inventoryLoadMs = performance.now() - inventoryStarted;
      for (const label of ["Toggle task sidebar", "Toggle inspector"]) {
        const toggle = page.getByRole("button", { name: label, exact: true });
        if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
      }
      await page.locator(".design-document").first().waitFor();
      await resize(1920, 1080);
      await screenshot("01-native-startup"); return actual;
    });
    if (continuationId) {
      const before = report.harnessNative;
      if (args["--resume-paused"] === "true") {
        report.testScope = "Actual paused-mission restart and explicit owned model reload/resume; prior call receipts and committed source must not replay";
        const { runScientificNativeHarness } = await import("./scientific-native-harness.mjs");
        await runScientificNativeHarness({ page, report, check, screenshot, waitUntil, workspace, profile, evidence, fileTree, activeRestart: true, resumePaused: true, skipGraphPointer: args["--skip-graph-pointer"] === "true", restartOwnedApplication });
      } else {
      await check("real completed mission persisted across app exit and newer-snapshot startup", async () => {
        const current = (await page.evaluate(() => window.workbench.harness.listExecutions())).find((item) => item.runId === before.finalProjection.runId);
        assert.equal(current.state, "completed"); assert.equal(current.resultCount, before.finalProjection.resultCount);
        const events = await page.evaluate((id) => window.workbench.runs.get(id), current.runId);
        // IPC retains explicit undefined properties; JSON reports omit them.
        // Compare the same durable JSON representation without dropping any
        // serializable event value.
        assert.deepEqual(JSON.parse(JSON.stringify(events)), before.events);
        await page.locator(".recent-run").first().click();
        await screenshot("reopen-01-original-completed-mission");
        return { current, eventsUnchanged: true, previousReportSha256: report.originalEvidence.sha256, actualNewProcess: report.ownedPid };
      });
      const { runScientificNativeHarness } = await import("./scientific-native-harness.mjs");
      await runScientificNativeHarness({ page, report, check, screenshot, waitUntil, workspace, profile, evidence, fileTree, inspectOnly: true });
      }
      assert.equal(hash(await readFile(report.originalEvidence.path)), report.originalEvidence.sha256, "Original failed UI evidence must remain unchanged.");
    } else if (args["--harness"] === "true") {
      report.testScope = "Exactly one real native Qwen mission with observed tool dependencies, new DNA artifact and native export";
      const { runScientificNativeHarness } = await import("./scientific-native-harness.mjs");
      await runScientificNativeHarness({ page, report, check, screenshot, waitUntil, workspace, profile, evidence, fileTree, activeRestart: args["--active-restart"] === "true", skipGraphPointer: args["--skip-graph-pointer"] === "true", restartOwnedApplication });
      await check("completed mission survives actual native application restart", async () => {
        const before = report.harnessNative.finalProjection;
        const eventsBefore = await page.evaluate((id) => window.workbench.runs.get(id), before.runId);
        const artifactBefore = hash(await readFile(join(workspace, "build", "native-harness.ir.json")));
        await restartOwnedApplication();
        const after = await waitUntil(async () => (await page.evaluate(() => window.workbench.harness.listExecutions())).find((item) => item.runId === before.runId));
        assert.equal(after.state, "completed"); assert.equal(after.resultCount, before.resultCount);
        assert.equal(hash(await readFile(join(workspace, "build", "native-harness.ir.json"))), artifactBefore);
        const eventsAfter = await page.evaluate((id) => window.workbench.runs.get(id), before.runId);
        assert.deepEqual(eventsAfter, eventsBefore, "Completed-run evidence must survive reopening without new effects.");
        await page.locator(".recent-run").first().click();
        await page.getByRole("tab", { name: "Topology", exact: true }).click();
        await page.locator(".run-dependency-graph").waitFor();
        await screenshot("harness-08-completed-mission-after-restart");
        const catalogue = await page.evaluate(() => window.workbench.models.list());
        assert(catalogue.every((model) => !model.workbenchInstance?.ownedByWorkbench && !model.loadedInstances?.length), "Durability reopen must not load a model.");
        return { before, after, artifactSha256: artifactBefore, eventsUnchanged: true, newElectronPid: report.ownedPid, scope: "Completed mission persistence after actual app exit and restart; active resume is a separate case." };
      });
    } else if (args["--medium-diagnostic"] === "true") {
      const { runScientificNativeMapDiagnostic } = await import("./scientific-native-map-diagnostic.mjs");
      await runScientificNativeMapDiagnostic({ page, report, check, screenshot, waitUntil, workspace, evidence, callMain });
    } else if (args["--medium-export"] === "true") {
      const { runScientificNativeMediumExport } = await import("./scientific-native-medium-export.mjs");
      await runScientificNativeMediumExport({ page, report, check, screenshot, waitUntil, workspace, fileTree });
    } else if (args["--performance"] === "true") {
      const { runScientificNativePerformance } = await import("./scientific-native-performance.mjs");
      await runScientificNativePerformance({ page, report, check, screenshot, waitUntil, workspace, fileTree, fixtureRoot: join(parent, "performance-fixtures"), proteinGeometryPixels });
    } else {
    if (args["--protein-only"] !== "true") {
    await check("DNA feature selection and governed export", async () => {
      await page.locator(".design-document").filter({ hasText: "native_visualization_qa" }).first().click();
      await page.getByRole("button", { name: /^Select p1, promoter/ }).click();
      assert.match(await page.locator(".selection-card").innerText(), /promoter/i);
      for (const format of ["SVG", "PNG"]) {
        await page.getByRole("button", { name: new RegExp(`^${format}$`) }).click();
        await page.getByRole("region", { name: "Latest map export verification" }).waitFor({ timeout: 60_000 });
        assert.match(await page.getByRole("region", { name: "Latest map export verification" }).innerText(), /Independently reopened/i);
      }
      await screenshot("02-dna-map");
      const files = await fileTree(join(workspace, "build"));
      const exports = files.filter((path) => /\.(svg|png)$/.test(path)); assert(exports.some((path) => path.endsWith(".svg"))); assert(exports.some((path) => path.endsWith(".png")));
      for (const path of exports) { const image = await sharp(await readFile(path)).metadata(); assert(image.width > 0 && image.height > 0); }
      return { reopened: exports };
    });
    await check("DNA source edit preview check compile and refresh", async () => {
      await page.getByRole("button", { name: /DNA composer/ }).click();
      await page.getByText("Source and materialized library match this artifact. Changes are staged for review.").waitFor();
      await page.getByRole("button", { name: "Reverse placement of c1", exact: true }).click();
      await page.getByRole("button", { name: /Preview 1 edits/ }).click();
      await page.getByText("Candidate checks passed. Review the exact source diff, then apply.").waitFor({ timeout: 60_000 });
      assert.match(await page.getByLabel("DNA source diff").innerText(), /orientation=reverse/);
      await screenshot("03-dna-reviewed-diff");
      await page.getByRole("button", { name: "Apply reviewed source edit", exact: true }).click();
      await waitUntil(async () => /instance=c1 orientation=reverse/.test(await readFile(join(workspace, "designs", "native-qa.proto"), "utf8")), 60_000);
      await page.getByRole("button", { name: "Apply reviewed source edit", exact: true }).waitFor({ state: "hidden", timeout: 60_000 });
      const source = await readFile(join(workspace, "designs", "native-qa.proto"), "utf8"); assert.match(source, /instance=c1 orientation=reverse/);
      assert.equal(hash(await readFile(join(workspace, "parts", "eligible.json"))), report.initialPartsSha256);
      await cli(["--parts", "parts/eligible.json", "check", "designs/native-qa.proto", "--json"]);
      const compiled = (await fileTree(join(workspace, "build"))).filter((path) => path.endsWith(".ir.json"));
      const changed = [];
      for (const path of compiled) { const data = JSON.parse(await readFile(path, "utf8")); if (data.domain === "dna" && data.constructs.some((construct) => construct.parts.some((part) => part.instance_id === "c1" && part.placement?.orientation === "reverse"))) changed.push(path); }
      assert(changed.length > 0, "UI commit must actually compile the reversed placement.");
      await screenshot("04-dna-refreshed"); return { sourceSha256: hash(source), changedArtifacts: changed };
    });
    if (args["--require-history"] === "true") await check("DNA committed undo and redo preserve the materials library", async () => {
      const path = join(workspace, "designs", "native-qa.proto");
      const assertActiveRevision = async (source, orientation) => {
        const sourceSha256 = hash(source), candidates = [];
        for (const artifact of (await fileTree(join(workspace, "build"))).filter(item => item.endsWith(".ir.json"))) {
          const bytes = await readFile(artifact), ir = JSON.parse(bytes);
          if (ir.domain !== "dna" || ir.provenance?.source_sha256 !== sourceSha256 || ir.provenance?.parts_sha256 !== report.initialPartsSha256) continue;
          if (!ir.constructs.some(construct => construct.name === "reporter" && construct.parts.some(part => part.instance_id === "c1" && part.placement?.orientation === orientation))) continue;
          candidates.push({ path: artifact, sha256: hash(bytes) });
        }
        assert(candidates.length > 0, "An exact source/library/placement-bound compiled artifact is required.");
        const selected = await waitUntil(async () => {
          const visibleSha = await page.locator(".design-source-card code[title]").getAttribute("title").catch(() => undefined);
          return candidates.find(candidate => candidate.sha256 === visibleSha);
        }, 60_000);
        return { sourceSha256, orientation, selected, aliases: candidates.filter(candidate => candidate.sha256 === selected.sha256) };
      };
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await waitUntil(async () => !(await readFile(path, "utf8")).includes("orientation=reverse"), 60_000);
      await waitUntil(async () => !(await page.getByRole("button", { name: "Redo", exact: true }).isDisabled()), 60_000);
      const undoneSource = await readFile(path, "utf8");
      assert.equal(hash(undoneSource.replaceAll(" orientation=forward", "")), report.initialSourceSha256, "Undo must restore the source semantics; an explicitly serialized forward default is equivalent.");
      await cli(["--parts", "parts/eligible.json", "check", "designs/native-qa.proto", "--json"]);
      const undoActiveRevision = await assertActiveRevision(undoneSource, "forward");
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      await waitUntil(async () => (await readFile(path, "utf8")).includes("instance=c1 orientation=reverse"), 60_000);
      await waitUntil(async () => !(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()), 60_000);
      await cli(["--parts", "parts/eligible.json", "check", "designs/native-qa.proto", "--json"]);
      const redoActiveRevision = await assertActiveRevision(await readFile(path, "utf8"), "reverse");
      assert.equal(hash(await readFile(join(workspace, "parts", "eligible.json"))), report.initialPartsSha256);
      await screenshot("04-dna-committed-redo");
      return { sourceSha256: hash(await readFile(path)), undoSourceSha256: hash(undoneSource), initialSourceSha256: report.initialSourceSha256,
        undoEquivalence: "Original source restored with the implicit forward orientation serialized explicitly", partsSha256: report.initialPartsSha256, undoActiveRevision, redoActiveRevision };
    });
    await check("DNA native layouts themes and pane controls", async () => {
      const states = [];
      for (const size of [[1280, 800, 1], [1920, 1080, 1], [2560, 1440, 1], [1920, 1080, 2]]) {
        await resize(...size);
        for (const theme of ["light", "dark"]) {
          if (await page.locator("html").getAttribute("data-theme") !== theme) await page.getByRole("button", { name: `Use ${theme} theme`, exact: true }).click();
          const visibleCanvas = await reviewLayout("dna", size[2]);
          await screenshot(`04-dna-${size[0]}x${size[1]}-${size[2] * 100}pct-${theme}`);
          const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
          assert(dimensions.scrollWidth <= dimensions.width + 2); states.push({ size, theme, dimensions, visibleCanvas });
        }
      }
      await resize(1920, 1080);
      for (const label of ["Toggle task sidebar", "Toggle inspector"]) {
        const button = page.getByRole("button", { name: label, exact: true }); const before = await button.getAttribute("aria-pressed");
        await button.click(); assert.notEqual(await button.getAttribute("aria-pressed"), before); await button.click(); assert.equal(await button.getAttribute("aria-pressed"), before);
      }
      const separator = page.getByRole("separator", { name: "Resize map and sequence panes" });
      await separator.focus(); await separator.press("Home"); assert.equal(await separator.getAttribute("aria-valuenow"), "25");
      await separator.press("End"); assert.equal(await separator.getAttribute("aria-valuenow"), "75");
      await separator.press("ArrowLeft"); assert.equal(await separator.getAttribute("aria-valuenow"), "70");
      return states;
    });
    }
    await check("source-only protein landscape SVG and PNG independently reopen", async () => {
      const sidebar = page.getByRole("button", { name: "Toggle task sidebar", exact: true });
      if (await sidebar.getAttribute("aria-pressed") !== "true") await sidebar.click();
      await page.locator(".design-document").filter({ hasText: "protein-observatory-phoa" }).click();
      await page.getByRole("heading", { name: "Molecular canvas" }).waitFor();
      assert.equal(await page.locator(".protein-molecular-stage canvas").count(), 0);
      return captureTracks(false);
    });
    await check("real protein coordinates and explicit residue mapping", async () => {
      await page.locator(".design-document").filter({ hasText: "protein-observatory-phoa" }).click();
      await page.getByRole("heading", { name: "Molecular canvas" }).waitFor();
      await page.getByLabel("Saved attachments").selectOption(report.proteinAttachment.id);
      await waitIdle();
      assert.equal(await page.locator(".protein-structure-fallback").count(), 0);
      await page.getByLabel(/^Chain/).selectOption("0:A"); await waitIdle();
      await page.getByLabel("Position this chain fragment at protein residue").fill("23");
      await page.getByRole("button", { name: "Verify explicit mapping", exact: true }).click();
      await page.getByText("95% observed coverage", { exact: true }).waitFor();
      await screenshot("05-protein-real-structure");
      const canvas = page.locator(".protein-molecular-stage canvas");
      assert((await canvas.boundingBox()).width > 100);
      return { source: report.proteinAttachment.source, observedResidues: 449, proteinRange: [23, 471] };
    });
    await check("mapped protein landscape SVG and PNG preserve coordinate and residue provenance", async () => captureTracks(true));
    await check("protein coordinate representations and colors", async () => {
      const views = [];
      for (const display of ["ball-and-stick", "molecular-surface", "cartoon"]) {
        await page.getByLabel(/^Display/).selectOption(display);
        await waitUntil(async () => !(await page.getByLabel(/^Display/).isDisabled()), 60_000);
        await waitIdle();
        // Track export screenshots may have scrolled this viewport offscreen.
        // Bring it back before waiting for actual new representation pixels;
        // a settled React control does not prove a presented WebGL frame.
        await page.locator(".protein-molecular-stage canvas").scrollIntoViewIfNeeded();
        const geometry = await waitUntil(async () => { const sample = await proteinGeometryPixels(); return sample.ratio > .005 ? sample : undefined; }, 15_000);
        const bytes = await screenshot(`05-protein-${display}`, page.locator(".protein-molecular-stage"));
        views.push({ display, sha256: hash(bytes), geometry });
      }
      assert.equal(new Set(views.map((item) => item.sha256)).size, 3);
      return views;
    });
    await check("protein selection in both directions", async () => {
      const canvas = page.locator(".protein-molecular-stage canvas");
      await page.getByRole("button", { name: /^T, residue 23(?:,|$)/ }).click();
      await page.getByRole("button", { name: "Focus selection", exact: true }).click();
      assert.match(await page.locator(".protein-range-status").innerText(), /23–23/);
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await page.getByRole("button", { name: /^M, residue 1(?:,|$)/ }).click();
      assert(await page.getByRole("button", { name: "Focus selection", exact: true }).isDisabled(), "Unobserved residue 1 must not focus an inferred structure position.");
      await canvas.scrollIntoViewIfNeeded();
      const png = await canvas.screenshot();
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const picks = [];
      for (let y = 35; y < info.height - 45; y += 5) for (let x = 35; x < info.width - 35; x += 5) {
        const i = (y * info.width + x) * 4; const rgb = [data[i], data[i + 1], data[i + 2]];
        if (Math.max(...rgb) - Math.min(...rgb) > 30 && Math.max(...rgb) > 100) picks.push({ x, y, distance: Math.hypot(x - info.width / 2, y - info.height / 2) });
      }
      picks.sort((a, b) => a.distance - b.distance); assert(picks.length > 0, "Native canvas must contain colored protein geometry.");
      let selected;
      for (const point of picks.slice(0, 12)) {
        const box = await canvas.boundingBox(); await page.mouse.click(box.x + point.x * box.width / info.width, box.y + point.y * box.height / info.height); await page.waitForTimeout(80);
        const text = await page.locator(".protein-range-status").innerText(); if (!text.includes("1–1 (1 aa)")) { selected = text; break; }
      }
      assert(selected, "Clicking actual protein geometry must select its mapped sequence residue.");
      await screenshot("06-protein-linked-selection"); return { selected };
    });
    if (args["--skip-figure"] !== "true") await check("protein camera save rotate restore and independent PNG reopen", async () => {
      await page.getByRole("button", { name: "Save view", exact: true }).click();
      await page.getByText(/View saved with camera/).waitFor();
      const savedFiles = await readdir(join(workspace, "build", "protein-structures", "views")); assert.equal(savedFiles.length, 1);
      const saved = JSON.parse(await readFile(join(workspace, "build", "protein-structures", "views", savedFiles[0]), "utf8"));
      const canvas = page.locator(".protein-molecular-stage canvas"); await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * .45, box.y + box.height * .5); await page.mouse.down(); await page.mouse.move(box.x + box.width * .65, box.y + box.height * .6, { steps: 15 }); await page.mouse.up();
      await page.getByLabel(/^Color/).selectOption("residue"); await waitIdle();
      const rotated = await captureProtein(); assert.notDeepEqual(rotated.data.view.camera.position, saved.view.camera.position);
      await page.getByRole("button", { name: "Restore view", exact: true }).click(); await waitIdle();
      const restored = await captureProtein();
      assert.equal(await page.getByLabel(/^Color/).inputValue(), saved.view.color);
      for (const key of ["position", "target", "up"]) for (let i = 0; i < 3; i++) assert(Math.abs(restored.data.view.camera[key][i] - saved.view.camera[key][i]) < .001, `Camera ${key} failed to restore.`);
      await screenshot("07-protein-restored"); return { rotated: rotated.path, restored: restored.path };
    });
    else report.exclusions = ["Protein figure export and camera restore excluded from this diagnostic pass."];
    await check("native viewport sizes themes and 200 percent zoom", async () => {
      const states = [];
      await page.getByRole("button", { name: "Reset", exact: true }).click(); await waitIdle();
      for (const size of [[1280, 800, 1], [1920, 1080, 1], [2560, 1440, 1], [1920, 1080, 2]]) {
        await resize(...size);
        for (const theme of ["light", "dark"]) {
          const current = await page.locator("html").getAttribute("data-theme"); if (current !== theme) await page.getByRole("button", { name: `Use ${theme} theme`, exact: true }).click();
          const visibleCanvas = await reviewLayout("protein", size[2]);
          await screenshot(`08-protein-${size[0]}x${size[1]}-${size[2] * 100}pct-${theme}`);
          const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, canvas: document.querySelector(".protein-molecular-stage canvas")?.getBoundingClientRect().toJSON() }));
          assert(dimensions.scrollWidth <= dimensions.width + 2, "Unexpected horizontal viewport overflow."); states.push({ size, theme, dimensions, visibleCanvas });
        }
      }
      return states;
    });
    await check("WebGL context loss gives recoverable sequence fallback", async () => {
      await resize(1920, 1080); const canvas = page.locator(".protein-molecular-stage canvas");
      const originalCanvas = await canvas.elementHandle();
      const available = await canvas.evaluate((element) => { const context = element.getContext("webgl2") ?? element.getContext("webgl"); const extension = context?.getExtension("WEBGL_lose_context"); if (!extension) return false; extension.loseContext(); return true; });
      assert(available, "WEBGL_lose_context unavailable; actual context loss cannot be verified on this GPU.");
      await page.getByText("Structure view unavailable", { exact: true }).waitFor();
      await page.getByRole("button", { name: /^T, residue 23(?:,|$)/ }).click(); assert.match(await page.locator(".protein-range-status").innerText(), /23–23/);
      await screenshot("09-protein-context-lost");
      await page.getByRole("button", { name: "Reload structure", exact: true }).click(); await waitIdle();
      await waitUntil(async () => !(await page.getByLabel(/^Chain/).isDisabled()), 60_000);
      assert.equal(await originalCanvas.evaluate((element) => element.isConnected), false, "Reload must create a new canvas after permanent context loss.");
      assert.equal(await page.locator(".protein-structure-fallback").count(), 0);
      const geometry = await waitUntil(async () => { const sample = await proteinGeometryPixels(); return sample.ratio > .005 ? sample : undefined; }, 8000);
      await screenshot("10-protein-context-reloaded"); return { newCanvas: true, visibleGeometry: geometry };
    });
    }
    await check("native renderer error log is clean", async () => { assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); return { pageErrors: 0, consoleErrors: 0 }; });
    report.completedAt = new Date().toISOString(); report.ok = true;
  }
} catch (error) {
  report.ok = false; report.failedStage = stage; report.error = error.stack ?? error.message;
  if (page) { await writeFile(join(evidence, "failure-body.txt"), await page.locator("body").innerText().catch(() => "unavailable")); await screenshot("failure").catch(() => undefined); }
  console.error(JSON.stringify({ stage, error: error.message })); process.exitCode = 1;
} finally {
  await stopOwned();
  await persist(); console.log(JSON.stringify({ ok: report.ok, report: reportPath }));
}
