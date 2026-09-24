import assert from "node:assert/strict";
import test from "node:test";
import { canAcceptResearchSession, isCurrentResearchSelection } from "../src/renderer/research-chat-client-state.ts";
import { emptyResearchState, RESEARCH_SESSION_SCHEMA } from "../src/shared/research-session-state.ts";

const session=(revision=1,id="session-a")=>({id,title:"Synthetic session",createdAt:"2026-09-22T00:00:00Z",
  updatedAt:"2026-09-22T00:00:00Z",status:"idle",messages:[],documents:[],payloadSchema:RESEARCH_SESSION_SCHEMA,
  revision,researchState:emptyResearchState()});
const legacy=(id="session-a",updatedAt="2026-09-22T00:00:00Z")=>({id,title:"Legacy synthetic session",
  createdAt:"2026-09-22T00:00:00Z",updatedAt,status:"idle",messages:[],documents:[]});
const token=(selectionGeneration=1,sessionId="session-a",workspaceGeneration=0)=>({workspaceGeneration,selectionGeneration,sessionId});

test("same-session responses advance monotonically and allow idempotent rereads",()=>{
  const current=session(7),before=structuredClone(current);
  assert.equal(canAcceptResearchSession(current,session(6)),false);
  assert.equal(canAcceptResearchSession(current,session(7)),true);
  assert.equal(canAcceptResearchSession(current,session(8)),true);
  assert.equal(canAcceptResearchSession(current,session(100,"session-b")),false);
  assert.deepEqual(current,before);
});

test("a late successful save response remains usable without rolling back a newer poll",async()=>{
  let cached=session(9);
  const completedSave={session:session(8)};
  const request=async()=>{
    const response=await Promise.resolve(completedSave);
    if(canAcceptResearchSession(cached,response.session))cached=response.session;
    return response;
  };
  const response=await request();
  assert.strictEqual(response,completedSave);
  assert.equal(response.session.revision,8);
  assert.equal(cached.revision,9);
});

test("valid migration is one way and legacy cannot replace versioned state",()=>{
  assert.equal(canAcceptResearchSession(legacy(),session(1)),true);
  assert.equal(canAcceptResearchSession(session(1),legacy("session-a","2099-01-01T00:00:00Z")),false);
  assert.equal(canAcceptResearchSession(undefined,session(1)),true);
  assert.equal(canAcceptResearchSession(undefined,legacy()),true);
});

test("unknown or partial schemas and invalid revision counters cannot enter the cache",()=>{
  for(const incoming of [
    {...session(),payloadSchema:"future.schema"},
    {...session(),payloadSchema:undefined},
    {...session(),revision:undefined},
    {...legacy(),researchState:emptyResearchState()},
    ...[0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,"2"].map(revision=>session(revision)),
  ]){
    assert.equal(canAcceptResearchSession(undefined,incoming),false);
    assert.equal(canAcceptResearchSession(session(1),incoming),false);
  }
  assert.equal(canAcceptResearchSession(session(Number.MAX_SAFE_INTEGER),session(Number.MAX_SAFE_INTEGER)),true);
});

test("revision order takes precedence over timestamps for versioned producers",()=>{
  assert.equal(canAcceptResearchSession({...session(10),updatedAt:"2026-09-21T00:00:00Z"},
    {...session(9),updatedAt:"2026-09-23T00:00:00Z"}),false);
  assert.equal(canAcceptResearchSession({...session(9),updatedAt:"2026-09-23T00:00:00Z"},
    {...session(10),updatedAt:"2026-09-21T00:00:00Z"}),true);
});

test("legacy producers retain timestamp monotonicity without pretending to have revisions",()=>{
  assert.equal(canAcceptResearchSession(legacy("session-a","2026-09-23T00:00:00Z"),legacy()),false);
  assert.equal(canAcceptResearchSession(legacy(),legacy()),true);
  assert.equal(canAcceptResearchSession(legacy(),legacy("session-a","2026-09-23T00:00:00Z")),true);
  assert.equal(canAcceptResearchSession(legacy(),legacy("session-a","not-a-time")),false);
});

test("latest selection token rejects out-of-order A to B and A to B to A returns",()=>{
  const originalA=token(1,"session-a"),selectB=token(2,"session-b"),latestA=token(3,"session-a");
  assert.equal(isCurrentResearchSelection(originalA,selectB,"session-a"),false);
  assert.equal(isCurrentResearchSelection(originalA,latestA,"session-a"),false);
  assert.equal(isCurrentResearchSelection(selectB,latestA,"session-b"),false);
  assert.equal(isCurrentResearchSelection(latestA,latestA,"session-a"),true);
  assert.equal(isCurrentResearchSelection(latestA,latestA,"session-b"),false);
});

test("workspace reset invalidates old selections even when counters and session IDs are reused",()=>{
  assert.equal(isCurrentResearchSelection(token(1,"session-a",1),token(1,"session-a",2),"session-a"),false);
  assert.equal(isCurrentResearchSelection(token(1,"session-a",2),token(1,"session-a",2)),true);
});

test("failed selections use the same token guard before updating visible errors",()=>{
  const previous=token(1),current=token(2,"session-b");let error;
  if(isCurrentResearchSelection(previous,current))error="Late failure from session-a";
  assert.equal(error,undefined);
  if(isCurrentResearchSelection(current,current))error="Current failure from session-b";
  assert.equal(error,"Current failure from session-b");
});

test("malformed token counters and empty identities fail closed",()=>{
  for(const malformed of [{...token(),workspaceGeneration:-1},{...token(),selectionGeneration:Infinity},
    {...token(),selectionGeneration:Number.MAX_SAFE_INTEGER+1},{...token(),sessionId:""},{...token(),sessionId:" "}]){
    assert.equal(isCurrentResearchSelection(malformed,token()),false);
    assert.equal(isCurrentResearchSelection(token(),malformed),false);
  }
});
