import assert from "node:assert/strict";
import test from "node:test";
import {
  claimCitationIdentity, claimScope, claimSourceReviewState, continueNewClaimDraft, createClaimDraftCache,
  createClaimRequestGate, matchesClaimSourceRead, textareaSourceSelection,
} from "../src/renderer/research-claim-selection.ts";

function source(overrides={}) {
  return {documentId:"doc",documentRevision:2,documentName:"study.md",kind:"text",
    documentSha256:"a".repeat(64),unitSha256:"b".repeat(64),sourcePath:null,sourceSha256:null,
    originalSourcePath:null,originalSourceSha256:null,extractionPath:null,extractionSha256:null,
    textArtifactPath:null,textArtifactSha256:null,unitIndex:0,locator:"Editable text",totalUnits:1,
    totalCharacters:100,readId:"read-1",unitText:"mean 8",textStart:10,textEnd:16,
    readingScope:{unitIndices:[0],start:10,end:16,offsetUnit:"utf16-code-units",fullDocument:false,meaning:"returned-source-range-only"},...overrides};
}
const expected={documentId:"doc",documentRevision:2,unitIndex:0,startOffset:10};

test("browser-normalized textarea selection maps CRLF and CR back to original source offsets",()=>{
  const original="A\r\nB\rC 🧪",displayed="A\nB\nC 🧪";
  assert.deepEqual(textareaSourceSelection(original,displayed,2,5),{start:3,end:6,quote:"B\rC"});
  assert.deepEqual(textareaSourceSelection(original,displayed,0,3),{start:0,end:4,quote:"A\r\nB"});
  assert.deepEqual(textareaSourceSelection(original,displayed,6,8),{start:7,end:9,quote:"🧪"});
  assert.equal(textareaSourceSelection(original,displayed,6,7),undefined);
  assert.equal(textareaSourceSelection(original,"different text",0,3),undefined);
});
function draft() {
  return {revision:7,text:"Unsaved conclusion",citations:[
    {key:"new",input:{readId:"host-secret-token",start:0,end:6,quote:"mean 8",relation:"supports"},title:"study.md",quote:"mean 8",bindingKey:"source-range"},
    {key:"saved",input:{evidenceId:"evidence-1",relation:"context"},title:"retained",quote:"saved text",bindingKey:"old-range"},
  ]};
}

test("late source responses cannot replace a newer read, even after returning to an earlier scope", async()=>{
  const a=claimScope("workspace-A","same-session"),b=claimScope("workspace-B","same-session");
  const gate=createClaimRequestGate(a);
  let resolveFirst;const firstResponse=new Promise(resolve=>{resolveFirst=resolve;});
  const first=gate.begin("read");
  const firstApplied=firstResponse.then(()=>gate.accepts(first));
  const second=gate.begin("read");assert.equal(gate.accepts(second),true);
  resolveFirst();assert.equal(await firstApplied,false);
  gate.activate(b);assert.equal(gate.accepts(second),false);
  gate.activate(a);assert.equal(gate.accepts(second),false);
  assert.equal(gate.accepts(gate.begin("read")),true);
});

test("mutation acknowledgements are isolated from session changes and unmount/remount",()=>{
  const gate=createClaimRequestGate(claimScope("workspace","session-A"));
  const save=gate.begin("mutation");gate.activate(claimScope("workspace","session-B"));
  assert.equal(gate.accepts(save),false);
  const review=gate.begin("mutation");gate.dispose();assert.equal(gate.accepts(review),false);
  gate.activate(claimScope("workspace","session-B"));assert.equal(gate.accepts(review),false);
  const current=gate.begin("mutation");gate.invalidateRead();assert.equal(gate.accepts(current),true);
});

test("source response requires the requested revision, exact returned range and explicitly partial scope",()=>{
  assert.equal(matchesClaimSourceRead(source(),expected),true);
  for(const change of [{documentId:"other"},{documentRevision:3},{unitIndex:1},{textStart:11},{textEnd:17},
    {totalCharacters:15},{totalUnits:0},{documentSha256:"invalid"},{unitText:"x".repeat(12001)},
    {readingScope:{...source().readingScope,fullDocument:true}},
    {readingScope:{...source().readingScope,end:100}},
    {readingScope:{...source().readingScope,unitIndices:undefined}}]) {
    assert.equal(matchesClaimSourceRead(source(change),expected),false,JSON.stringify(change));
  }
});

