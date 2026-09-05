// Bounded native candidate smoke. Never changes Electron fuses or loads a model.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(appRoot, "..", "..");
const boundary = join(repository, "build", "upgrade-20260904", "native-qa");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fileSha(path) { const result=createHash("sha256"); for await(const bytes of createReadStream(path))result.update(bytes); return result.digest("hex"); }
function contained(root, path) { const part=relative(root,path); return Boolean(part)&&!part.startsWith("..")&&!isAbsolute(part); }
async function waitUntil(probe, milliseconds=30_000) { const deadline=Date.now()+milliseconds; while(Date.now()<deadline){const value=await probe();if(value)return value;await new Promise(resolve=>setTimeout(resolve,150));}throw new Error("Packaged native check exceeded its bounded wait."); }
async function ephemeralPort() { const server=createServer();await new Promise((ok,no)=>{server.once("error",no);server.listen(0,"127.0.0.1",ok);});const port=server.address().port;await new Promise(ok=>server.close(ok));return port; }

export function candidateLaunchBinding(candidate, kind) {
  assert.equal(candidate.schemaVersion,"proto-workbench.release-candidate.v2");
  assert(["portable","installer-payload"].includes(kind));
  const distribution=candidate.distributionEvidence.distributions.find(item=>item.kind===(kind==="portable"?"portable":"installer"));
  assert.equal(distribution?.payloadStatus,"verified-exact-unpacked-bytes");
  const payload=candidate.distributionEvidence.unpackedPayload.executableArtifacts.find(item=>item.path==="Proto Workbench.exe");
  assert.match(payload?.sha256??"",/^[a-f0-9]{64}$/);
  const executablePath=kind==="portable"?candidate.smoke.portableExecutable:join(distribution.payloadRoot,"Proto Workbench.exe");
  assert(isAbsolute(executablePath)&&isAbsolute(distribution.payloadRoot));
  if(kind==="portable")assert.equal(resolve(executablePath),resolve(distribution.artifact.path),"Portable smoke must launch the exact verified wrapper, not an extracted payload.");
  const executableSha256=kind==="portable"?candidate.releaseSnapshot.executableArtifacts.find(item=>item.path===basename(executablePath))?.sha256:payload.sha256;
  assert.match(executableSha256??"",/^[a-f0-9]{64}$/);
  assert.match(candidate.packageEvidence.asarSha256,/^[a-f0-9]{64}$/);
  return { executablePath,executableSha256,expectedPayloadSha256:payload.sha256,expectedAsarSha256:candidate.packageEvidence.asarSha256,expectedManifestSha256:candidate.packageEvidence.manifestSha256,payloadRoot:distribution.payloadRoot };
}

