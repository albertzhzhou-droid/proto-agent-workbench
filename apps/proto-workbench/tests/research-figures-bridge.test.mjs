import assert from 'node:assert/strict';
import test from 'node:test';
import {IPC} from '../src/shared/ipc.ts';
import {validateIpcArguments} from '../src/main/ipc-security.ts';
import {previewCompute} from '../src/renderer/compute-preview.ts';

const studyId='b52c77e5-1259-4a94-a068-fd5e1d8fa45e',figureId='aa4a790f-4727-462c-9a8e-6b597c5645cb',runId='ab'.repeat(16);
const panel={id:figureId,runId,title:'Synthetic fixture',kind:'line',xLabel:'Index',yLabel:'Value',xUnit:'',yUnit:'',y:{from:'result',pointer:'/values'}};
const save={action:'save',studyId,expectedStudyRevision:2,draft:{title:'Fixture',caption:'',columns:2,panels:[panel]}};
test('figure IPC accepts selectors and saved identities without accepting supplied data or output paths',()=>{
  for(const request of [save,{action:'inspect',studyId,figureId},{action:'export',studyId,figureId,expectedRevision:1,expectedStudyRevision:2,acknowledgeChangedSources:false},{action:'artifact',studyId,figureId,exportId:runId,format:'pdf'}])assert.deepEqual(validateIpcArguments(IPC.computeFigures,[request]),[request]);
  for(const request of [
    {...save,outputPath:'../outside.pdf'},
    {...save,draft:{...save.draft,panels:[{...panel,points:[{x:1,y:999}]}]}},
    {...save,draft:{...save.draft,panels:[{...panel,binding:{resultSha256:'a'.repeat(64)}}]}},
    {...save,draft:{...save.draft,panels:[panel,panel]}},
    {...save,expectedStudyRevision:0},
    {action:'artifact',studyId,figureId,exportId:'../../escape',format:'pdf'},
    {action:'export',studyId,figureId,expectedRevision:1,expectedStudyRevision:2,acknowledgeChangedSources:true,code:'arbitrary'},
  ])assert.throws(()=>validateIpcArguments(IPC.computeFigures,[request]),/Invalid arguments/);
});
test('static previews cannot claim persistent figures or generate a local export',async()=>{
  await assert.rejects(previewCompute.figures({action:'list',studyId}),/local Workbench/);
});
