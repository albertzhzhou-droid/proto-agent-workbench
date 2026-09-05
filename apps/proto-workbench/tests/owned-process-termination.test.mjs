import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {terminateOwnedProcessTree} from "../src/main/services/process-security.ts";
import {McpClient} from "../src/main/services/mcp-client.ts";
function fixture(){const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.kill=()=>false;return child;}
test("termination does not report success when its owned process never exits",async()=>{
  const child=fixture(),keepAlive=setTimeout(()=>{},100);
  try{await assert.rejects(terminateOwnedProcessTree(child,5),error=>error.code==="OWNED_PROCESS_EXIT_TIMEOUT");}finally{clearTimeout(keepAlive);}
});
test("an exited owned process still waits for stdio close before teardown settles",async()=>{
  const child=fixture();child.exitCode=0;child.stdio=[{destroyed:false}];let settled=false;
  const cleanup=terminateOwnedProcessTree(child,100).then(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  child.emit("close",0);await cleanup;assert.equal(settled,true);
});
test("missing stdio close is a bounded cleanup failure",async()=>{
  const child=fixture();child.exitCode=0;child.stdio=[{destroyed:false}];const keepAlive=setTimeout(()=>{},100);
  try{await assert.rejects(terminateOwnedProcessTree(child,5),error=>error.code==="OWNED_PROCESS_STREAM_TIMEOUT");}finally{clearTimeout(keepAlive);}
});
test("MCP retains a failed asynchronous cleanup and never reports a later false successful stop",async()=>{
  const client=new McpClient({packaged:false,resourcesPath:"",repoRoot:"",workspacePath:"",workspaceCapability:"a".repeat(64)});
  // No PID exists; this exercises the production final wait and failure path
  // without starting or targeting an OS process.
  client.child=fixture();const keepAlive=setTimeout(()=>{},3000);
  try{
    await assert.rejects(client.stop(),error=>error.code==="OWNED_PROCESS_EXIT_TIMEOUT");
    await assert.rejects(client.stop(),error=>error.code==="OWNED_PROCESS_EXIT_TIMEOUT");
  }finally{clearTimeout(keepAlive);}
});
