import test from "node:test";
import assert from "node:assert/strict";
import {checkProviderCitations,checkRecordEvidence,returnedPublicationIdentifiers,classifyAcceptanceOutcome,evaluateMatrixAcceptance} from "../scripts/harness-acceptance-checks.mjs";
test("acceptance supports exact Crossref source_id and identifiers fields as well as PubMed IDs",()=>{
  const receipts=[{tool:"proto_pubmed_search",ok:true,data:{matches:[{pmid:"12345",doi:"10.1234/pubmed"}]}},{tool:"proto_crossref_search",ok:true,data:{matches:[{source_id:"DOI:10.1234/crossref",identifiers:["DOI:10.1234/crossref"]}]}}];
  assert.equal(checkProviderCitations(receipts,"PMID:12345 DOI:10.1234/crossref"),true);
  assert.equal(checkProviderCitations(receipts,"PMID:12345 DOI:10.1234/not-returned"),false);
  assert.equal(checkProviderCitations([{...receipts[0],ok:false},receipts[1]],"PMID:12345 DOI:10.1234/crossref"),false);
  assert.deepEqual(returnedPublicationIdentifiers({description:"DOI:10.1234/description-is-not-an-identifier"}),[]);
});
test("planned pause is separately counted as repair; journal and instance recovery stay excluded",()=>{
  const base={passed:true,finalState:"completed",hostRecovered:false,recoveryCounters:{resumes:1},intentionalCheckpointResume:true};
  assert.equal(classifyAcceptanceOutcome(base),"success_after_retry_or_repair");
  assert.equal(classifyAcceptanceOutcome({...base,intentionalCheckpointResume:false}),"host_recovery");
  assert.equal(classifyAcceptanceOutcome({...base,recoveryCounters:{resumes:1,journalReconciliations:1}}),"host_recovery");
  assert.equal(classifyAcceptanceOutcome({...base,recoveryCounters:{resumes:1,instanceRebinds:1}}),"host_recovery");
  assert.equal(classifyAcceptanceOutcome({...base,passed:false}),"false_completion");
});
test("requested material evidence requires actual full sequence hash, source identity and license citation",()=>{
  const records=[{resource_id:"eligible:A",sequence_sha256:"a".repeat(64),source:{record_id:"record-A",url:"https://example.invalid/A"},license:{id:"CC-BY-4.0"}}];
  assert.equal(checkRecordEvidence(records,`eligible:A ${"a".repeat(64)} record-A CC-BY-4.0`,true),true);
  assert.equal(checkRecordEvidence(records,"eligible:A record-A CC-BY-4.0",true),false);
  assert.equal(checkRecordEvidence(records,`eligible:A ${"a".repeat(64)} record-A invented-license`,true),false);
  assert.equal(checkRecordEvidence(records,"eligible:A https://example.invalid/A CC-BY-4.0"),true);
});
test("matrix gate distinguishes 57-of-60 threshold from strict all-pass and rejects any false completion or core-family miss",()=>{
  const families=["governed_dna","governed_protein",...Array.from({length:10},(_,i)=>`family-${i}`)];
  const scenarios=families.flatMap(id=>Array.from({length:5},(_,i)=>({id,repeat:i+1})));
  const results=scenarios.map(item=>({family:item.id,repeat:item.repeat,status:"passed",outcome:"direct_success",checks:{noHostFallback:true}}));
  for(let i=57;i<60;i++)results[i]={...results[i],status:"failed",outcome:"incomplete"};
  assert.equal(evaluateMatrixAcceptance(results,scenarios).passed,true);
  assert.equal(evaluateMatrixAcceptance(results,scenarios).allCasesPassed,false);
  assert.equal(evaluateMatrixAcceptance(results,scenarios,false).passed,false);
  assert.equal(evaluateMatrixAcceptance(results.slice(0,-1),scenarios).passed,false);
  assert.equal(evaluateMatrixAcceptance([...results.slice(0,-1),results[0]],scenarios).passed,false);
  const falseGreen=results.map((r,i)=>i===59?{...r,outcome:"false_completion"}:r);
  assert.equal(evaluateMatrixAcceptance(falseGreen,scenarios).passed,false);
  const missingDna=results.map((r,i)=>i===0?{...r,status:"failed",outcome:"incomplete"}:i===59?{...r,status:"passed",outcome:"direct_success"}:r);
  assert.equal(evaluateMatrixAcceptance(missingDna,scenarios).passed,false);
  const host=results.map((r,i)=>i===0?{...r,outcome:"host_recovery"}:r);
  assert.equal(evaluateMatrixAcceptance(host,scenarios).modelSuccesses,56);
});
