import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { prepareLaunchSession, prepareLaunchWorkspace } from "../src/main/services/launch-session.ts";

async function fixture(context) {
  const root=await mkdtemp(join(tmpdir(),"proto-launch-session-"));
  context.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}

test("explicit session initializes canonical independent directories and reopens existing inputs",async context=>{
  const root=await fixture(context), session=prepareLaunchSession(["app.exe",`--session-root=${root}`]);
  assert.equal(session.root,await realpath(root));
  assert.equal(session.profile,await realpath(join(root,"profile")));
  assert.equal(session.workspace,await realpath(join(root,"workspace")));
  await writeFile(join(session.workspace,"existing.proto"),"preserve");
  assert.deepEqual(prepareLaunchSession(["app.exe","--session-root",root]),session);
  assert.equal(await readFile(join(session.workspace,"existing.proto"),"utf8"),"preserve");
});

test("isolated packaged launch never resolves Documents or seeds any default workspace",async context=>{
  const root=await fixture(context), session=prepareLaunchSession([`--session-root=${root}`]);
  const documents=join(root,"must-not-create-documents");
  const selected=await prepareLaunchWorkspace({packaged:true,session,fallbackPath:"ignored",
    documentsPath:()=>{throw new Error("Documents must not be accessed");},templatePath:"missing-template-is-not-read"});
  assert.equal(selected,session.workspace);
  await assert.rejects(stat(documents),{code:"ENOENT"});
  assert.deepEqual(await import("node:fs/promises").then(fs=>fs.readdir(session.workspace)),[]);
});

test("ordinary packaged startup retains missing-only template seeding",async context=>{
  const root=await fixture(context), template=join(root,"template"), documents=join(root,"documents");
  await mkdir(template); await writeFile(join(template,"sample.proto"),"template");
  const config={packaged:true,fallbackPath:"unused",documentsPath:()=>documents,templatePath:template};
  const path=await prepareLaunchWorkspace(config);
  assert.equal(path,join(documents,"Proto Workbench Workspace"));
  await writeFile(join(path,"sample.proto"),"user-edit");
  await prepareLaunchWorkspace(config);
  assert.equal(await readFile(join(path,"sample.proto"),"utf8"),"user-edit");
});

test("ordinary development preserves its selected workspace without template or Documents access",async()=>{
  assert.equal(prepareLaunchSession(["app.exe","--other-flag"]),undefined);
  assert.equal(await prepareLaunchWorkspace({packaged:false,fallbackPath:"selected-development-workspace",documentsPath:()=>{throw new Error("unexpected Documents read");},templatePath:"missing"}),"selected-development-workspace");
});

test("invalid, missing, repeated and filesystem-root session arguments are rejected",async context=>{
  const root=await fixture(context); await writeFile(join(root,"file"),"not a directory");
  for(const args of [["--session-root"],["--session-root=relative"],["--session-root="],
    [`--session-root=${root}`,`--session-root=${root}`],[`--session-root=${parse(root).root}`],
    [`--session-root=${join(root,"missing")}`],[`--session-root=${join(root,"file")}`]]) {
    assert.throws(()=>prepareLaunchSession(args));
  }
});

test("profile and workspace aliases cannot redirect session writes",async context=>{
  const root=await fixture(context), target=join(root,"outside"); await mkdir(target);
  try { await symlink(target,join(root,"profile"),process.platform==="win32"?"junction":"dir"); }
  catch(error) { if(["EPERM","EACCES"].includes(error.code)){context.skip("Directory links unavailable on this host");return;} throw error; }
  assert.throws(()=>prepareLaunchSession([`--session-root=${root}`]),/directly inside/);
});
