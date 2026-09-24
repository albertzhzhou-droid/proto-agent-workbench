import {createHash} from "node:crypto";
import {HARNESS_DEFAULTS, type BlockingClass, type HarnessCheckpoint, type HarnessDiagnostic, type HarnessToolCall, type HarnessVerdict, type ToolResultEnvelope} from "../../shared/harness.ts";

const classes=new Set<BlockingClass>(["repairable","dependency-missing","unsupported","stale","conflicting"]);
const permanent=new Set<BlockingClass>(["unsupported","stale","conflicting"]);
export function normalizeHarnessDiagnostic(value:unknown,refs:string[]=[]):HarnessDiagnostic {
  const row=value&&typeof value==="object"?value as Partial<HarnessDiagnostic>:{};
  const blockingClass=classes.has(row.blockingClass as BlockingClass)?row.blockingClass!:"repairable";
  return {code:typeof row.code==="string"?row.code:"UNCLASSIFIED_DIAGNOSTIC",blockingClass,
    subject:typeof row.subject==="string"?row.subject:"contract",message:typeof row.message==="string"?row.message:String(value),
    evidenceRefs:[...new Set([...(Array.isArray(row.evidenceRefs)?row.evidenceRefs.filter((x):x is string=>typeof x==="string"):[]),...refs])],
    ...(blockingClass==="repairable"&&row.remedy?.tool?{remedy:row.remedy}:{})};
}
/** Consume an allowance once with its durable verdict; a resumed receipt does not refund it. */
export function recordHarnessVerdict(c:HarnessCheckpoint,callId:string,result:ToolResultEnvelope):HarnessVerdict {
  const diagnostics=(Array.isArray(result.data.diagnostics)?result.data.diagnostics:[]).map(d=>normalizeHarnessDiagnostic(d,[result.handle]));
  const previous=c.verdicts?.slice().reverse().find(v=>v.callId===callId);
  if(previous&&JSON.stringify(previous.diagnostics)===JSON.stringify(diagnostics))return previous;
  const budget=c.repairBudget??={...HARNESS_DEFAULTS.repairBudget};
  budget.verifyRepairs??=Math.max(0,HARNESS_DEFAULTS.repairBudget.verifyRepairs-(c.verdicts?.filter(v=>v.action==="repair").length??0));
  const dependencies=diagnostics.filter(d=>d.blockingClass==="dependency-missing");
  const keys=dependencies.map(d=>`${d.code}:${d.subject}`);
  const alreadyHinted=keys.some(key=>c.dependencyHints?.includes(key));
  let action:HarnessVerdict["action"]="completed";
  if(!result.ok||diagnostics.length){
    action=diagnostics.some(d=>permanent.has(d.blockingClass))||alreadyHinted||budget.verifyRepairs<=0?"needs-human":"repair";
    if(action==="repair"){
      budget.verifyRepairs-=1;
      c.dependencyHints=[...new Set([...(c.dependencyHints??[]),...keys])];
    }
  }
  const verdict:HarnessVerdict={callId,round:c.round,recordedAt:new Date().toISOString(),diagnostics,summary:typeof result.data.summary==="string"?result.data.summary:undefined,
    passed:result.ok&&diagnostics.length===0&&Array.isArray(result.data.artifacts)?result.data.artifacts.filter((v):v is string=>typeof v==="string"):[],action};
  (c.verdicts??=[]).push(verdict);
  return verdict;
}
export function harnessDiagnosticCounts(c:HarnessCheckpoint):Partial<Record<BlockingClass,number>> {
  const counts:Partial<Record<BlockingClass,number>>={};
  for(const verdict of c.verdicts??[])for(const d of verdict.diagnostics)counts[d.blockingClass]=(counts[d.blockingClass]??0)+1;
  return counts;
}
function stable(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(stable).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable((value as Record<string,unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value)??"null";
}
export function harnessArgumentsHash(args:string):string {
  let normalized=args.trim();try{normalized=stable(JSON.parse(args));}catch{/* malformed input retains exact identity */}
  return createHash("sha256").update(normalized).digest("hex");
}
export function rememberHarnessFailure(c:HarnessCheckpoint,call:HarnessToolCall,result:ToolResultEnvelope):void {
  if(result.ok||call.function.name.startsWith("harness_")||result.data.code==="PREVIOUS_INVALID_CALL")return;
  const row={tool:call.function.name,argsHash:harnessArgumentsHash(call.function.arguments),failureCode:String(result.data.code??"TOOL_FAILED"),resultHandle:result.handle,callId:call.id};
  c.negativeResults=[...(c.negativeResults??[]).filter(item=>item.tool!==row.tool||item.argsHash!==row.argsHash),row].slice(-128);
}
export function priorInvalidHarnessCall(c:HarnessCheckpoint,call:HarnessToolCall){
  const argsHash=harnessArgumentsHash(call.function.arguments);
  return c.negativeResults?.slice().reverse().find(row=>row.tool===call.function.name&&row.argsHash===argsHash&&["INVALID_TOOL_ARGUMENTS","UNKNOWN_CAPABILITY"].includes(row.failureCode));
}
