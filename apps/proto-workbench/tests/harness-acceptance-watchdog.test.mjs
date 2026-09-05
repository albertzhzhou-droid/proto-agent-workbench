import test from "node:test";
import assert from "node:assert/strict";
import {AcceptanceWatchdog,boundedSettlement} from "../scripts/harness-acceptance-watchdog.mjs";
const checkpoint=(revision,state="generating",activeTimeMs=1,budget=100)=>({revision,state,activeTimeMs,contract:{runId:"fixture",budgets:{activeTimeMs:budget}}});
const monitor=()=>new AcceptanceWatchdog({startedAt:0,startupMs:20,checkpointLivenessMs:9,cleanupMs:6});
test("queued heartbeats can outlast the complete wall-clock task budget without consuming it",()=>{
  const watch=monitor();
  for(let time=0;time<1000;time+=5)assert.equal(watch.observe(checkpoint(time+1,"queued",1),{now:time}),undefined);
  assert.equal(watch.observe(checkpoint(1001,"generating",2),{now:1000}),undefined);
});
test("startup and missing checkpoint liveness are bounded even for a queued task",()=>{
  const watch=monitor();assert.equal(watch.observe(undefined,{now:19}),undefined);assert.equal(watch.observe(undefined,{now:20}).code,"CHECKPOINT_STARTUP_TIMEOUT");
  const queued=monitor();queued.observe(checkpoint(1,"queued"),{now:0});assert.equal(queued.observe(checkpoint(1,"queued"),{now:9}).code,"CHECKPOINT_LIVENESS_TIMEOUT");
});
test("used budget survives a new resume watchdog and exhaustion gets bounded settlement",()=>{
  const watch=monitor();assert.equal(watch.observe(checkpoint(20,"generating",99),{now:0}),undefined);
  assert.equal(watch.observe(checkpoint(21,"executing",100),{now:1}),undefined);
  assert.equal(watch.observe(checkpoint(22,"executing",101),{now:6}),undefined);
  assert.equal(watch.observe(checkpoint(23,"executing",102),{now:7}).code,"ACTIVE_BUDGET_SETTLEMENT_TIMEOUT");
});
test("an old paused snapshot cannot be treated as completion and newer active revision resets teardown wait",()=>{
  const watch=monitor();assert.equal(watch.observe(checkpoint(20,"paused",50),{now:0}),undefined);
  assert.equal(watch.observe(checkpoint(21,"preparing",51),{now:5}),undefined);
  assert.equal(watch.observe(checkpoint(22,"generating",52),{now:10}),undefined);
  assert.equal(watch.observe(checkpoint(23,"paused",53),{now:15}),undefined);
  assert.equal(watch.observe(checkpoint(23,"paused",53),{now:21}).code,"TERMINAL_SETTLEMENT_TIMEOUT");
});
test("checkpoint identity changes and budget refunds fail explicitly",()=>{
  for(const next of [{...checkpoint(2),contract:{runId:"other",budgets:{activeTimeMs:100}}},checkpoint(0),checkpoint(2,"generating",0),checkpoint(2,"generating",1,200)]){
    const watch=monitor();watch.observe(checkpoint(1),{now:0});assert.match(watch.observe(next,{now:1}).code,/CHANGED|REGRESSED/);
  }
});
test("owned cleanup has an independent outer deadline",async()=>{
  assert.equal(await boundedSettlement(Promise.resolve("stopped"),50),"stopped");
  await assert.rejects(boundedSettlement(new Promise(()=>{}),10),error=>error.code==="OWNED_CLEANUP_TIMEOUT");
});
