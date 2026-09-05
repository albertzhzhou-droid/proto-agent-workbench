import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createReadOnlyPackager, loadPrivateBuilder } from "../scripts/package-builder.mjs";
import { captureBuildInputs, assertSameBuildInputs } from "../scripts/build-input-snapshot.mjs";

const appRequire = createRequire(new URL("../package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder/package.json"));
const library = builderRequire("app-builder-lib");
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));

test("installed public Packager selects npm and exact workspace without touching its lazy discovery", async () => {
  const root = resolve("build/packager-api-software-fixture");
  const options = {projectDir:root,win:["nsis","portable"],publish:"never",config:{npmRebuild:false}};
  const packager = createReadOnlyPackager(library,options,root);
  Object.defineProperty(packager,"_packageManager",{value:{get value(){throw new Error("Automatic package-manager discovery must be unreachable");}}});
  assert.equal(await packager.getPackageManager(),"npm");
  assert.equal(await packager.getWorkspaceRoot(),root);
  assert.equal(typeof library.build,"function");
  assert.throws(()=>createReadOnlyPackager(library,{...options,config:{npmRebuild:true}},root),/npmRebuild=false/);
  assert.throws(()=>createReadOnlyPackager(library,options,join(root,"other")),/bound app root/);
});

test("installed npm collector preserves fixture bytes and production/optional dependency graph without pnpm", {timeout:30000}, async t => {
  const evidenceRoot = resolve("../../build/upgrade-20260904");
  await mkdir(evidenceRoot,{recursive:true});
  const evidence = await mkdtemp(join(evidenceRoot,"package-builder-readonly-"));
  const root = join(evidence,"private-project");
  const manifest = {name:"packaging-software-fixture",version:"1.0.0",packageManager:"pnpm@11.19.0",dependencies:{"software-prod":"1.0.0"},optionalDependencies:{"software-optional":"1.0.0"},devDependencies:{"software-dev":"1.0.0"}};
  await mkdir(root);
  await writeFile(join(root,"package.json"),JSON.stringify(manifest));
  await writeFile(join(root,"pnpm-workspace.yaml"),"verifyDepsBeforeRun: install\n");
  for(const name of ["software-prod","software-optional","software-dev"]) {
    await mkdir(join(root,"node_modules",name),{recursive:true});
    await writeFile(join(root,"node_modules",name,"package.json"),JSON.stringify({name,version:"1.0.0",main:"index.js"}));
    await writeFile(join(root,"node_modules",name,"index.js"),"module.exports = 1;\n");
  }
  await writeFile(join(root,"node_modules/.pnpm-workspace-state-v1.json"),'{"lastValidatedTimestamp":0,"projects":{},"settings":{}}');
  const roots=["package.json","pnpm-workspace.yaml","node_modules"];
  const before=await captureBuildInputs(root,roots);
  const oldCache=process.env.npm_config_cache;
  process.env.npm_config_cache=join(evidence,"cache");
  t.after(()=>{if(oldCache===undefined)delete process.env.npm_config_cache;else process.env.npm_config_cache=oldCache;});
  const childProcess=libRequire("node:child_process"), originalSpawn=childProcess.spawn, calls=[];
  childProcess.spawn=function(command,args,options) {
    const readableArgs=args?.includes("-EncodedCommand") ? Buffer.from(args[args.indexOf("-EncodedCommand")+1],"base64").toString("utf16le") : args?.join(" ");
    calls.push({command,args,readableArgs,cwd:options?.cwd});
    assert.doesNotMatch(`${command} ${readableArgs}`,/\bpnpm\b|\binstall\b|\brebuild\b/i);
    return originalSpawn.call(this,command,args,{...options,windowsHide:true});
  };
  t.after(()=>{childProcess.spawn=originalSpawn;});
  const packager=createReadOnlyPackager(library,{projectDir:root,win:["nsis","portable"],publish:"never",config:{npmRebuild:false}},root);
  const {getCollectorByPackageManager}=libRequire("./node-module-collector/index.js");
  let temporary=0;
  const collector=getCollectorByPackageManager(await packager.getPackageManager(),await packager.getWorkspaceRoot(),{getTempFile:async()=>join(evidence,`collector-${temporary++}.json`)});
  const result=await collector.getNodeModules({packageName:manifest.name});
  const names=result.nodeModules.map(item=>item.name).sort();
  assert.deepEqual(names,["software-optional","software-prod"]);
  assert.ok(calls.some(item=>/\blist\b/.test(item.readableArgs)));
  const after=await captureBuildInputs(root,roots);
  assertSameBuildInputs(before,after,"installed read-only npm collection");
  await writeFile(join(evidence,"report.json"),JSON.stringify({schemaVersion:"proto-workbench.read-only-collector-proof.v1",before,after,names,calls,installationExecuted:false,pnpmInvoked:false},null,2));
});

test("builder launcher rejects non-private source roots and preexisting release outputs",async()=>{
  const sourceRoot=resolve("../..");
  await assert.rejects(loadPrivateBuilder({sourceRoot,privateRoot:sourceRoot,releaseRoot:join(sourceRoot,"apps/proto-workbench/build/release-staging-"+"a".repeat(32))}),/full-GUID private repository/);
  const fakeSource=await mkdtemp(join(sourceRoot,"build/upgrade-20260904/package-builder-boundary-"));
  const privateRoot=join(fakeSource,"build","a".repeat(32));
  const releaseRoot=join(fakeSource,"apps/proto-workbench/build/release-staging-"+"b".repeat(32));
  await mkdir(join(privateRoot,"apps/proto-workbench"),{recursive:true});
  await mkdir(releaseRoot,{recursive:true});
  await assert.rejects(loadPrivateBuilder({sourceRoot:fakeSource,privateRoot,releaseRoot}),/must not already exist/);
});
