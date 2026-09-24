import assert from "node:assert/strict";
import test from "node:test";
import { IPC } from "../src/shared/ipc.ts";
import { validateIpcArguments } from "../src/main/ipc-security.ts";
import { previewCompute } from "../src/renderer/compute-preview.ts";

const studyId = "b52c77e5-1259-4a94-a068-fd5e1d8fa45e";
const runId = "ab".repeat(16);
test("research project IPC supports bounded metadata and host-owned saved-run identities", () => {
  for (const request of [
    {action:"list",limit:30}, {action:"create",name:"Saved research",question:"Which input changed?"},
    {action:"get",studyId}, {action:"update",studyId,expectedRevision:2,name:"Changed name",question:"Updated question"},
    {action:"runs",studyId,limit:20}, {action:"runs"},
    {action:"link",studyId,expectedRevision:2,runId}, {action:"unlink",studyId,expectedRevision:3,runId},
    {action:"open-run",studyId,runId}, {action:"open-run",runId},
  ]) assert.deepEqual(validateIpcArguments(IPC.computeStudies,[request]),[request]);
});

test("research project IPC cannot choose paths, submit results, rebind anchors or execute a tool", () => {
  for (const request of [
    {action:"list",path:"C:/outside/studies.sqlite"},
    {action:"list",databaseRelativePath:"build/alternate.sqlite"},
    {action:"create",name:"",question:"x"},
    {action:"create",name:"n".repeat(121),question:"x"},
    {action:"create",name:"x",question:"q".repeat(8001)},
    {action:"update",studyId,expectedRevision:0,name:"x",question:"x"},
    {action:"update",studyId,expectedRevision:Number.MAX_SAFE_INTEGER+1,name:"x",question:"x"},
    {action:"link",studyId,expectedRevision:1,runId:"../../outside"},
    {action:"link",studyId,expectedRevision:1,runId,binding:{resultSha256:"0".repeat(64)}},
    {action:"open-run",runId,receipt:{ok:true,result:{mean:100}}},
    {action:"open-run",runId,preview:true},
    {action:"runs",limit:31}, {action:"list",limit:51},
    {action:"runs",cursor:"x".repeat(2049)},
    {action:"run",tool:"descriptive_statistics",arguments:{values:[1,2,3]}},
  ]) assert.throws(()=>validateIpcArguments(IPC.computeStudies,[request]),/Invalid arguments/);
});

test("static example preview never claims to persist or reopen a real research project", async () => {
  for (const request of [{action:"list"},{action:"open-run",runId},{action:"create",name:"Fixture",question:"No local host"}]) {
    await assert.rejects(previewCompute.studies(request),/require the local Workbench/);
  }
});
