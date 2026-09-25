import {spawn,type ChildProcess} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {lstat,mkdir,readFile,readdir,realpath,writeFile,rename,stat} from "node:fs/promises";
import {dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {z} from "zod";
import {minimalChildEnvironment,terminateOwnedProcessTree} from "./process-security.ts";
import type {ChemScienceCatalog,ChemScienceError,ChemScienceRequest,ChemScienceResponse,ChemScienceRun} from "../../shared/chem-science-api.ts";

import { openWorkspaceExecutionJournal } from "./workspace-execution-journal.ts";
import { ToolExecutionJournal } from "./tool-execution-journal.ts";
import { createProductionKernelContext, invokeJournaledTool } from "./execution-kernel.ts";
import type { ExecutionScope } from "./execution-scope.ts";
import type { PolicyDecision } from "../../shared/tool-policy.ts";
import { evaluateToolPolicy, rebindHostPolicyDecision } from "./permissions.ts";

import { chemistryComputeManifest } from "./chem-evidence.ts";
import { artifactReaders } from "./artifact-reader-registry.ts";

const id=z.string().uuid();
const requestSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("catalog")}).strict(),
  z.object({action:z.literal("run"),operator:z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),input:z.record(z.string(),z.unknown()),runId:id.optional(),timeoutMs:z.number().int().min(100).max(120000).optional()}).strict(),
  z.object({action:z.literal("history"),limit:z.number().int().min(1).max(100).default(30)}).strict(),
  z.object({action:z.enum(["read","cancel"]),runId:id}).strict(),
]);
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const json=(value:unknown)=>JSON.stringify(value,null,2)+"\n";
const MAX_INPUT=2*1024*1024,MAX_OUTPUT=32*1024*1024;
type WorkerResponse={ok:boolean;operator:string;result?:Record<string,unknown>;error?:ChemScienceError;provenance?:Record<string,unknown>};
export interface ChemScienceOptions {repoRoot:string;workspacePath:string;runtimeRoot?:string;integrationRoot?:string;pythonExecutable?:string;journal?:ToolExecutionJournal}

