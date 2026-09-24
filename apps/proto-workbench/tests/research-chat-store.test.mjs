import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Exercise the real Zustand store, substituting only its desktop API boundary.
registerHooks({load(url,context,nextLoad){
  if(url.endsWith("/renderer/mock-api.ts"))return {format:"module",shortCircuit:true,
    source:"export const workbenchApi = () => globalThis.__researchChatStoreTestApi;"};
  return nextLoad(url,context);
}});
const {useResearchChat:store}=await import("../src/renderer/research-chat-store.ts");
const {RESEARCH_SESSION_SCHEMA,emptyResearchState}=await import("../src/shared/research-session-state.ts");
const session=(id,revision=1)=>({id,title:id,createdAt:"2026-09-22T00:00:00Z",updatedAt:"2026-09-22T00:00:00Z",
  status:"idle",messages:[],documents:[],payloadSchema:RESEARCH_SESSION_SCHEMA,revision,researchState:emptyResearchState()});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const install=request=>{store.getState().reset();globalThis.__researchChatStoreTestApi={chat:{request}};};
const fallback=async input=>{
  if(input.action==="get")return {session:session(input.sessionId)};
  if(input.action==="list")return {sessions:[]};
  throw new Error(`Unexpected request ${input.action}`);
};

test("selection while implicit creation is pending cancels the undispatched send",async()=>{
  const creation=deferred(),sends=[];
  install(input=>input.action==="create"?creation.promise:input.action==="send"?(sends.push(input),Promise.resolve({})):fallback(input));
  store.getState().setDraft("Prompt intended for a new conversation");
  const sending=store.getState().send();
  await store.getState().select("B");
  store.getState().setDraft("B draft");
  creation.resolve({session:session("new-A")});
  await sending;
  assert.deepEqual(sends,[]);
  assert.equal(store.getState().session.id,"B");
  assert.equal(store.getState().draft,"B draft");
  assert.equal(store.getState().busy,false);
});

test("implicit creation freezes send inputs and retains a newly edited same-session draft",async()=>{
  const creation=deferred(),sends=[];
  install(input=>input.action==="create"?creation.promise:input.action==="send"?(sends.push(input),Promise.resolve({session:session("created",2)})):fallback(input));
  store.setState({draft:" Original prompt ",selectedModel:"original-model",selectedDocuments:["original-document"],workflow:"analysis",toolsEnabled:false,networkEnabled:true,codeExecutionEnabled:true});
  const sending=store.getState().send();
  store.setState({draft:"New unsent text",selectedModel:"changed-model",selectedDocuments:["other-document"],workflow:"explore",toolsEnabled:true});
  creation.resolve({session:session("created")});
  await sending;
  assert.deepEqual(sends,[{action:"send",sessionId:"created",modelId:"original-model",content:"Original prompt",documentIds:["original-document"],workflow:"analysis",toolsEnabled:false,networkEnabled:true,codeExecutionEnabled:true}]);
  assert.equal(store.getState().draft,"New unsent text");
  assert.equal(store.getState().busy,false);
});

test("a late dispatched A send cannot clear B draft or roll its cached session back",async()=>{
  const completion=deferred();
  install(input=>input.action==="send"?completion.promise:fallback(input));
  await store.getState().select("A");store.getState().setDraft("Send to A");
  const sending=store.getState().send();
  await store.getState().select("B");store.getState().setDraft("Unsaved B draft");
  completion.resolve({session:session("A",2)});await sending;
  assert.equal(store.getState().session.id,"B");
  assert.equal(store.getState().draft,"Unsaved B draft");
  assert.equal(store.getState().busy,false);
});

test("a failed old send cannot publish errors or clear a newer send's busy flag",async()=>{
  const first=deferred(),second=deferred();
  install(input=>input.action==="send"?(input.sessionId==="A"?first.promise:second.promise):fallback(input));
  await store.getState().select("A");store.getState().setDraft("A prompt");const a=store.getState().send();
  await store.getState().select("B");store.getState().setDraft("B prompt");const b=store.getState().send();
  first.reject(new Error("Old A failure"));await a;
  assert.equal(store.getState().session.id,"B");assert.equal(store.getState().error,undefined);
  assert.equal(store.getState().busy,true);assert.equal(store.getState().draft,"B prompt");
  second.resolve({session:session("B",2)});await b;
  assert.equal(store.getState().busy,false);assert.equal(store.getState().draft,"");
});

