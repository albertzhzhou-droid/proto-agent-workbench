import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {resolve,join,relative,isAbsolute} from "node:path";
import {waitBetweenAcceptanceCases} from "../scripts/harness-case-controls.mjs";
for(const stop of [false,true])test(`between-case owner hold ${stop?"honors STOP":"waits for removal"} without starting another mission`,async()=>{
 const base=resolve("build/test-case-controls");await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"case-")),pauseFile=join(root,"PAUSE_BETWEEN_CASES"),events=[];let stopped=false,started=false,held;
 const entered=new Promise(resolve=>{held=resolve;});
 try{
  await writeFile(pauseFile,"");
  const wait=waitBetweenAcceptanceCases({pauseFile,shouldStop:()=>stopped,onHold:async()=>{events.push("held");held();},onRelease:async value=>events.push(value),pollMs:5}).then(ready=>{started=ready;return ready;});
  await entered;assert.equal(started,false);
  if(stop)stopped=true;else await rm(pauseFile);
  assert.equal(await wait,!stop);assert.equal(started,!stop);assert.deepEqual(events,["held",{stopped:stop}]);
 }finally{const child=relative(base,root);assert.ok(child&&!child.startsWith("..")&&!isAbsolute(child));await rm(root,{recursive:true,force:true});}
});