/** Fixed scientific operators only. There is no shell, code, approval or device dispatch. */
export class ChemScienceService {
  private options:ChemScienceOptions;
  private ownedLedger?:ReturnType<typeof openWorkspaceExecutionJournal>;
  private journal?:ToolExecutionJournal;
  private active=new Map<string,{controller:AbortController;done:Promise<ChemScienceResponse<ChemScienceRun>>}>();
  private children=new Set<ChildProcess>();
  private closing=false;
  private catalogCache?:{at:number;value:ChemScienceCatalog};
  constructor(options:ChemScienceOptions) {this.options=options;this.journal=options.journal;}
  executionRecord(operationId:string) {return this.journal?.get(operationId);}
  private async executionJournal() {
    if(!this.journal){this.ownedLedger=openWorkspaceExecutionJournal(this.options.workspacePath);this.journal=this.ownedLedger.journal;}
    return this.journal;
  }
  async request(raw:unknown,signal:AbortSignal=new AbortController().signal,execution?:{operationId:string;scope:ExecutionScope;decisionId?:string;decision?:PolicyDecision}):Promise<ChemScienceResponse> {
    try {
      if(this.closing) throw Object.assign(new Error("Chemistry workspace is closing."),{code:"CLOSING"});
      signal.throwIfAborted();
      if(Buffer.byteLength(JSON.stringify(raw))>MAX_INPUT) throw Object.assign(new Error("Chemistry input exceeds 2 MiB."),{code:"INPUT_TOO_LARGE"});
      const request=requestSchema.parse(raw);
      if(request.action==="catalog") return {ok:true,data:await this.catalog(signal)};
      if(request.action==="read") return {ok:true,data:await this.read(request.runId)};
      if(request.action==="history") {
        const root=await this.safeDirectory();
        const entries=(await readdir(root,{withFileTypes:true})).filter(item=>item.isDirectory()&&id.safeParse(item.name).success);
        const runs:ChemScienceRun[]=[];
        for(const entry of entries) {try {const run=await this.read(entry.name);runs.push({...run,input:{},result:undefined,summary:true});} catch(error) {const createdAt=(await stat(join(root,entry.name)).catch(()=>undefined))?.birthtime.toISOString()??new Date(0).toISOString();const unsupported=(error as {code?:string}).code==="UNSUPPORTED_VERSION";runs.push({runId:entry.name,operator:"unknown",status:unsupported?"unsupported-version":"unverifiable",createdAt,input:{},artifacts:{input:`build/chem-science/${entry.name}/input.json`,result:`build/chem-science/${entry.name}/result.json`,manifest:`build/chem-science/${entry.name}/manifest.json`},error:{code:unsupported?"UNSUPPORTED_VERSION":"UNVERIFIABLE",message:error instanceof Error?error.message:String(error)},summary:true});}}
        return {ok:true,data:{runs:runs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,request.limit)}};
      }
      if(request.action==="cancel") {
        const active=this.active.get(request.runId);
        if(active) {active.controller.abort();return await active.done;}
        return {ok:true,data:await this.read(request.runId)};
      }
      if(request.action!=="run") throw new Error("Unsupported chemistry request.");
      const catalog=await this.catalog(signal);
      const operator=catalog.operators.find(item=>item.id===request.operator);
      if(!operator) throw Object.assign(new Error("Operator is not in the chemistry catalog."),{code:"UNKNOWN_OPERATOR"});
      if(operator.available===false) throw Object.assign(new Error(operator.unavailable_reason??"The required chemistry runtime is unavailable."),{code:"UNAVAILABLE"});
      const runId=request.runId??randomUUID();
      if(this.active.has(runId)) throw Object.assign(new Error("This chemistry run is already active."),{code:"RUN_EXISTS"});
      if(this.active.size>=3) throw Object.assign(new Error("Three chemistry runs are already active. Wait for one to finish."),{code:"BUSY"});
      const controller=new AbortController();
      const abort=()=>controller.abort(signal.reason);signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted) abort();
      const operationId=execution?.operationId??`chemistry:${runId}`;
      const scope=execution?.scope??{surface:"chemistry" as const,scopeId:runId};
      const invocationArguments={...request,runId:request.runId??null};
      const decision=execution?.decision?rebindHostPolicyDecision(execution.decision,invocationArguments):evaluateToolPolicy({tool:`chemistry.${request.operator}`,args:invocationArguments,surface:scope.surface,scopeId:scope.scopeId,operationId,grants:[]});
      const journal=await this.executionJournal();
      const invocation={journal,operationId,scope,tool:`chemistry.${request.operator}`,arguments:invocationArguments,decisionId:decision.decisionId,decision};
      const context=createProductionKernelContext(invocation,this.options.workspacePath);
      const done=invokeJournaledTool({...invocation,context},async (markDispatched,inputSnapshot)=>{markDispatched();const value=await this.run({...inputSnapshot,runId} as typeof request & {runId:string},controller.signal);return {...value,...(value.data?{data:{...value.data,input:{},result:undefined,summary:true}}:{})} as unknown as Record<string,unknown>;}).then(async result=>{const receipt=result as unknown as ChemScienceResponse<ChemScienceRun>;return {...receipt,...(receipt.data?{data:await this.read(receipt.data.runId)}:{})};}).finally(()=>{signal.removeEventListener("abort",abort);this.active.delete(runId);});
      this.active.set(runId,{controller,done});
      return await done;
    } catch(error) {return {ok:false,error:this.error(error)};}
  }
  private error(error:unknown):ChemScienceError {
    return {code:error instanceof z.ZodError?"INVALID_REQUEST":error instanceof Error&&error.name==="AbortError"?"CANCELLED":error instanceof Error&&"code" in error?String(error.code):"CHEM_SCIENCE_ERROR",message:error instanceof Error?error.message:String(error)};
  }
  private async safeDirectory(runId?:string,create=true):Promise<string> {
    const root=await realpath(this.options.workspacePath);
    let cursor=root;
    for(const part of ["build","chem-science",...(runId?[id.parse(runId)]:[])]) {
      cursor=join(cursor,part);
      if(create)await mkdir(cursor).catch(error=>{if(error.code!=="EEXIST")throw error;});
      const info=await lstat(cursor),rel=relative(root,await realpath(cursor));
      if(!info.isDirectory()||info.isSymbolicLink()||isAbsolute(rel)||rel===".."||rel.startsWith(`..${sep}`)) throw new Error("Chemistry artifacts must remain in a regular workspace directory.");
    }
    return cursor;
  }
  private async safeRead(directory:string,name:string):Promise<string> {
    const path=join(directory,name),info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_OUTPUT) throw new Error("Invalid chemistry artifact.");
    return readFile(path,"utf8");
  }
  private async read(runId:string):Promise<ChemScienceRun> {
    const directory=await this.safeDirectory(runId,false);
    const manifest=JSON.parse(await this.safeRead(directory,"manifest.json")) as ChemScienceRun;
    const reader=artifactReaders.select("chem-compute",manifest);
    if(reader.readOnly)throw Object.assign(new Error(reader.message),{code:reader.code});
    if(manifest.runId!==runId) throw new Error("Chemistry receipt identity mismatch.");
    if(manifest.artifacts.computeManifest){const companion=await this.safeRead(directory,"compute-manifest.json");if(!manifest.hashes?.computeManifest||digest(companion)!==manifest.hashes.computeManifest)throw new Error("Chemistry compute manifest hash mismatch.");}
    const input=await this.safeRead(directory,"input.json");
    if(manifest.hashes?.input&&digest(input)!==manifest.hashes.input) throw new Error("Chemistry input hash mismatch.");
    if(manifest.status!=="running") {
      const result=await this.safeRead(directory,"result.json");
      if(!manifest.hashes?.result||digest(result)!==manifest.hashes.result) throw new Error("Chemistry result hash mismatch.");
      const worker=JSON.parse(result) as WorkerResponse;
      return {...manifest,input:JSON.parse(input).input,result:worker.result,provenance:worker.provenance,error:worker.error??manifest.error};
    }
    // A run interrupted by an earlier host is recorded as interrupted, never online.
    return {...manifest,status:this.active.has(runId)?"running":"unverifiable",...(!this.active.has(runId)?{error:{code:"INTERRUPTED",message:"The host stopped before confirming completion."}}:{})};
  }
  private async catalog(signal:AbortSignal):Promise<ChemScienceCatalog> {
    if(this.catalogCache&&Date.now()-this.catalogCache.at<15000) return this.catalogCache.value;
    const value=await this.worker({operator:"catalog",input:{}},signal,20000);
    if(!value.ok||!value.result||!Array.isArray(value.result.operators)) throw Object.assign(new Error(value.error?.message??"Invalid chemistry operator catalog."),{code:value.error?.code??"INVALID_CATALOG"});
    const catalog=value.result as unknown as ChemScienceCatalog;
    this.catalogCache={at:Date.now(),value:catalog};return catalog;
  }
  private async run(request:Extract<ChemScienceRequest,{action:"run"}>&{runId:string},signal:AbortSignal):Promise<ChemScienceResponse<ChemScienceRun>> {
    const directory=await this.safeDirectory(request.runId);
    const input=json({operator:request.operator,input:request.input});
    await writeFile(join(directory,"input.json"),input,{flag:"wx",encoding:"utf8"});
    const artifacts={input:relative(this.options.workspacePath,join(directory,"input.json")).replaceAll("\\","/"),result:relative(this.options.workspacePath,join(directory,"result.json")).replaceAll("\\","/"),manifest:relative(this.options.workspacePath,join(directory,"manifest.json")).replaceAll("\\","/")};
    const maturity={method_stage:"method-implementation",scientific_validation:"not-established",domain_validation:"not-established"} as const;
    const run:ChemScienceRun={schema_version:"proto-agent.chem-compute.v1",maturity,evidenceStanding:{dataOrigin:request.input.example?"fixture":"unknown",methodMaturity:maturity.method_stage,executionStatus:"running",humanReview:"required"},runId:request.runId,operator:request.operator,status:"running",createdAt:new Date().toISOString(),input:request.input,artifacts,hashes:{input:digest(input),result:""}};
    await writeFile(join(directory,"manifest.json"),json(run),{flag:"wx",encoding:"utf8"});
    let result:WorkerResponse;
    try {result=await this.worker({operator:request.operator,input:request.input},signal,request.timeoutMs??60000);}
    catch(error) {result={ok:false,operator:request.operator,error:this.error(error)};}
    const serialized=json(result);
    await writeFile(join(directory,"result.json"),serialized,{flag:"wx",encoding:"utf8"});
    Object.assign(run,{status:signal.aborted?"cancelled":result.ok?"completed":"error",finishedAt:new Date().toISOString(),result:result.result,provenance:result.provenance,error:result.error,hashes:{input:digest(input),result:digest(serialized)}});
    // The directory is checked again before replacing the running receipt.
    await this.safeDirectory(request.runId);
    const receiptInfo=await lstat(join(directory,"manifest.json"));
    if(receiptInfo.isSymbolicLink()||!receiptInfo.isFile()) throw new Error("Chemistry manifest is not a regular file.");
    run.evidenceStanding={...run.evidenceStanding!,executionStatus:run.status==="unsupported-version"?"unverifiable":run.status};
    const companion=json(chemistryComputeManifest(run,result as unknown as Record<string,unknown>));
    await writeFile(join(directory,"compute-manifest.json"),companion,{flag:"wx",encoding:"utf8"});
    run.artifacts.computeManifest=relative(this.options.workspacePath,join(directory,"compute-manifest.json")).replaceAll("\\","/");
    run.hashes!.computeManifest=digest(companion);
    const temporary=join(directory,`manifest.${randomUUID()}.tmp`);
    await writeFile(temporary,json({...run,result:undefined}),{flag:"wx",encoding:"utf8"});
    await rename(temporary,join(directory,"manifest.json"));
    return {ok:result.ok&&!signal.aborted,data:run,...(result.error?{error:result.error}:{})};
  }
  private async worker(request:{operator:string;input:Record<string,unknown>},signal:AbortSignal,timeoutMs:number):Promise<WorkerResponse> {
    signal.throwIfAborted();
    const runtimeRoot=resolve(this.options.runtimeRoot??join(this.options.repoRoot,"apps/proto-workbench/runtime/chem-workbench"));
    const integrationRoot=resolve(this.options.integrationRoot??join(dirname(runtimeRoot),"chem-integration"));
    const python=this.options.pythonExecutable??process.env.PROTO_CHEM_PYTHON??resolve(this.options.repoRoot,"../Chem CLI",process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python");
    return new Promise((resolvePromise,reject)=>{
      const child=spawn(python,["-u",join(integrationRoot,"chem_science.py")],{cwd:this.options.workspacePath,windowsHide:true,detached:process.platform!=="win32",stdio:["pipe","pipe","pipe"],env:minimalChildEnvironment({PYTHONPATH:join(runtimeRoot,"src"),PYTHONUTF8:"1",PYTHONDONTWRITEBYTECODE:"1",CHEM_SCIENCE_SOURCE_ROOT:runtimeRoot})});
      this.children.add(child);let stdout="",stderr="",bytes=0,failure:Error|undefined,cleanup:Promise<void>|undefined;
      const stop=(error:Error)=>{failure??=error;cleanup??=terminateOwnedProcessTree(child).catch(cleanupError=>{failure=cleanupError;});};
      const abort=()=>stop(Object.assign(new Error("Chemistry run cancelled."),{code:"CANCELLED"}));
      const timer=setTimeout(()=>stop(Object.assign(new Error("Chemistry run exceeded its time limit."),{code:"TIMEOUT"})),timeoutMs);timer.unref();
      signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
      child.stdout!.on("data",chunk=>{bytes+=chunk.length;if(bytes>MAX_OUTPUT)stop(Object.assign(new Error("Chemistry result exceeds 32 MiB."),{code:"OUTPUT_LIMIT"}));else stdout+=chunk.toString("utf8");});
      child.stderr!.on("data",chunk=>{if(stderr.length<16000)stderr+=chunk.toString("utf8");});
      child.stdin!.on("error",()=>{});
      child.once("error",error=>{failure=error;});
      child.once("close",async code=>{
        clearTimeout(timer);signal.removeEventListener("abort",abort);this.children.delete(child);await cleanup;
        if(failure)return reject(failure);
        if(code!==0)return reject(Object.assign(new Error(`Chemistry worker failed (${code}): ${stderr.slice(0,2000)}`),{code:"WORKER_FAILED"}));
        try {const result=JSON.parse(stdout) as WorkerResponse;if(typeof result.ok!=="boolean"||result.operator!==request.operator)throw new Error("Invalid chemistry worker response.");resolvePromise(result);}catch(error){reject(error);}
      });
      child.stdin!.end(JSON.stringify(request));
    });
  }
  async close():Promise<void> {this.closing=true;for(const item of this.active.values())item.controller.abort();await Promise.allSettled([...this.active.values()].map(item=>item.done));await Promise.allSettled([...this.children].map(child=>terminateOwnedProcessTree(child)));this.ownedLedger?.close();}
}

/** Keep complete arrays in artifacts; preserve scalar evidence and explicit read routes. */
export function summarizeChemScience(value:ChemScienceResponse):unknown {
  if(!value.data||!("runId" in value.data))return value;
  const run=value.data;
  const compact=(item:unknown,depth=0):unknown=>{
    if(Array.isArray(item))return item.length>8?{count:item.length,first:compact(item[0],depth+1),last:compact(item.at(-1),depth+1)}:item.map(part=>compact(part,depth+1));
    if(item&&typeof item==="object")return depth>5?{note:"Read the saved result for nested fields."}:Object.fromEntries(Object.entries(item).map(([key,part])=>[key,compact(part,depth+1)]));
    return typeof item==="string"&&item.length>1200?`${item.slice(0,1200)}…`:item;
  };
  return {...value,data:{...run,input:compact(run.input),result:compact(run.result)},read:{tool:"chemistry.read",arguments:{runId:run.runId}},note:"Complete input, result and provenance are saved at the artifact paths. workspace_read supports offset/limit for full evidence."};
}
