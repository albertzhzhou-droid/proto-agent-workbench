import { useEffect, useRef, useState } from "react";
import { BookOpen, Plus, Save, X } from "lucide-react";
import type { ResearchChatApi, ResearchChatSession } from "../shared/research-chat.ts";
import { RESEARCH_CLAIM_LIMITS, type ResearchClaim, type ResearchClaimEvidence, type ResearchClaimRelation, type ResearchClaimSourceRead } from "../shared/research-claims.ts";
import { claimCitationIdentity, claimScope, claimSourceReviewState, continueNewClaimDraft, createClaimDraftCache, createClaimRequestGate, matchesClaimSourceRead, quoteOccurrences, sourceSelection, textareaSourceSelection, type ClaimDraft, type QuoteRange } from "./research-claim-selection.ts";
import "./research-claims.css";

const relationNames = {supports:"Supports",contradicts:"Contradicts",context:"Context"};
const drafts = createClaimDraftCache(16);
type ClaimsPanelProps = {
  workspace:string; session:ResearchChatSession; request:ResearchChatApi["request"]; onClose():void; onDocuments():void;
};

export function ResearchClaimsPanel(props:ClaimsPanelProps) {
  return <ScopedResearchClaimsPanel key={claimScope(props.workspace,props.session.id)} {...props}/>;
}

