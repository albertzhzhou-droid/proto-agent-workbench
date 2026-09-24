import {useState} from "react";
import {workbenchApi} from "./mock-api.ts";

export function ExecutionReconciliation({operationId,onReconciled}:{operationId:string;onReconciled:()=>void}) {
  const [actor,setActor]=useState(""),[evidenceRef,setEvidenceRef]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function reconcile(verdict:"applied"|"not-applied") {
    setBusy(true);setError("");
    try{await workbenchApi().journal.reconcile({operationId,verdict,actor:actor.trim(),evidenceRef:evidenceRef.trim()});onReconciled();}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  }
  return <details className="chat-reconciliation"><summary>Record an effect review</summary><p>Inspect the saved artifacts before recording whether this operation took effect. The decision preserves the original receipt and does not rerun the tool.</p><label>Reviewer<input value={actor} maxLength={256} onChange={event=>setActor(event.target.value)}/></label><label>Workspace-relative evidence file<input value={evidenceRef} placeholder="build/reviews/effect-review.json" maxLength={4096} onChange={event=>setEvidenceRef(event.target.value)}/></label><p>The file must exist in this workspace. Its SHA-256 is recorded with the verdict.</p><div><button disabled={busy||!actor.trim()||!evidenceRef.trim()} onClick={()=>void reconcile("applied")}>Effect confirmed</button><button disabled={busy||!actor.trim()||!evidenceRef.trim()} onClick={()=>void reconcile("not-applied")}>No effect confirmed</button></div>{error&&<p role="alert">{error}</p>}</details>;
}
