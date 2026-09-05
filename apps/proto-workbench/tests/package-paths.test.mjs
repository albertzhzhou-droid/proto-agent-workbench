import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createBuildInputSnapshot } from "../scripts/build-input-snapshot.mjs";
import { MAX_NSIS_CWD_LENGTH, assertNsisCwdLength, projectPackagePaths, verifyPackagePaths } from "../scripts/package-paths.mjs";

const APP = "apps/proto-workbench";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pwp-")), source = join(root, "s");
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, {recursive:true,force:true}); });
  const modules = join(source, APP, "node_modules");
  const library = join(modules, "app-builder-lib");
  await mkdir(join(library,"out","util"),{recursive:true});
  await mkdir(join(library,"templates","nsis"),{recursive:true});
  await mkdir(join(modules,"electron-builder"),{recursive:true});
  await writeFile(join(source,APP,"package.json"),'{}');
  await writeFile(join(modules,"electron-builder","package.json"),'{"name":"electron-builder"}');
  await writeFile(join(library,"package.json"),'{"name":"app-builder-lib"}');
  await writeFile(join(library,"out","util","pathManager.js"),'const path=require("node:path");exports.getTemplatePath=name=>path.join(__dirname,"..","..","templates",name);');
  await writeFile(join(library,"templates","nsis","fixture.nsh"),'; resolver fixture only; never compiled');
  const target = join(source,"build","0123456789abcdef0123456789abcdef");
  return {source,target,library};
}
async function copy(source,target) {
  await createBuildInputSnapshot({sourceRoot:source,destinationRoot:target,roots:[`${APP}/node_modules`,`${APP}/package.json`]});
}

test("copied NSIS resolver matches its short projected private working directory",async t=>{
  const {source,target}=await fixture(t);
  const projected=await projectPackagePaths(source,target);
  await copy(source,target);
  const actual=await verifyPackagePaths(target,projected);
  assert.equal(actual.phase,"actual");assert.equal(actual.nsisCwd,projected.nsisCwd);
  assert.ok(actual.length<=MAX_NSIS_CWD_LENGTH);
  assert.equal(await readFile(join(actual.nsisCwd,"fixture.nsh"),"utf8"),'; resolver fixture only; never compiled');
});

test("path preflight rejects overlong projections and out-of-build staging before any copy",async t=>{
  const {source,target}=await fixture(t);
  await assert.rejects(projectPackagePaths(source,join(target,"x".repeat(180))),/working directory.*maximum is 240/);
  await assert.rejects(projectPackagePaths(source,join(source,"outside")),/private build boundary/);
});

test("actual resolver cannot follow a copied dependency back into original source",async t=>{
  const {source,target,library}=await fixture(t), projected=await projectPackagePaths(source,target);
  await copy(source,target);
  const copiedLibrary=join(target,APP,"node_modules","app-builder-lib");
  assert.ok(copiedLibrary.startsWith(target));
  await rm(copiedLibrary,{recursive:true,force:true});
  await symlink(library,copiedLibrary,process.platform==="win32"?"junction":"dir");
  await assert.rejects(verifyPackagePaths(target,projected),/Resolved NSIS templates.*private build boundary/);
});

test("actual working directory must remain bound to the same repository and projection",async t=>{
  const {source,target}=await fixture(t), projected=await projectPackagePaths(source,target);
  await copy(source,target);
  await assert.rejects(verifyPackagePaths(target,{...projected,privateRoot:source}),/does not bind/);
  await assert.rejects(verifyPackagePaths(target,{...projected,nsisCwd:join(projected.nsisCwd,"other")}),/differs from its captured projection/);
});

test("Windows working-directory safety margin accepts 240 characters and rejects 241",()=>{
  assert.doesNotThrow(()=>assertNsisCwdLength("a".repeat(240)));
  assert.throws(()=>assertNsisCwdLength("a".repeat(241)),/maximum is 240/);
});

test("a short working directory still rejects an overlong required include filename",async t=>{
  const {source,target,library}=await fixture(t);
  await writeFile(join(library,"templates","nsis","include-"+"x".repeat(180)+".nsh"),'; long-path fixture');
  await assert.rejects(projectPackagePaths(source,target),/NSIS input path.*maximum is 259/);
});

test("configured resource paths are checked before copying and cannot escape the repository",async t=>{
  const {source,target}=await fixture(t);
  await writeFile(join(source,APP,"package.json"),JSON.stringify({build:{nsis:{license:"x".repeat(200)+".txt"}}}));
  await assert.rejects(projectPackagePaths(source,target),/NSIS input path.*maximum is 259/);
  await writeFile(join(source,APP,"package.json"),JSON.stringify({build:{nsis:{license:join(dirname(source),"outside.txt")}}}));
  await assert.rejects(projectPackagePaths(source,target),/NSIS resource.*private build boundary/);
});

test("actual include inventory cannot grow after its captured projection",async t=>{
  const {source,target}=await fixture(t), projected=await projectPackagePaths(source,target);
  await copy(source,target);
  await writeFile(join(target,APP,"node_modules","app-builder-lib","templates","nsis","unexpected.nsh"),'; extra input');
  await assert.rejects(verifyPackagePaths(target,projected),/input inventory differs/);
});