test("old A poll errors stay scoped to their original selection",async()=>{
  const poll=deferred();let delayed=false;
  install(input=>input.action==="get"&&input.sessionId==="A"&&delayed?poll.promise:fallback(input));
  await store.getState().select("A");delayed=true;
  const refreshing=store.getState().refresh();await new Promise(resolve=>setImmediate(resolve));
  await store.getState().select("B");poll.reject(new Error("Old A poll failure"));await refreshing;
  assert.equal(store.getState().session.id,"B");assert.equal(store.getState().error,undefined);
});

test("a selection change during list refresh skips the obsolete session get",async()=>{
  const list=deferred(),gets=[];
  install(input=>input.action==="list"?list.promise:input.action==="get"?(gets.push(input.sessionId),fallback(input)):fallback(input));
  await store.getState().select("A");const refreshing=store.getState().refresh();
  await store.getState().select("B");list.resolve({sessions:[]});await refreshing;
  assert.deepEqual(gets,["A","B"]);
});

test("workspace reset cancels an implicit send without poisoning the new workspace",async()=>{
  const creation=deferred(),sends=[];
  install(input=>input.action==="create"?creation.promise:input.action==="send"?(sends.push(input),Promise.resolve({})):fallback(input));
  store.getState().setDraft("Old workspace draft");const sending=store.getState().send();
  store.getState().reset();await store.getState().select("New workspace session");
  store.getState().setDraft("New workspace draft");creation.resolve({session:session("Old created session")});await sending;
  assert.deepEqual(sends,[]);assert.equal(store.getState().session.id,"New workspace session");
  assert.equal(store.getState().draft,"New workspace draft");assert.equal(store.getState().error,undefined);assert.equal(store.getState().busy,false);
});

test("late create failure and cancel failure cannot attach errors to another session",async()=>{
  const creation=deferred(),cancellation=deferred();
  install(input=>input.action==="create"?creation.promise:input.action==="cancel"?cancellation.promise:fallback(input));
  await store.getState().select("A");const cancelling=store.getState().cancel(),creating=store.getState().newChat();
  await store.getState().select("B");creation.reject(new Error("Old create failure"));cancellation.reject(new Error("Old cancel failure"));
  await Promise.all([creating,cancelling]);
  assert.equal(store.getState().session.id,"B");assert.equal(store.getState().error,undefined);assert.equal(store.getState().busy,false);
});

test("late successful state saves remain available to callers without regressing a newer cache",async()=>{
  const saving=deferred();
  install(input=>input.action==="research_state"?saving.promise:fallback(input));
  await store.getState().select("A");
  const requested=store.getState().request({action:"research_state",sessionId:"A",expectedRevision:1,state:emptyResearchState()});
  store.setState({session:session("A",3)});saving.resolve({session:session("A",2)});
  const response=await requested;assert.equal(response.session.revision,2);assert.equal(store.getState().session.revision,3);
});

test("A to B to A reselection rejects an old poll's response even if its revision is higher",async()=>{
  const polling=deferred();let delayNextGet=false;
  install(input=>{
    if(input.action==="get"&&delayNextGet){delayNextGet=false;return polling.promise;}
    return fallback(input);
  });
  await store.getState().select("A");delayNextGet=true;
  const old=store.getState().request({action:"get",sessionId:"A"});
  await store.getState().select("B");await store.getState().select("A");
  store.setState({error:"Error owned by the latest selection"});
  polling.resolve({session:session("A",9)});const response=await old;
  assert.equal(response.session.revision,9);
  assert.equal(store.getState().session.revision,1);
  assert.equal(store.getState().error,"Error owned by the latest selection");
});

test("in-scope failures release busy and remain visible to the current session",async()=>{
  install(input=>input.action==="send"?Promise.reject(new Error("Current model failure")):fallback(input));
  await store.getState().select("A");store.getState().setDraft("Retryable prompt");await store.getState().send();
  assert.equal(store.getState().error,"Current model failure");assert.equal(store.getState().draft,"Retryable prompt");assert.equal(store.getState().busy,false);
});
