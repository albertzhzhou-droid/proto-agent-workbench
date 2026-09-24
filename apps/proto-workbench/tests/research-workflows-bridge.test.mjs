import assert from 'node:assert/strict';
import test from 'node:test';
import {IPC} from '../src/shared/ipc.ts';
import {validateIpcArguments} from '../src/main/ipc-security.ts';
import {previewCompute} from '../src/renderer/compute-preview.ts';
const studyId='b52c77e5-1259-4a94-a068-fd5e1d8fa45e',workflowId='9c6f6349-b6c8-4d60-88cf-f5933b25d73b',executionId='c4d8de39-55c2-4652-95d8-fde3399634c3';
const draft={name:'Bounded software example',description:'Synthetic values; no empirical claim',steps:[{id:'summary',title:'Summary',tool:'descriptive_statistics',arguments:{values:[1,2,3]},bindings:[]}]};
test('workflow IPC accepts versioned definitions and explicit lifecycle actions',()=>{
 for(const request of [
  {action:'list',studyId},{action:'validate',studyId,draft},{action:'save',studyId,draft},
  {action:'save',studyId,workflowId,expectedRevision:2,draft},{action:'get',studyId,workflowId,revision:1},
  {action:'preview',studyId,workflowId,expectedRevision:2,forceSteps:['summary']},
  {action:'start',studyId,workflowId,expectedRevision:2,expectedPlanSha256:'a'.repeat(64),forceSteps:['summary']},
  {action:'get-execution',studyId,workflowId,executionId},{action:'cancel',studyId,workflowId,executionId},
  {action:'recover',studyId,workflowId,executionId,acknowledgeInterrupted:true},
 ])assert.deepEqual(validateIpcArguments(IPC.computeWorkflows,[request]),[request]);
});
test('workflow IPC rejects fabricated execution metadata, host paths and non-JSON values',()=>{
 for(const request of [
  {action:'list',studyId,databaseRelativePath:'build/other.sqlite'},
  {action:'save',studyId,draft,execution:{status:'succeeded'}},
  {action:'start',studyId,workflowId,expectedRevision:2,forceSteps:['summary']},
  {action:'start',studyId,workflowId,expectedRevision:2,expectedPlanSha256:'a'.repeat(63),forceSteps:['summary']},
  {action:'start',studyId,workflowId,expectedRevision:0},
  {action:'start',studyId,workflowId,expectedRevision:1,expectedPlanSha256:'a'.repeat(64),cacheable:true},
  {action:'start',studyId,workflowId,expectedRevision:1,expectedPlanSha256:'a'.repeat(64),forceSteps:['../../outside']},
  {action:'recover',studyId,workflowId,executionId},
  {action:'recover',studyId,workflowId,executionId,acknowledgeInterrupted:false},
  ...[NaN,Infinity,undefined,new Date(),1n].map(value=>({action:'save',studyId,draft:{...draft,steps:[{...draft.steps[0],arguments:{value}}]}})),
  {action:'save',studyId,draft:{...draft,steps:[{...draft.steps[0],arguments:{value:'\u03b1'.repeat(1_100_000)}}]}},
 ])assert.throws(()=>validateIpcArguments(IPC.computeWorkflows,[request]),/Invalid arguments/);
});
test('static Compute preview cannot create a fictitious persistent workflow',async()=>{
 for(const request of [{action:'list',studyId},{action:'save',studyId,draft},{action:'start',studyId,workflowId,expectedRevision:1}])
  await assert.rejects(previewCompute.workflows(request),/local Workbench/);
});
