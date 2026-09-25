import type {ComputeCatalog,ComputeRun} from '../../shared/compute.ts';
import type {ComputeFingerprint} from '../../shared/research-workflows.ts';
import {ResearchWorkflowService} from './research-workflows.ts';
import {writeWorkspaceComputeRequest,runWorkspaceComputation} from './compute-workspace.ts';
import {requestComputeStudies} from './compute-studies.ts';
import {withWorkspaceWrite} from './workspace-execution-queue.ts';
import {contractDeadlineMs} from '../../shared/tool-contracts.ts';
import type {ExecutionScope} from './execution-scope.ts';
import {randomUUID} from 'node:crypto';

export interface WorkflowRuntimeClient {
 call(name:string,input:Record<string,unknown>,signal?:AbortSignal,authorization?:undefined,options?:{timeoutMs:number;operationId?:string;scope:ExecutionScope}):Promise<Record<string,unknown>>;
 stop():Promise<void>;
}
/** Each operation gets a fresh owned sidecar; execution and discovery do not share a stale imported implementation. */
export function createResearchWorkflowService(workspace:string,createClient:()=>WorkflowRuntimeClient,options:{databaseRelativePath?:string}={}) {
 const call=async(name:string,input:Record<string,unknown>,signal?:AbortSignal,operationId?:string)=>{
  const client=createClient();
  try {
   signal?.throwIfAborted();
   const scopeId=operationId??randomUUID();
   const result=await client.call(name,input,signal,undefined,{timeoutMs:contractDeadlineMs(name,input),
    operationId:scopeId,scope:{surface:'workflow',scopeId}});
   if(result.effect_state==='unknown')throw Object.assign(new Error('The compute runtime returned an unknown effect; retained evidence must be reconciled before recovery.'),{code:'TOOL_EFFECT_UNKNOWN',effectState:'unknown',executionState:'effect-unknown'});
   if(result.ok!==true)throw Object.assign(new Error(typeof result.message==='string'?result.message:JSON.stringify(result.diagnostics??result.error??{message:'The compute runtime did not complete.'})),{code:'COMPUTE_FAILED',executionState:result.effect_state==='none'?'no-effect':'tool-error'});
   return result;
  } finally {await client.stop();}
 };
 return new ResearchWorkflowService(workspace,{
  catalog:async(tool)=>await call('proto_compute_catalog',tool?{tool}:{}) as unknown as ComputeCatalog,
  fingerprint:async(request)=>{
   const path=await writeWorkspaceComputeRequest(workspace,request);
   // McpClient preserves MCP presentation blocks alongside structuredContent.
   // They are transport metadata, outside the strict fingerprint contract.
   const {content: _presentation,...fingerprint}=await call('proto_compute_fingerprint',{path});
   return fingerprint as unknown as ComputeFingerprint;
  },
  run:async(request,context)=>withWorkspaceWrite(workspace,context.signal,async()=>
   await runWorkspaceComputation(workspace,request,(name,input,operationId)=>call(name,input,context.signal,operationId),context.operationId) as ComputeRun),
  openRun:async(runId)=>{
   const response=await requestComputeStudies(workspace,{action:'open-run',runId},options);
   if(!response.run)throw new Error('Saved computation is unavailable.');
   return response.run;
  },
 },options);
}
