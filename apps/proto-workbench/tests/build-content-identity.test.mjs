import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,mkdir,readFile,writeFile,symlink,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {IDENTITY_INPUT_ROOTS,IDENTITY_LOCK_PATHS,captureIdentityInputs,sealBuildIdentity,verifyBuildIdentity} from "../scripts/build-content-identity.mjs";

const APP="apps/proto-workbench", script=fileURLToPath(new URL("../scripts/build-content-identity.mjs",import.meta.url));
const inputPath=`${APP}/build/content-identity/test/inputs.json`,identityPath=`${APP}/build/content-identity/test/identity.json`;
const isFile=path=>path==="LICENSE"||path.split("/").at(-1).includes(".");
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"proto-content-identity-"));
  for(const path of IDENTITY_INPUT_ROOTS) {
    if(isFile(path)) {await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),`fixture input ${path}\n`);}
    else await mkdir(join(root,path),{recursive:true});
  }
  await writeFile(join(root,APP,"src","untracked.ts"),"dirty working tree source\n");
  await mkdir(join(root,APP,"dist"));await writeFile(join(root,APP,"dist","index.html"),"fixture output; no build performed");
  return root;
}
const cli=(root,...args)=>spawnSync(process.execPath,[script,...args,"--repo",root],{encoding:"utf8",windowsHide:true,timeout:15000});

test("content identity preserves dirty bytes and separately binds locks and output without Git",async()=>{
  const root=await fixture(),capture=await captureIdentityInputs(root,"renderer"),identity=await sealBuildIdentity(root,capture);
  assert.equal((await verifyBuildIdentity(root,identity)).ok,true);
  assert.match(capture.sourceAuthority,/uncommitted and untracked/);
  assert.deepEqual(capture.dependencyLocks.map(row=>row.path),IDENTITY_LOCK_PATHS);
  assert.ok(capture.source.records.some(row=>row.path===`${APP}/src/untracked.ts`));
  assert.match(identity.contentId,/^[a-f0-9]{64}$/);
  assert.equal(identity.contentId,(await sealBuildIdentity(root,await captureIdentityInputs(root,"renderer"))).contentId);
  assert.match(identity.scope,/not dependency installation/);
});

test("source edits between capture and seal fail; later source and added files fail verification",async()=>{
  const root=await fixture(),path=join(root,APP,"src","untracked.ts"),original=await readFile(path);
  const capture=await captureIdentityInputs(root,"renderer"),identity=await sealBuildIdentity(root,capture);
  await writeFile(path,"changed source\n");
  await assert.rejects(sealBuildIdentity(root,capture),/Source or dependency lock changed/);
  await assert.rejects(verifyBuildIdentity(root,identity),/Source or dependency lock changed/);
  await writeFile(path,original);await writeFile(join(root,APP,"src","added.ts"),"new source");
  await assert.rejects(verifyBuildIdentity(root,identity),/Source or dependency lock changed/);
});

test("a dependency lock change cannot reuse the old identity",async()=>{
  const root=await fixture(),capture=await captureIdentityInputs(root,"renderer"),identity=await sealBuildIdentity(root,capture);
  await writeFile(join(root,"uv.lock"),"different resolved dependency bytes");
  await assert.rejects(verifyBuildIdentity(root,identity),/Source or dependency lock changed/);
  const updated=await captureIdentityInputs(root,"renderer");
  assert.notEqual(updated.dependencyLocksSha256,capture.dependencyLocksSha256);
});

test("modified, added and missing output artifacts invalidate the final identity",async()=>{
  const root=await fixture(),path=join(root,APP,"dist","index.html"),original=await readFile(path);
  const identity=await sealBuildIdentity(root,await captureIdentityInputs(root,"renderer"));
  await writeFile(path,"tampered output");await assert.rejects(verifyBuildIdentity(root,identity),/Build output changed/);
  await writeFile(path,original);await writeFile(join(root,APP,"dist","injected.js"),"injected");
  await assert.rejects(verifyBuildIdentity(root,identity),/Build output changed/);
  await unlink(path);await assert.rejects(verifyBuildIdentity(root,identity),/Required build output is absent/);
});