function ScopedResearchClaimsPanel({workspace,session,request,onClose,onDocuments}:ClaimsPanelProps) {
  const scope=claimScope(workspace,session.id);
  const [draft,setDraft]=useState<ClaimDraft|undefined>(()=>drafts.get(scope));
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState("");
  const [documentId,setDocumentId]=useState(session.documents[0]?.id??"");
  const [unitIndex,setUnitIndex]=useState(0),[startOffset,setStartOffset]=useState(0);
  const [source,setSource]=useState<ResearchClaimSourceRead>();
  const [quote,setQuote]=useState(""),[selectedRange,setSelectedRange]=useState<QuoteRange>();
  const [relation,setRelation]=useState<ResearchClaimRelation>("supports");
  const gate=useRef(createClaimRequestGate(scope)).current;
  const mutationPending=useRef(false);
  useEffect(()=>{gate.activate(scope);return()=>gate.dispose();},[gate,scope]);
  useEffect(()=>{if(drafts.set(scope,draft))setError("The oldest inactive draft was removed from the temporary 16-conversation cache.");},[scope,draft]);
  const claims=session.claims??[];
  const document=session.documents.find(item=>item.id===documentId);
  const currentDocument=useRef(document);currentDocument.current=document;
  const locked=busy||session.status==="generating";
  const conflict=!!draft&&draft.revision!==session.revision;
  const currentClaim=draft?.id?claims.find(item=>item.id===draft.id):undefined;
  const missingCitations=draft?.citations.filter(item=>"evidenceId" in item.input&&!currentClaim?.evidence.some(evidence=>"evidenceId" in item.input&&evidence.id===item.input.evidenceId))??[];
  const needsReread=draft?.citations.some(item=>item.needsReread)??false;
  const occurrences=quoteOccurrences(source?.unitText??"",quote);
  const activeRange=selectedRange?.quote===quote?selectedRange:occurrences.ranges.length===1?occurrences.ranges[0]:undefined;
  const validRange=source&&source.documentRevision===document?.revision&&source.documentId===documentId&&activeRange&&sourceSelection(source.unitText,activeRange.start,activeRange.end)?.quote===quote;
  const invalidateRead=()=>{gate.invalidateRead();setLoading(false);setSource(undefined);setQuote("");setSelectedRange(undefined);};
  useEffect(()=>{invalidateRead();},[documentId,document?.revision]);
  useEffect(()=>{if(!session.documents.some(item=>item.id===documentId)){invalidateRead();setDocumentId(session.documents[0]?.id??"");setUnitIndex(0);setStartOffset(0);}},[session.documents,documentId]);
  const begin=(claim?:ResearchClaim)=>{
    invalidateRead();setError("");setDraft({id:claim?.id,revision:session.revision??0,text:claim?.text??"",citations:claim?.evidence.map(item=>({key:item.id,input:{evidenceId:item.id,relation:item.relation},title:`${item.source.documentName} · ${item.source.locator}`,quote:item.source.excerpt,bindingKey:claimCitationIdentity(item.source,item.source.quoteStart,item.source.quoteEnd)}))??[]});
  };
  async function readSource() {
    if(!document||locked)return;
    const token=gate.begin("read");
    const expected={documentId,documentRevision:document.revision,unitIndex,startOffset};
    setLoading(true);setError("");setSource(undefined);setQuote("");setSelectedRange(undefined);
    try {
      const result=await request({action:"claim_source",sessionId:session.id,documentId,unitIndex,startOffset});
      if(!gate.accepts(token))return;
      const next=result.claimSource;
      if(currentDocument.current?.id!==documentId||currentDocument.current.revision!==expected.documentRevision||!matchesClaimSourceRead(next,expected))
        throw new Error("The source reader returned a different document revision or range. Read it again.");
      setSource(next);
    }catch(value){if(gate.accepts(token))setError(value instanceof Error?value.message:String(value));}
    finally{if(gate.accepts(token))setLoading(false);}
  }
  function addCitation() {
    if(locked||!draft||!source||!activeRange||!validRange||quote.length>RESEARCH_CLAIM_LIMITS.quoteCharacters||draft.citations.length>=RESEARCH_CLAIM_LIMITS.evidence)return;
    const bindingKey=claimCitationIdentity(source,source.textStart+activeRange.start,source.textStart+activeRange.end);
    if(draft.citations.some(item=>item.bindingKey===bindingKey)){setError("This exact source passage is already in the draft. Edit its relation, or remove it before reading its replacement.");return;}
    setDraft({...draft,citations:[...draft.citations,{key:crypto.randomUUID(),input:{readId:source.readId,...activeRange,relation},title:`${source.documentName} · ${source.locator}`,quote,bindingKey}]});
    setQuote("");setSelectedRange(undefined);setError("");
  }
  async function save() {
    if(!draft||locked||mutationPending.current||conflict||needsReread||missingCitations.length||!draft.revision||!draft.text.trim())return;
    mutationPending.current=true;const token=gate.begin("mutation");setBusy(true);setError("");
    try {
      const result=await request({action:"claim_save",sessionId:session.id,expectedRevision:draft.revision,...(draft.id?{claimId:draft.id}:{}),text:draft.text,evidence:draft.citations.map(item=>item.input)});
      if(!gate.accepts(token))return;
      if(result.session?.id!==session.id||!result.session.revision||result.session.revision<=draft.revision)
        throw new Error("The runtime did not return a newer saved claim for this conversation.");
      setDraft(undefined);invalidateRead();
    }catch(value){if(gate.accepts(token))setError(value instanceof Error?value.message:String(value));}
    finally{if(gate.accepts(token)){mutationPending.current=false;setBusy(false);}}
  }
  async function review(claim:ResearchClaim,state:"reviewed"|"unreviewed") {
    if(locked||mutationPending.current||draft)return;
    mutationPending.current=true;const token=gate.begin("mutation");setBusy(true);setError("");
    try {
      const result=await request({action:"claim_review",sessionId:session.id,expectedRevision:session.revision??0,claimId:claim.id,state});
      if(!gate.accepts(token))return;
      if(result.session?.id!==session.id||!result.session.revision||result.session.revision<=(session.revision??0))
        throw new Error("The review was not acknowledged with a newer saved revision.");
    }catch(value){if(gate.accepts(token))setError(value instanceof Error?value.message:String(value));}
    finally{if(gate.accepts(token)){mutationPending.current=false;setBusy(false);}}
  }
  return <aside className="research-claims-panel" aria-label="Claim and source review">
    <header><h2>Claims & sources</h2><button type="button" className="chat-icon-button" aria-label="Close claim review" onClick={onClose}><X size={16}/></button></header>
    <div className="research-claims-content">
      <p>Write a claim, cite exact source passages, and record your judgment. Source matching checks the quotation; support and contradiction remain your interpretation.</p>
      <div className="research-claims-toolbar"><small>{claims.length} / {RESEARCH_CLAIM_LIMITS.claims} saved claims</small><button type="button" className="chat-text-button" disabled={locked||!!draft||claims.length>=RESEARCH_CLAIM_LIMITS.claims} onClick={()=>begin()}><Plus size={14}/>New claim</button></div>
      {session.status==="generating"&&<p role="status">Finish or stop the response before changing a review.</p>}
      {error&&<p className="claim-error" role="alert">{error}</p>}
      {!draft&&claims.map(claim=>{const sourceState=claimSourceReviewState(claim);return <article className="research-claim-card" key={claim.id} aria-label={`Claim: ${claim.text}`}>
        <h3>{claim.text}</h3>
        <div className="research-claim-status"><span>{claim.review.state==="reviewed"?"Reviewed by you":"Unreviewed"}</span><span className={sourceState.status!=="current"?"needs-review":""}>{sourceState.status==="pending"?"Source check pending":sourceState.status==="stale"?"Source changed":sourceState.status==="unavailable"?"Source unavailable":claim.review.needsReconfirmation?"Review needs reconfirmation":"Source bindings current"}</span><span>Revision {claim.revision}</span></div>
        {claim.freshness&&claim.freshness.status!=="current"&&<p className="claim-warning">{claim.freshness.message}</p>}
        {!claim.evidence.length&&<p>No cited source yet.</p>}
        {claim.evidence.map(item=><EvidenceCard key={item.id} evidence={item}/>)}
        <p>Reviewed records your decision, not independent verification of the claim.</p>
        <div className="research-claim-actions"><button type="button" className="chat-text-button" disabled={locked} onClick={()=>begin(claim)}>Edit claim & sources</button>
          {claim.review.state==="reviewed"&&<button type="button" className="chat-text-button" disabled={locked} onClick={()=>void review(claim,"unreviewed")}>Return to unreviewed</button>}
          {(claim.review.state!=="reviewed"||sourceState.status==="pending")&&<button type="button" className="chat-text-button" disabled={locked||!sourceState.canReview} onClick={()=>void review(claim,"reviewed")}>{claim.review.state==="reviewed"?"Recheck my review":"Confirm my review"}</button>}
        </div>
        {sourceState.status==="pending"&&sourceState.canReview&&<p>Confirming reopens this claim’s sources before the host saves your review.</p>}
        {!!claim.history.length&&<details className="research-claim-history"><summary>Earlier saved versions ({claim.history.length})</summary><ol>{claim.history.map(version=><li key={version.revision}><strong>Revision {version.revision} · {version.review.state}</strong><p>{version.text}</p>{version.evidence.map(item=><blockquote key={item.id}>{relationNames[item.relation]} · {item.source.locator}: “{item.source.excerpt}”</blockquote>)}<small>{new Date(version.updatedAt).toLocaleString()}</small></li>)}</ol></details>}
      </article>;})}
      {!draft&&!claims.length&&<p>Add a claim to begin. Your citations and review decisions stay with this conversation.</p>}
      {draft&&<div className="research-claim-editor"><fieldset disabled={locked}>
        <label>Claim text<textarea aria-label="Claim text" rows={3} maxLength={RESEARCH_CLAIM_LIMITS.claimCharacters} value={draft.text} onChange={event=>setDraft({...draft,text:event.target.value})}/></label>
        <p>{draft.id?"Saving changes resets this claim to unreviewed and keeps its earlier version.":"New claims are saved as unreviewed."}</p>
        <p>Unsaved drafts stay in memory for up to 16 conversations while you open documents or close this panel. Closing the app clears them.</p>
        {needsReread&&<p className="claim-warning" role="status">Draft restored. Its unsaved source read tokens were cleared. Remove and reread the marked passages before saving.</p>}
        {draft.citations.map((item,index)=><div key={item.key} className="pending-citation"><small>{item.title}</small><p>“{item.quote}”</p>{item.needsReread&&<p className="claim-warning">Read this passage again to restore its source binding.</p>}<label>Passage relation<select aria-label={`Citation ${index+1} relation`} value={item.input.relation} onChange={event=>setDraft({...draft,citations:draft.citations.map(entry=>entry.key===item.key?{...entry,input:{...entry.input,relation:event.target.value as ResearchClaimRelation}}:entry)})}>{Object.entries(relationNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="chat-text-button" aria-label={`Remove citation ${index+1}`} onClick={()=>setDraft({...draft,citations:draft.citations.filter(entry=>entry.key!==item.key)})}>Remove passage</button></div>)}
        <div className="research-claim-source"><p><strong>Add a source passage</strong> · {draft.citations.length} / {RESEARCH_CLAIM_LIMITS.evidence}</p>
          {!session.documents.length?<button type="button" className="chat-text-button" onClick={onDocuments}><BookOpen size={14}/>Open documents to add a source</button>:<>
            <label>Source document<select aria-label="Claim source document" value={documentId} onChange={event=>{invalidateRead();setDocumentId(event.target.value);setUnitIndex(0);setStartOffset(0);}}>{session.documents.map(item=><option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}</select></label>
            <div className="research-claim-source-position"><label>Section index (0-based)<input aria-label="Claim source section index" type="number" min={0} max={document?.extraction?document.extraction.unitCount-1:0} disabled={!document?.extraction} value={unitIndex} onChange={event=>{invalidateRead();setUnitIndex(Number(event.target.value));setStartOffset(0);}}/></label><label>Start character (UTF-16)<input aria-label="Claim source start character" type="number" min={0} value={startOffset} onChange={event=>{invalidateRead();setStartOffset(Number(event.target.value));}}/></label></div>
            <button type="button" className="chat-text-button" disabled={loading||!document||!Number.isSafeInteger(unitIndex)||unitIndex<0||!Number.isSafeInteger(startOffset)||startOffset<0} onClick={()=>void readSource()}>{loading?"Reading source…":"Read source passage"}</button>
            {source&&<><p><strong>{source.locator}</strong><br/>Returned characters {source.textStart}–{source.textEnd} · section {source.unitIndex+1} / {source.totalUnits}. This records only the returned range, not full-document reading.</p>
              <label>Source passage<textarea aria-label="Claim source passage" className="source-text" readOnly value={source.unitText} onSelect={event=>{const element=event.currentTarget;const range=textareaSourceSelection(source.unitText,element.value,element.selectionStart,element.selectionEnd);if(range){setQuote(range.quote);setSelectedRange(range);}}}/></label>
              <label>Exact quotation<textarea aria-label="Claim exact quotation" value={quote} rows={2} maxLength={RESEARCH_CLAIM_LIMITS.quoteCharacters} onChange={event=>{setQuote(event.target.value);setSelectedRange(undefined);}}/></label>
              {quote&&occurrences.ranges.length===0&&<p className="claim-warning">This wording does not occur exactly in the displayed passage.</p>}
              {occurrences.ranges.length>1&&<label>Choose occurrence<select aria-label="Quotation occurrence" value={selectedRange?.start??""} onChange={event=>setSelectedRange(occurrences.ranges.find(item=>String(item.start)===event.target.value))}><option value="">Select the intended location</option>{selectedRange&&!occurrences.ranges.some(item=>item.start===selectedRange.start)&&<option value={selectedRange.start}>Selected source characters {source.textStart+selectedRange.start}–{source.textStart+selectedRange.end}</option>}{occurrences.ranges.map(item=><option key={item.start} value={item.start}>Characters {source.textStart+item.start}–{source.textStart+item.end}</option>)}</select></label>}
              {occurrences.truncated&&<p>First 100 matches shown. Select the exact text directly in the source passage for another location.</p>}
              {activeRange&&<p>Quotation characters {source.textStart+activeRange.start}–{source.textStart+activeRange.end} (UTF-16, end excluded).</p>}
              <label>Relation to claim<select aria-label="New citation relation" value={relation} onChange={event=>setRelation(event.target.value as ResearchClaimRelation)}>{Object.entries(relationNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
              <button type="button" className="chat-text-button" disabled={!validRange||quote.length>RESEARCH_CLAIM_LIMITS.quoteCharacters||draft.citations.length>=RESEARCH_CLAIM_LIMITS.evidence} onClick={addCitation}><Plus size={13}/>Add cited passage</button>
            </>}
          </>}
        </div>
        {conflict&&<section className="claim-conflict" aria-label="Claim revision conflict"><p className="claim-warning" role="status">The conversation changed from revision {draft.revision} to {session.revision}. Your draft is retained. {draft.id!==undefined?"Copy text you want to keep, then cancel and reopen the latest claim. Saving will not overwrite the newer revision.":"Continue this new claim against the latest conversation to keep your text. Unsaved source passages will need to be read again."}</p><label>Latest saved claim<textarea aria-label="Latest saved claim text" readOnly value={currentClaim?.text??(draft.id?"This claim is no longer present.":"This new claim has not been saved.")}/></label><label>Draft text to preserve<textarea aria-label="Draft text to preserve" readOnly value={draft.text}/></label>{missingCitations.length>0&&<><p>These citations are no longer present in the latest claim:</p><ul>{missingCitations.map(item=><li key={item.key}>{item.title} · “{item.quote}”</li>)}</ul></>}{draft.id===undefined&&Number.isSafeInteger(session.revision)&&session.revision!>draft.revision&&<button type="button" className="chat-text-button" onClick={()=>{setDraft(continueNewClaimDraft(draft,session.revision!));invalidateRead();setError("");}}>Continue new claim with latest session</button>}</section>}
        <div className="research-claim-actions"><button type="button" className="chat-text-button" onClick={()=>{setDraft(undefined);invalidateRead();setError("");}}>Cancel edit</button><button type="button" className="primary-button" disabled={conflict||needsReread||missingCitations.length>0||!draft.text.trim()||!draft.revision} onClick={()=>void save()}><Save size={14}/>{busy?"Saving…":"Save unreviewed claim"}</button></div>
      </fieldset></div>}
    </div>
    <footer>Source changes invalidate prior bindings. To review a changed source, edit the claim, remove the old passage and read its replacement. Earlier versions remain saved.</footer>
  </aside>;
}

function EvidenceCard({evidence}:{evidence:ResearchClaimEvidence}) {
  const source=evidence.source;
  return <section className="research-claim-evidence"><h4>{relationNames[evidence.relation]} · {source.documentName}</h4><small>{source.locator} · r{source.documentRevision}</small><blockquote>{source.excerpt}</blockquote>
    <p>{evidence.freshness?.message??"Source freshness has not been checked."}</p>
    {evidence.invalidated&&<p className="claim-warning">Binding invalidated {new Date(evidence.invalidated.observedAt).toLocaleString()}. Re-read and replace this passage before another review.</p>}
    <details><summary>Exact location & source identity</summary><dl>
      <dt>Quote range</dt><dd>{source.quoteStart}–{source.quoteEnd} · UTF-16 characters · end excluded</dd>
      <dt>Reading scope</dt><dd>Section {source.unitIndex+1} / {source.totalUnits}; returned characters {source.readingScope.start}–{source.readingScope.end}; full-document reading not established</dd>
      <dt>Conversation text snapshot SHA-256</dt><dd>{source.documentSha256}</dd>
      <dt>Preserved source</dt><dd>{source.sourcePath??"Editable conversation text"}</dd>
      <dt>Source bytes SHA-256</dt><dd>{source.sourceSha256??"Not a binary document"}</dd>
      {source.originalSourcePath&&<><dt>Original workspace source</dt><dd>{source.originalSourcePath}</dd><dt>Original source SHA-256</dt><dd>{source.originalSourceSha256}</dd></>}
      <dt>Extraction SHA-256</dt><dd>{source.extractionSha256??"Not a parsed document"}</dd>
      <dt>Read at</dt><dd>{source.readAt}</dd>
      <dt>Last source check</dt><dd>{evidence.freshness?.checkedAt??"Not checked"}</dd>
    </dl></details>
  </section>;
}
