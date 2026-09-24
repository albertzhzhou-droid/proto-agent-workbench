import test from "node:test";
import assert from "node:assert/strict";
import { admittedChemRoute, chemParentOrigin, chemRouteLimit } from "../src/main/services/chem-workbench.ts";

test("Chem bridge retains the exact workflow API and request ceilings",()=>{
  for(const path of ["/api/design/run","/api/design/export-interface","/api/workflow/refinement/prepare","/api/workflow/refinement/approve","/api/structure/compare","/api/xdl/inspect"])assert.equal(admittedChemRoute("POST",path),true);
  for(const path of ["/api/design/run/../tool","/api/tool?path=elsewhere","/api/execute","/api/xdl/execute","/exports/../secrets","/src/chem_workbench/web.py"])assert.equal(admittedChemRoute("POST",path),false);
  assert.equal(admittedChemRoute("GET","/api/workflow/approve"),false);
  assert.equal(chemRouteLimit("/api/design/import"),20*1024*1024);
  assert.equal(chemRouteLimit("/api/export/png"),3_000_000);
  assert.equal(chemRouteLimit("/api/compile"),512*1024);
  assert.equal(chemRouteLimit("/api/xdl/inspect"),200*1024);
});
test("Chem embedding origin is local and cannot inject CSP or remote frames",()=>{
  assert.equal(chemParentOrigin("http://127.0.0.1:5187"),"http://127.0.0.1:5187");
  assert.equal(chemParentOrigin("file:"),"file:");
  for(const origin of ["https://example.com","http://127.0.0.1:5187/anything","http://127.0.0.1:5187; *","data:text/html,test","http://user@127.0.0.1:5187"])assert.throws(()=>chemParentOrigin(origin));
});