test("citation identity ignores read tokens and window placement but preserves source hashes and absolute occurrence",()=>{
  const first=source();const second=source({readId:"read-2",textStart:8,unitText:"x mean 8",textEnd:16});
  assert.equal(claimCitationIdentity(first,first.textStart,first.textEnd),claimCitationIdentity(second,second.textStart+2,second.textEnd));
  for(const changed of [source({unitSha256:"c".repeat(64)}),source({locator:"Page 2"}),source({documentRevision:3}),source({sourceSha256:"d".repeat(64)})])
    assert.notEqual(claimCitationIdentity(first,10,16),claimCitationIdentity(changed,10,16));
  assert.notEqual(claimCitationIdentity(first,10,16),claimCitationIdentity(first,30,36));
});

test("temporary draft restoration preserves text, revision and saved evidence but never restores source tokens",()=>{
  const cache=createClaimDraftCache();const original=draft();const scope=claimScope("workspace","session");
  cache.set(scope,original);const restored=cache.get(scope);
  assert.equal(restored.text,original.text);assert.equal(restored.revision,7);
  assert.equal(restored.citations[0].input.readId,"");assert.equal(restored.citations[0].needsReread,true);
  assert.equal(restored.citations[1].input.evidenceId,"evidence-1");assert.equal(restored.citations[1].needsReread,undefined);
  assert.equal(original.citations[0].input.readId,"host-secret-token");
  restored.text="Changed clone";assert.equal(cache.get(scope).text,original.text);
  assert.equal(cache.get(claimScope("other-workspace","session")),undefined);
  cache.set(scope,undefined);assert.equal(cache.get(scope),undefined);
});

test("explicit continuation retains new-claim text at a newer revision and clears unsaved tokens without rebasing existing claims",()=>{
  const original=draft();original.citations=original.citations.slice(0,1);
  const continued=continueNewClaimDraft(original,8);
  assert.equal(continued.text,original.text);assert.equal(continued.revision,8);
  assert.equal(continued.citations[0].input.readId,"");assert.equal(continued.citations[0].needsReread,true);
  assert.equal(original.revision,7);assert.equal(original.citations[0].input.readId,"host-secret-token");
  assert.throws(()=>continueNewClaimDraft({...original,id:"existing-claim"},8));
  assert.throws(()=>continueNewClaimDraft(original,7));assert.throws(()=>continueNewClaimDraft(original,NaN));
});

test("draft cache is bounded, scopes cannot collide, and eviction is explicitly reported",()=>{
  const cache=createClaimDraftCache(2);
  const a=claimScope("a:b","c"),b=claimScope("a","b:c"),c=claimScope("x","y");assert.notEqual(a,b);
  assert.equal(cache.set(a,draft()),false);assert.equal(cache.set(b,draft()),false);
  cache.get(a);assert.equal(cache.set(c,draft()),true);
  assert.equal(cache.get(b),undefined);assert.ok(cache.get(a));assert.ok(cache.get(c));
  assert.throws(()=>createClaimDraftCache(0));
});

test("verification-budget exhaustion is pending and permits a host recheck without recertifying failures",()=>{
  const current={freshness:{status:"current",code:"SOURCE_MATCH"}};
  const pending={freshness:{status:"unavailable",code:"VERIFICATION_BUDGET"}};
  const check=evidence=>claimSourceReviewState({evidence});
  assert.deepEqual(check([current]),{status:"current",canReview:true});
  assert.deepEqual(check([current,pending]),{status:"pending",canReview:true});
  assert.deepEqual(check([pending,{freshness:{status:"unavailable",code:"SOURCE_UNAVAILABLE"}}]),{status:"unavailable",canReview:false});
  assert.deepEqual(check([pending,{...current,invalidated:{code:"OLD_CHANGED_SOURCE"}}]),{status:"stale",canReview:false});
  assert.deepEqual(check([{}]),{status:"pending",canReview:false});
  assert.deepEqual(check([]),{status:"unavailable",canReview:false});
});
