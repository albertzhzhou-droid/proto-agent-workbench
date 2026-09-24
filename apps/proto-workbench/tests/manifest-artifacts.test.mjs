import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {close, createReadStream, open, read} from "node:fs";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createArtifactMaterializer, MANIFEST_HASH_CONCURRENCY} from "../scripts/manifest-artifacts.mjs";

async function fixture(count) {
  const base=fileURLToPath(new URL("../../../build/manifest-hash-qa/",import.meta.url));
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,"case-"));
  const files=[],contents=new Map();
  for(let index=0;index<count;index++) {
    const sourcePath=`file-${index}.bin`, content=Buffer.from(`${index}:`+"artifact-content;".repeat(30+index));
    await writeFile(join(root,sourcePath),content);contents.set(sourcePath,content);
    files.push({scope:"resource",path:`runtime/${sourcePath}`,sourcePath});
  }
  return {root,files,contents};
}

function monitoredStreams({failurePath,failure}={}) {
  const state={active:0,peak:0,opened:0,closed:0};
  return {state,openReadStream(path) {
    return createReadStream(path,{highWaterMark:47,fs:{
      open(value,flags,mode,callback) {
        open(value,flags,mode,(error,descriptor)=>{
          if(!error) {state.active++;state.opened++;state.peak=Math.max(state.peak,state.active);}
          callback(error,descriptor);
        });
      },
      read(descriptor,buffer,offset,length,position,callback) {
        if(path===failurePath) {setImmediate(()=>callback(failure));return;}
        read(descriptor,buffer,offset,length,position,callback);
      },
      close(descriptor,callback) {
        // A stream's end event precedes fd closure. Delaying close catches a
        // limiter that starts its replacement hash too early at end-of-data.
        setTimeout(()=>close(descriptor,error=>{state.active--;state.closed++;callback(error);}),10);
      },
    }});
  }};
}

test("manifest hashes all bytes in input order while bounding actual open handles",async()=>{
  const {root,files,contents}=await fixture(40);
  const monitored=monitoredStreams();
  const materialize=createArtifactMaterializer(root,{openReadStream:monitored.openReadStream});
  const reordered=[...files].reverse();reordered.splice(4,0,reordered[0]);
  const artifacts=await materialize(reordered);
  assert.deepEqual(artifacts.map(artifact=>artifact.path),reordered.map(file=>file.path));
  for(let index=0;index<artifacts.length;index++) {
    const content=contents.get(reordered[index].sourcePath);
    assert.equal(artifacts[index].sizeBytes,content.length);
    assert.equal(artifacts[index].sha256,createHash("sha256").update(content).digest("hex"));
  }
  assert.ok(monitored.state.peak>1,"fixture exercises parallel hashing");
  assert.ok(monitored.state.peak<=MANIFEST_HASH_CONCURRENCY,`peak handles ${monitored.state.peak}`);
  assert.equal(monitored.state.active,0);assert.equal(monitored.state.opened,40);assert.equal(monitored.state.closed,40);
  assert.deepEqual(await materialize(reordered),artifacts);
  assert.equal(monitored.state.opened,40,"completed and in-flight duplicates share one cached hash");
});

test("a failed hash preserves its error and drains active handles before rejecting",async()=>{
  const {root,files}=await fixture(12);
  const failure=Object.assign(new Error("controlled artifact read failure"),{code:"EIO"});
  const monitored=monitoredStreams({failurePath:join(root,files[0].sourcePath),failure});
  const materialize=createArtifactMaterializer(root,{concurrency:3,openReadStream:monitored.openReadStream});
  await assert.rejects(materialize(files),error=>error===failure);
  assert.equal(monitored.state.active,0,"no handles remain after the rejection is observable");
  assert.equal(monitored.state.opened,monitored.state.closed);
  assert.ok(monitored.state.peak<=3);
  assert.ok(monitored.state.opened<files.length,"unscheduled work stops after failure");
});