export async function runPackagedScientific(argv=process.argv.slice(2)) {
  const args=Object.fromEntries(argv.map(value=>value.split(/=(.*)/s).slice(0,2)));
  assert(args["--candidate-report"]&&args["--fixture-workspace"]&&args["--kind"]);
  const candidateReportPath=await realpath(args["--candidate-report"]),kind=args["--kind"];
  assert(contained(join(appRoot,"build"),candidateReportPath),"Candidate report must be a retained controlled Workbench build artifact.");
  const candidateBytes=await readFile(candidateReportPath),candidate=JSON.parse(candidateBytes.toString("utf8").replace(/^\uFEFF/,""));
  const launch=candidateLaunchBinding(candidate,kind);
  const fixture=await realpath(args["--fixture-workspace"]);assert(contained(boundary,fixture));
  const sessionRoot=join(boundary,`packaged-${kind}-${randomUUID().slice(0,8)}`),profile=join(sessionRoot,"profile"),workspace=join(sessionRoot,"workspace"),evidence=join(sessionRoot,"evidence"),tempRoot=join(sessionRoot,"portable-temp");
  await mkdir(sessionRoot); for(const directory of [profile,workspace,evidence,tempRoot])await mkdir(directory);
  for(const directory of ["designs","parts","build","literature"])await mkdir(join(workspace,directory));
  for(const directory of ["workflows","connectors",".codex/skills"])await cp(join(fixture,directory),join(workspace,directory),{recursive:true,errorOnExist:true,force:false});
  for(const path of ["designs/native-qa.proto","parts/eligible.json","parts/ecoli_k12_library.json","build/phoa.ir.json","literature/seed_sources.json"])await copyFile(join(fixture,path),join(workspace,path));
  const fixturePreparation={scope:"Controlled host Python prepares governed input fixtures before the untouched packaged executable starts; packaged sidecar is verified separately without an override.",python:join(repository,".venv","Scripts","python.exe"),commands:[]};
  fixturePreparation.pythonSha256=await fileSha(fixturePreparation.python);
  fixturePreparation.literatureSeed={sourcePath:join(fixture,"literature/seed_sources.json"),path:join(workspace,"literature/seed_sources.json"),sha256:await fileSha(join(fixture,"literature/seed_sources.json"))};
  assert.equal(await fileSha(fixturePreparation.literatureSeed.path),fixturePreparation.literatureSeed.sha256);
  const fixtureCli=async parameters=>{
    const result=await new Promise((resolveResult,reject)=>{
      const env={};for(const key of ["SystemRoot","WINDIR","SystemDrive","PATH","PATHEXT","TEMP","TMP","LOCALAPPDATA","APPDATA","USERPROFILE"])if(process.env[key])env[key]=process.env[key];
      env.PYTHONPATH=join(repository,"src");env.PROTO_AGENT_MATERIALS_ROOT=resolve(repository,"..","Proto CLI Materials");
      const child=spawn(fixturePreparation.python,["-B","-m","proto_agent.cli","--parts","parts/eligible.json",...parameters],{cwd:workspace,env,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
      const timer=setTimeout(()=>child.kill(),60_000);child.stdout.on("data",bytes=>{stdout+=bytes;if(stdout.length>4_000_000)child.kill();});child.stderr.on("data",bytes=>{stderr+=bytes;if(stderr.length>65_536)child.kill();});
      child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("close",code=>{clearTimeout(timer);resolveResult({parameters,code,stdout,stderr});});
    });fixturePreparation.commands.push(result);await writeFile(join(evidence,"fixture-preparation.json"),JSON.stringify(fixturePreparation,null,2));assert.equal(result.code,0,result.stderr||result.stdout);
  };
  await fixtureCli(["connectors","check","--json"]);
  await fixtureCli(["check","designs/native-qa.proto","--json"]);
  await fixtureCli(["compile","designs/native-qa.proto","--out","build/native-qa.ir.json"]);
  await fixtureCli(["workflow","run","designs/native-qa.proto"]);
  await fixtureCli(["review","run","designs/native-qa.proto"]);
  const sourceBytes=await readFile(join(workspace,"designs","native-qa.proto")),irBytes=await readFile(join(workspace,"build","native-qa.ir.json")),partsBytes=await readFile(join(workspace,"parts","eligible.json"));
  const ir=JSON.parse(irBytes);assert.equal(ir.provenance.source_sha256,sha(sourceBytes));assert.equal(ir.provenance.parts_sha256,sha(partsBytes));
  assert.equal(await fileSha(launch.executablePath),launch.executableSha256);
  const owner={schema:"proto-workbench.packaged-qa-owner.v1",candidateReportPath,candidateReportSha256:sha(candidateBytes),kind,sessionRoot,tempRoot,...launch,allowedPayloadRoot:kind==="portable"?tempRoot:launch.payloadRoot,cdpPort:await ephemeralPort()};
  const ownerPath=join(sessionRoot,"packaged-owner.json");await writeFile(ownerPath,JSON.stringify(owner,null,2),{flag:"wx"});
  const report={schema:"proto-workbench.packaged-scientific-smoke.v1",startedAt:new Date().toISOString(),kind,sessionRoot,candidateReportPath,candidateReportSha256:sha(candidateBytes),fixturePreparation,sourceSha256:sha(sourceBytes),partsSha256:sha(partsBytes),artifactSha256:sha(irBytes),tests:[],pageErrors:[],consoleErrors:[],screenshots:[],modelsLoaded:false,installerOsIntegration:"not-run; no installation, registry, shortcut, upgrade or uninstallation claim"};
  let launcher,browser,page;
  const persist=()=>writeFile(join(sessionRoot,"report.json"),JSON.stringify(report,null,2));
  const check=async(name,operation)=>{console.log(JSON.stringify({stage:name}));try{const details=await operation();report.tests.push({name,status:"passed",details});await persist();}catch(error){report.tests.push({name,status:"failed",error:error.message});throw error;}};
  const screenshot=async(name)=>{const path=join(evidence,`${name}.png`),bytes=await page.screenshot({path});report.screenshots.push({path,sha256:sha(bytes),dom:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}))});};
  try {
    // Windows PowerShell must discover its own built-ins, not inherited PS7 modules.
    const launcherEnvironment=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=="psmodulepath"));
    launcher=spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",join(appRoot,"scripts","owned-packaged-electron.ps1"),"-OwnerPath",ownerPath,"-MaximumSeconds","300"],{cwd:repository,env:launcherEnvironment,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    report.launcherPid=launcher.pid;report.launcherStdout="";report.launcherStderr="";
    launcher.stdout.on("data",bytes=>report.launcherStdout+=bytes);launcher.stderr.on("data",bytes=>report.launcherStderr+=bytes);launcher.on("error",error=>report.launcherError=error.message);
    await check("actual candidate executable and ASAR bound before UI interaction",async()=>{
      const binding=await waitUntil(async()=>{
        if(launcher.exitCode!==null||report.launcherError)throw new Error(report.launcherError??report.launcherStderr);
        return readFile(join(sessionRoot,"main-binding.json"),"utf8").then(text=>JSON.parse(text.replace(/^\uFEFF/,""))).catch(()=>undefined);
      },90_000);
      assert.equal(binding.schema,"proto-workbench.packaged-main-binding.v1");assert.equal(binding.sessionRoot,sessionRoot);assert.equal(binding.userData,profile);assert(binding.profileChild,"Actual Chromium child profile evidence is required.");assert.equal(binding.executableSha256,launch.expectedPayloadSha256);assert.equal(binding.asarSha256,launch.expectedAsarSha256);
      assert(contained(await realpath(owner.allowedPayloadRoot),await realpath(binding.executablePath)));
      assert.equal(await fileSha(binding.executablePath),launch.expectedPayloadSha256);assert.equal(await fileSha(binding.asarPath),launch.expectedAsarSha256);
      report.actualMain=binding;return binding;
    });
    const endpoint=await waitUntil(async()=>fetch(`http://127.0.0.1:${owner.cdpPort}/json/version`,{signal:AbortSignal.timeout(1000)}).then(response=>response.json()).then(value=>value.webSocketDebuggerUrl).catch(()=>undefined));
    browser=await chromium.connectOverCDP(endpoint);page=await waitUntil(async()=>browser.contexts().flatMap(context=>context.pages()).find(item=>item.url().startsWith("file:")));
    page.setDefaultTimeout(20_000);page.on("pageerror",error=>report.pageErrors.push(error.message));page.on("console",message=>{if(message.type()==="error")report.consoleErrors.push(message.text());});
    await check("packaged renderer and isolated workspace module integrity",async()=>{
      await page.getByText("Proto Workbench",{exact:true}).first().waitFor();
      assert(fileURLToPath(page.url()).toLowerCase().startsWith(`${report.actualMain.asarPath}${sep}`.toLowerCase()));
      const settings=await page.evaluate(()=>window.workbench.app.getSettings());assert.equal(resolve(settings.workspacePath),workspace);
      const integrity=await page.evaluate(()=>window.workbench.app.getModuleIntegrity());assert.equal(integrity.ok,true);assert.equal(integrity.enforced,true);assert.equal(integrity.manifestSha256,launch.expectedManifestSha256);
      assert((await lstat(join(profile,"proto-workbench.sqlite"))).isFile());
      report.nativeWindowGeometry=await page.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio}));
      report.nativeWindowSizing="Unmodified native default window; functional smoke only, no target viewport or performance claim.";
      await screenshot("01-packaged-startup");return {rendererUrl:page.url(),settings,integrity,profileDatabase:join(profile,"proto-workbench.sqlite")};
    });
    await check("packaged DNA map native exports and real packaged sidecar preview",async()=>{
      await page.getByRole("navigation",{name:"Primary"}).getByRole("button",{name:"Designs",exact:true}).click();
      const sidebarToggle=page.getByRole("button",{name:"Toggle task sidebar",exact:true});
      if(await sidebarToggle.getAttribute("aria-pressed")!=="true")await sidebarToggle.click();
      assert.equal(await sidebarToggle.getAttribute("aria-pressed"),"true");
      await page.locator(".design-document").filter({hasText:"native_visualization_qa"}).first().click();
      await page.getByRole("button",{name:/^Select p1, promoter/}).click();
      const exports=[],exportDirectory=join(workspace,"build","visualization-exports");
      const exportFiles=async()=>readdir(exportDirectory,{withFileTypes:true}).then(entries=>entries.filter(entry=>entry.isFile()).map(entry=>entry.name)).catch(error=>{if(error.code==="ENOENT")return [];throw error;});
      for(const format of ["SVG","PNG"]){
        const previous=new Set(await exportFiles());await page.getByRole("button",{name:format,exact:true}).click();
        const receipt=page.getByRole("region",{name:"Latest map export verification"});await receipt.waitFor();
        const filename=await waitUntil(async()=>{const created=(await exportFiles()).filter(name=>name.endsWith(`.${format.toLowerCase()}`)&&!previous.has(name));if(created.length!==1)return;const text=await receipt.innerText();return text.includes("Independently reopened")&&text.includes(created[0])?created[0]:undefined;});
        const path=await realpath(join(exportDirectory,filename));assert(contained(workspace,path));const bytes=await readFile(path),decoded=await sharp(bytes).metadata(),pixels=await sharp(bytes).ensureAlpha().stats();
        assert(decoded.width>100&&decoded.height>100);assert(pixels.channels.slice(0,3).some(channel=>channel.max-channel.min>16),`${format} must contain actual nonblank map pixels.`);
        exports.push({format,path,sha256:sha(bytes),bytes:bytes.length,width:decoded.width,height:decoded.height,independentlyDecoded:"sharp",receipt:await receipt.innerText()});
      }
      await screenshot("02-packaged-dna-map");
      await page.getByRole("button",{name:/DNA composer/}).click();
      await page.getByText("Source and materialized library match this artifact. Changes are staged for review.").waitFor();
      await page.getByRole("button",{name:"Reverse placement of c1",exact:true}).click();await page.getByRole("button",{name:/Preview 1 edits/}).click();
      await page.getByText("Candidate checks passed. Review the exact source diff, then apply.").waitFor({timeout:90_000});
      assert.match(await page.getByLabel("DNA source diff").innerText(),/orientation=reverse/);assert.equal(sha(await readFile(join(workspace,"designs","native-qa.proto"))),sha(sourceBytes));
      await screenshot("03-packaged-sidecar-validated-preview");return {sourceUnchanged:true,exports,sidecarEvidence:"Actual product candidate check preview succeeded; no development Python override and no model."};
    });
    await check("packaged protein sequence landscape and independent PNG",async()=>{
      await page.locator(".design-document").filter({hasText:"protein-observatory-phoa"}).click();await page.getByRole("heading",{name:"Molecular canvas"}).waitFor();
      await page.getByRole("button",{name:"Export tracks PNG",exact:true}).click();
      const receipt=page.getByRole("status",{name:"Protein track export verification"});await receipt.getByText("PNG independently reopened",{exact:true}).waitFor();
      const output=resolve(workspace,await receipt.locator("code").innerText());assert(contained(workspace,output));
      const bytes=await readFile(output),decoded=await sharp(bytes).metadata();assert.equal(decoded.width,1600);assert.equal(decoded.height,620);
      await screenshot("04-packaged-protein-sequence");return {output,sha256:sha(bytes),width:decoded.width,height:decoded.height,coordinatesClaim:"Sequence-only smoke; authentic3D verified separately in native scientific acceptance."};
    });
    await check("candidate and original scientific inputs unchanged with no owned model",async()=>{
      assert.equal(await fileSha(launch.executablePath),launch.executableSha256);assert.equal(await fileSha(report.actualMain.executablePath),launch.expectedPayloadSha256);assert.equal(await fileSha(report.actualMain.asarPath),launch.expectedAsarSha256);assert.equal(sha(await readFile(candidateReportPath)),report.candidateReportSha256);
      assert.equal(sha(await readFile(join(workspace,"parts","eligible.json"))),sha(partsBytes));assert.equal(sha(await readFile(join(workspace,"build","native-qa.ir.json"))),sha(irBytes));
      assert.equal(sha(await readFile(join(workspace,"designs","native-qa.proto"))),sha(sourceBytes));
      const catalogue=await page.evaluate(()=>window.workbench.models.list());assert(catalogue.every(model=>!model.workbenchInstance?.ownedByWorkbench));assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);return {modelsLoadedBySmoke:false,allInputDigestsUnchanged:true};
    });
    report.ok=true;
  }catch(error){report.ok=false;report.error=error.stack??error.message;if(page){await screenshot("failure").catch(()=>undefined);await writeFile(join(evidence,"failure-body.txt"),await page.locator("body").innerText().catch(()=>"unavailable"));}}
  finally {
    await browser?.close().catch(()=>undefined);await writeFile(join(sessionRoot,"stop-owned-app"),new Date().toISOString());
    if(launcher)await waitUntil(async()=>launcher.exitCode!==null||launcher.signalCode!==null,75_000).catch(error=>{report.cleanupError=error.message;});
    report.launchReceipt=await readFile(join(sessionRoot,"packaged-launch.json"),"utf8").then(text=>JSON.parse(text.replace(/^\uFEFF/,""))).catch(()=>null);
    report.cleanupGate={passed:Boolean(launcher&&launcher.exitCode===0&&report.launchReceipt?.processExited===true&&report.launchReceipt?.mainProcessExited===true&&Array.isArray(report.launchReceipt?.remainingOwnedChildren)&&report.launchReceipt.remainingOwnedChildren.length===0&&!report.launchReceipt.error&&!report.launchReceipt.cleanupError&&!report.cleanupError)};
    if(!report.cleanupGate.passed)report.ok=false;report.completedAt=new Date().toISOString();await persist();
  }
  console.log(JSON.stringify({ok:report.ok,report:join(sessionRoot,"report.json")}));if(!report.ok)process.exitCode=1;return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runPackagedScientific();