test("desktop identity requires generated module manifest and keeps its exact bytes bound",async()=>{
  const root=await fixture(),capture=await captureIdentityInputs(root,"desktop");
  for(const path of ["main/index.js","preload/index.cjs","renderer/index.html"]) {
    const target=join(root,APP,"out",path);await mkdir(dirname(target),{recursive:true});await writeFile(target,"fixture output");
  }
  await assert.rejects(sealBuildIdentity(root,capture),/module-manifest.json/);
  const modulePath=join(root,APP,"out","module-manifest.json");await writeFile(modulePath,'{"fixture":true}');
  const identity=await sealBuildIdentity(root,capture);assert.equal((await verifyBuildIdentity(root,identity)).ok,true);
  await writeFile(modulePath,'{"fixture":"changed"}');await assert.rejects(verifyBuildIdentity(root,identity),/Build output changed/);
});

test("output inventory does not inherit input-cache or ignored-name exclusions",async()=>{
  const root=await fixture(),capture=await captureIdentityInputs(root,"renderer");
  const file=join(root,APP,"dist",".ignored_executable.js");await writeFile(file,"original hidden output");
  const identity=await sealBuildIdentity(root,capture);
  assert.ok(identity.output.records.some(record=>record.path.endsWith("/.ignored_executable.js")));
  await writeFile(file,"changed hidden output");
  await assert.rejects(verifyBuildIdentity(root,identity),/Build output changed/);
});

test("fixed profiles omit installed dependencies and build caches and reject unknown profiles",async()=>{
  const root=await fixture(),capture=await captureIdentityInputs(root,"renderer");
  assert.ok(IDENTITY_INPUT_ROOTS.every(path=>!path.includes("node_modules")&&!path.includes("/build/")&&!path.includes("/dist")&&!path.includes("/out")));
  await mkdir(join(root,APP,"node_modules"));await writeFile(join(root,APP,"node_modules","not-hashed.txt"),"installed bytes");
  await mkdir(join(root,"build"));await writeFile(join(root,"build","not-hashed.txt"),"cache bytes");
  assert.equal((await captureIdentityInputs(root,"renderer")).inputSha256,capture.inputSha256);
  await assert.rejects(captureIdentityInputs(root,"../../node_modules"),/Unknown content identity profile/);
});

test("source and output directory links are rejected before following them",async()=>{
  const root=await fixture(),outside=await mkdtemp(join(tmpdir(),"proto-content-outside-"));
  await writeFile(join(outside,"must-not-read.txt"),"outside bytes");
  await symlink(outside,join(root,APP,"src","escape"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(captureIdentityInputs(root,"renderer"),/cannot contain links/);
  await unlink(join(root,APP,"src","escape"));
  const capture=await captureIdentityInputs(root,"renderer");
  await symlink(outside,join(root,APP,"dist","escape"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(sealBuildIdentity(root,capture),/cannot contain links/);
});

test("manifest tampering and substituted allowlists do not redirect the checker",async()=>{
  const root=await fixture(),capture=await captureIdentityInputs(root,"renderer"),identity=await sealBuildIdentity(root,capture);
  await assert.rejects(verifyBuildIdentity(root,{...identity,contentId:"0".repeat(64)}),/digest mismatch/);
  const injected=structuredClone(capture);injected.source.roots=["../../outside"];
  await assert.rejects(sealBuildIdentity(root,injected),/Source allowlist/);
});

test("CLI capture, seal and verify use exclusive evidence paths and reject current artifact changes",async()=>{
  const root=await fixture();
  const captured=cli(root,"capture","--profile","renderer","--manifest",inputPath);
  assert.equal(captured.status,0,captured.stderr);
  const duplicate=cli(root,"capture","--profile","renderer","--manifest",inputPath);assert.notEqual(duplicate.status,0);
  const sealed=cli(root,"seal","--capture",inputPath,"--manifest",identityPath);assert.equal(sealed.status,0,sealed.stderr);
  const verified=cli(root,"verify","--manifest",identityPath);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).ok,true);
  await writeFile(join(root,APP,"dist","index.html"),"changed after sealing");
  const rejected=cli(root,"verify","--manifest",identityPath);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/Build output changed/);
  const outside=cli(root,"capture","--profile","renderer","--manifest",resolve(root,"../outside.json"));assert.notEqual(outside.status,0);assert.match(outside.stderr,/must stay/);
});

test("Windows build entrypoint captures before bundling and seals after the existing module manifest",async()=>{
  const source=await readFile(new URL("../scripts/build-desktop.ps1",import.meta.url),"utf8");
  assert.ok(source.indexOf('"capture"')<source.indexOf('"node_modules/electron-vite/bin/electron-vite.js", "build"'));
  assert.ok(source.indexOf('"scripts/generate-module-manifest.mjs"')<source.indexOf('"seal"'));
  assert.ok(source.indexOf('"seal"')<source.indexOf('Exit-ProjectBuildLease $Lease'));
});
