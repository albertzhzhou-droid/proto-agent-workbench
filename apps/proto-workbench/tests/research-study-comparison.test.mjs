import assert from "node:assert/strict";
import test from "node:test";
import {compareStudyJson,displayComparedValue,createStudyRequestScope} from "../src/renderer/research-study-comparison.ts";

test("field comparison preserves types, units, missing keys and array order",()=>{
  const result=compareStudyJson({value:1,unit:"mg",rows:[1,2],optional:null},{value:"1",unit:"g",rows:[2,1]});
  const rows=new Map(result.rows.map(row=>[row.pointer,row]));
  assert.equal(rows.get("/value").changed,true);assert.equal(rows.get("/value").left.kind,"number");assert.equal(rows.get("/value").right.kind,"string");
  assert.equal(rows.get("/unit").changed,true);assert.equal(rows.get("/rows/0").changed,true);
  assert.equal(rows.get("/optional").left.kind,"null");assert.equal(rows.get("/optional").right.kind,"missing");
  assert.equal(result.truncated,false);
});
test("comparison uses unambiguous JSON pointers and treats object key order as presentation only",()=>{
  const result=compareStudyJson({"a/b":{"x~y":2},b:1},{b:1,"a/b":{"x~y":2}});
  assert.equal(result.rows[0].pointer,"/a~1b/x~0y");assert.ok(result.rows.every(row=>!row.changed));
});
test("comparison bounds large matrices and reports that undisplayed fields were not compared",()=>{
  const result=compareStudyJson({matrix:Array.from({length:384},()=>Array(384).fill(0))},{matrix:Array.from({length:384},()=>Array(384).fill(1))},50);
  assert.equal(result.rows.length,50);assert.equal(result.truncated,true);
  assert.match(displayComparedValue({kind:"string",value:"x".repeat(2000)}),/display truncated/);
  assert.equal(displayComparedValue({kind:"missing"}),"Not present");assert.throws(()=>compareStudyJson({}, {}, 0));
});
test("empty containers and null remain distinct without a scientific equivalence verdict",()=>{
  assert.equal(compareStudyJson([],{}).rows[0].changed,true);
  assert.equal(compareStudyJson({},{}).rows[0].changed,false);
  assert.equal(compareStudyJson(null,{}).rows[0].changed,true);
});
test("depth-bounded comparisons do not silently stringify or certify omitted subtrees",()=>{
  const deep=value=>Array.from({length:13}).reduce(result=>({nested:result}),value);
  const result=compareStudyJson(deep({a:1,b:2}),deep({b:2,a:1}));
  assert.equal(result.truncated,true);assert.equal(result.rows.length,0);
  assert.equal(compareStudyJson({a:1,b:2},{b:2,a:1}).rows.every(row=>!row.changed),true);
  assert.equal(compareStudyJson(1,1).rows[0].pointer,"");
  assert.equal(compareStudyJson({"":1},{"":2}).rows[0].pointer,"/");
  assert.equal(displayComparedValue({kind:"number",value:-0}),"-0");
});
test("request scopes reject old workspaces, old selections, and out-of-order responses",()=>{
  const scope=createStudyRequestScope();scope.activate("A");const first=scope.begin("runs"),second=scope.begin("runs");
  assert.equal(scope.current(first),false);assert.equal(scope.current(second),true);
  scope.select();assert.equal(scope.current(second),false);assert.equal(scope.current(second,false),true);
  scope.activate("B");scope.activate("A");assert.equal(scope.current(second,false),false);
});
