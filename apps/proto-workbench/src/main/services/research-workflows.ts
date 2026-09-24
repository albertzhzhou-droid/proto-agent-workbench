import { applySchemaMigrations, type SchemaMigrationReport } from "./schema-migrations.ts";
import {createHash, randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {realpath} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import Ajv from 'ajv';
import {z} from 'zod';
import {databasePath, guardDatabase, requestComputeStudies} from './compute-studies.ts';
import {ResearchWorkflowsRequestSchema, WorkflowDraftSchema, RESEARCH_WORKFLOW_LIMITS as LIMITS} from '../../shared/research-workflows.ts';
import type {ComputeRequest, ComputeTool, ComputeRun} from '../../shared/compute.ts';
import type {ComputeStudyOpenedRun, ComputeStudyRunBinding} from '../../shared/compute-studies.ts';
import type {ComputeFingerprint, ResearchWorkflow, ResearchWorkflowDependencies, ResearchWorkflowsResponse, WorkflowDraft, WorkflowExecution, WorkflowExecutionComparison, WorkflowPreview, WorkflowStep, WorkflowStepExecution, WorkflowValidation} from '../../shared/research-workflows.ts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const hex=/^[a-f0-9]{64}$/;
const active=new Set(['pending','running']);
const successful=new Set(['succeeded','reused']);
const terminalStep=new Set(['succeeded','reused','failed','blocked','cancelled','interrupted']);
const MAX_PREVIEW_BASELINE_EXECUTIONS=8;
const ajv=new Ajv({strict:false,allErrors:true,ownProperties:true});
const stamp=z.string().max(80).refine(value=>Number.isFinite(Date.parse(value)));
const branchOriginSchema=z.object({workflowId:z.string().uuid(),revision:z.number().int().min(1).max(LIMITS.versionsPerWorkflow),definitionSha256:z.string().regex(hex)}).strict();
const definitionSchema=WorkflowDraftSchema.extend({id:z.string().uuid(),studyId:z.string().uuid(),revision:z.number().int().min(1).max(LIMITS.versionsPerWorkflow),createdAt:stamp,updatedAt:stamp,parentBranch:branchOriginSchema.optional()}).strict();
const digestSchema=z.string().regex(hex),stepIdSchema=z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const bindingSchema=z.object({tool:z.string().min(1).max(128),createdAt:stamp,manifestSha256:digestSchema,provenanceSha256:digestSchema,inputSha256:digestSchema,resultSha256:digestSchema}).strict();
const fingerprintSchema=z.object({ok:z.literal(true),schema_version:z.literal('proto-agent.compute-fingerprint.v1'),fingerprint_sha256:digestSchema,cacheable:z.boolean(),reasons:z.array(z.string().max(4000)).max(100),materials:z.object({request:z.json(),files:z.json(),implementation:z.json(),runtime:z.json()}).strict()}).strict();
const stepExecutionSchema=z.object({stepId:stepIdSchema,title:z.string().min(1).max(120),tool:z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),status:z.enum(['pending','running','succeeded','reused','failed','blocked','cancelled','interrupted']),operationId:z.string().uuid().optional(),startedAt:stamp.optional(),finishedAt:stamp.optional(),request:z.object({tool:z.string(),arguments:z.record(z.string(),z.json())}).strict().optional(),fingerprint:fingerprintSchema.optional(),cacheKey:digestSchema.optional(),cacheReason:z.string().max(4000).optional(),runId:z.string().regex(/^[a-f0-9]{32}$/).optional(),binding:bindingSchema.optional(),reusedFromExecutionId:z.string().uuid().optional(),error:z.object({code:z.string().min(1).max(120),message:z.string().max(4000),stepId:stepIdSchema.optional(),argument:z.string().max(100).optional(),executionState:z.enum(['no-effect','tool-error','effect-unknown']).optional()}).strict().optional(),blockedBy:z.array(stepIdSchema).max(LIMITS.steps).optional()}).strict();
const executionSchema=z.object({id:z.string().uuid(),workflowId:z.string().uuid(),workflowRevision:z.number().int().min(1).max(LIMITS.versionsPerWorkflow),studyId:z.string().uuid(),name:z.string().min(1).max(120),status:z.enum(['pending','running','succeeded','failed','cancelled','interrupted']),createdAt:stamp,updatedAt:stamp,finishedAt:stamp.optional(),owner:z.object({pid:z.number().int().positive().max(2147483647),instanceId:z.string().uuid()}).strict(),steps:z.array(stepExecutionSchema).min(1).max(LIMITS.steps),forceSteps:z.array(stepIdSchema).max(LIMITS.steps),parentExecutionId:z.string().uuid().optional(),cancelRequested:z.boolean().optional()}).strict();
type StoredExecution={revision:number;payload:string;host:string;execution:WorkflowExecution};
type CacheRecord={key:string;stepId:string;workflowId:string;executionId:string;runId:string;binding:ComputeStudyRunBinding};
type Job={controller:AbortController;done:Promise<void>};

export class ResearchWorkflowError extends Error {
  readonly code:string;
  constructor(code:string,message:string){super(message);this.code=code;}
}
function fail(code:string,message:string):never{throw new ResearchWorkflowError(code,message);}
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
/** Stable JSON without lossy undefined/nonfinite coercion or executable objects. */
function canonical(value:unknown):string {
  let nodes=0;
  const visit=(item:unknown,depth:number):unknown=>{
    if(++nodes>300000||depth>48)fail('WORKFLOW_VALUE_LIMIT','Workflow JSON exceeds its node or depth limit.');
    if(item===null||typeof item==='string'||typeof item==='boolean')return item;
    if(typeof item==='number'&&Number.isFinite(item)&&(!Number.isInteger(item)||Number.isSafeInteger(item)))return item;
    if(Array.isArray(item))return item.map(value=>visit(value,depth+1));
    if(object(item)&&(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null)){
      const result:Record<string,unknown>=Object.create(null);
      for(const key of Object.keys(item).sort()){
        const descriptor=Object.getOwnPropertyDescriptor(item,key);
        if(!descriptor||!('value' in descriptor))fail('WORKFLOW_VALUE','Workflow data cannot contain accessors.');
        result[key]=visit(descriptor.value,depth+1);
      }
      return result;
    }
    return fail('WORKFLOW_VALUE','Workflow values must be finite, exact JSON data.');
  };
  return JSON.stringify(visit(value,0));
}
function same(a:unknown,b:unknown){return canonical(a)===canonical(b);}
function pointer(value:unknown,path:string):unknown {
  if(path==='')return value;
  if(!path.startsWith('/')||/~(?![01])/.test(path))fail('WORKFLOW_POINTER','Use a valid RFC 6901 pointer.');
  for(const encoded of path.slice(1).split('/')){
    const key=encoded.replaceAll('~1','/').replaceAll('~0','~');
    if(Array.isArray(value)){
      if(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length)fail('WORKFLOW_POINTER','The selected result array position does not exist.');
    }else if(!object(value))fail('WORKFLOW_POINTER','The selected result path does not exist.');
    if(!Object.hasOwn(value as object,key))fail('WORKFLOW_POINTER','The selected result field does not exist.');
    value=(value as Record<string,unknown>)[key];
  }
  return value;
}
function typeMatches(value:unknown,type:string){return type==='array'?Array.isArray(value):type==='object'?object(value):type==='integer'?typeof value==='number'&&Number.isSafeInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===type;}
function graph(draft:WorkflowDraft):WorkflowValidation {
  const diagnostics:WorkflowValidation['diagnostics']=[],ids=new Set(draft.steps.map(step=>step.id));
  if(ids.size!==draft.steps.length)diagnostics.push({code:'DUPLICATE_STEP',message:'Workflow step IDs must be unique.'});
  for(const step of draft.steps){
    const argumentsSeen=new Set<string>();
    for(const binding of step.bindings){
      if(!ids.has(binding.fromStep)||binding.fromStep===step.id)diagnostics.push({code:'DEPENDENCY_INVALID',stepId:step.id,message:'A binding must name another saved step.'});
      if(argumentsSeen.has(binding.argument)||Object.hasOwn(step.arguments,binding.argument))diagnostics.push({code:'BINDING_COLLISION',stepId:step.id,argument:binding.argument,message:'Each bound argument has one source and cannot also contain a literal value.'});
      argumentsSeen.add(binding.argument);
      if((binding.pointer!==''&&!binding.pointer.startsWith('/'))||/~(?![01])/.test(binding.pointer))diagnostics.push({code:'WORKFLOW_POINTER',stepId:step.id,message:'Use a valid RFC 6901 pointer.'});
    }
  }
  const order:string[]=[],remaining=new Set(draft.steps.map(step=>step.id));
  while(remaining.size){
    const ready=draft.steps.filter(step=>remaining.has(step.id)&&step.bindings.every(binding=>order.includes(binding.fromStep)));
    if(!ready.length){diagnostics.push({code:'WORKFLOW_CYCLE',message:'Dependencies must form an acyclic graph with existing source steps.'});break;}
    for(const step of ready){order.push(step.id);remaining.delete(step.id);}
  }
  return {ok:diagnostics.length===0,order,diagnostics};
}
function forcedClosure(workflow:ResearchWorkflow,requested:string[]):string[]{
  if(new Set(requested).size!==requested.length)fail('FORCE_STEPS_DUPLICATE','Forced step selection must not contain duplicates.');
  const forced=new Set(requested);
  if(requested.some(id=>!workflow.steps.some(step=>step.id===id)))fail('STEP_NOT_FOUND','A requested forced step does not exist in this workflow version.');
  for(const id of graph(workflow).order)if(workflow.steps.find(step=>step.id===id)!.bindings.some(binding=>forced.has(binding.fromStep)))forced.add(id);
  return graph(workflow).order.filter(id=>forced.has(id));
}
function fingerprint(value:unknown):ComputeFingerprint {
  if(!fingerprintSchema.safeParse(value).success)fail('FINGERPRINT_INVALID','The runtime did not return a complete execution fingerprint.');
  const encoded=canonical(value);if(Buffer.byteLength(encoded)>65536)fail('FINGERPRINT_LIMIT','Execution fingerprint metadata exceeds 64 KiB.');
  return JSON.parse(encoded) as ComputeFingerprint;
}
function matchingExecutionFingerprint(run:ComputeStudyOpenedRun,current:ComputeFingerprint,requireReusable:boolean){
  const value=(run.receipt as unknown as Record<string,unknown>)?.execution_fingerprint;
  return object(value)&&value.fingerprint_sha256===current.fingerprint_sha256&&typeof value.verified_unchanged==='boolean'&&(!requireReusable||value.verified_unchanged===true&&value.cacheable===true&&current.cacheable);
}
function checkedRun(run:ComputeStudyOpenedRun,tool:string,binding?:ComputeStudyRunBinding,requireCurrent=false){
  if(run.integrity.status!=='verified'||requireCurrent&&run.sourceFreshness.status!=='current'||!run.receipt||!run.request||!run.binding||run.tool!==tool||run.receipt.ok!==true||run.receipt.preview===true||!object(run.receipt.result))fail('RUN_NOT_VERIFIED','The saved result and request must verify; cached reuse also requires current sources.');
  if(binding&&!same(run.binding,binding))fail('RUN_BINDING_CHANGED','Saved result bytes differ from their retained workflow binding.');
  return run;
}

/** One instance per workspace. Background jobs never hold a SQLite transaction across I/O. */
export class ResearchWorkflowService {
  migrationReport?:SchemaMigrationReport;
  private readonly workspace:string;
  private readonly dependencies:ResearchWorkflowDependencies;
  private readonly options:{databaseRelativePath?:string};
  private readonly instanceId=randomUUID();
  private readonly jobs=new Map<string,Job>();
  private root='';private path='';private db?:DatabaseSync;private initialization?:Promise<void>;private closing=false;
  constructor(workspace:string,dependencies:ResearchWorkflowDependencies,options:{databaseRelativePath?:string}={}){this.workspace=workspace;this.dependencies=dependencies;this.options=options;}
  private ready(){
    return this.initialization??=(async()=>{
      this.root=await realpath(this.workspace);this.path=databasePath(this.root,this.options.databaseRelativePath??'build/compute-studies/studies.sqlite');
      guardDatabase(this.root,this.path);this.db=new DatabaseSync(this.path);guardDatabase(this.root,this.path);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.migrationReport=applySchemaMigrations(this.db,"research-workflows",[{version:1,sql:`
        CREATE TABLE IF NOT EXISTS research_workflows(id TEXT PRIMARY KEY,study_id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS research_workflow_versions(workflow_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workflow_id,revision));
        CREATE TABLE IF NOT EXISTS research_workflow_executions(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL,study_id TEXT NOT NULL,workflow_revision INTEGER NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,host TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS research_workflow_one_active ON research_workflow_executions(workflow_id) WHERE status IN ('pending','running');
        CREATE TABLE IF NOT EXISTS research_workflow_attempts(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL,step_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(execution_id,step_id));
        CREATE TABLE IF NOT EXISTS research_workflow_cache(workflow_id TEXT NOT NULL,step_id TEXT NOT NULL,cache_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workflow_id,step_id,cache_key));
        CREATE TRIGGER IF NOT EXISTS research_workflow_versions_no_update BEFORE UPDATE ON research_workflow_versions BEGIN SELECT RAISE(ABORT,'research workflow versions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS research_workflow_versions_no_delete BEFORE DELETE ON research_workflow_versions BEGIN SELECT RAISE(ABORT,'research workflow versions are immutable'); END;`}]);
    })();
  }
  private transaction<T>(run:()=>T):T {guardDatabase(this.root,this.path);this.db!.exec('BEGIN IMMEDIATE');try{const result=run();this.db!.exec('COMMIT');return result;}catch(error){this.db!.exec('ROLLBACK');throw error;}}
  private definition(studyId:string,workflowId:string,revision?:number):ResearchWorkflow {
    guardDatabase(this.root,this.path);
    const row=this.db!.prepare('SELECT revision,payload,length(CAST(payload AS BLOB)) bytes FROM research_workflows WHERE id=? AND study_id=?').get(workflowId,studyId) as {revision:number;payload:string;bytes:number}|undefined;
    if(!row)fail('WORKFLOW_NOT_FOUND','This workflow does not belong to the selected project.');
    if(row.bytes>LIMITS.draftBytes)fail('WORKFLOW_DAMAGED','Workflow metadata is oversized; its stored bytes were retained.');
    const selected=this.db!.prepare('SELECT payload,length(CAST(payload AS BLOB)) bytes FROM research_workflow_versions WHERE workflow_id=? AND revision=?').get(workflowId,revision??row.revision) as {payload:string;bytes:number}|undefined;
    if(!selected||selected.bytes>LIMITS.draftBytes)fail('WORKFLOW_DAMAGED','Workflow version is missing or oversized.');
    let workflow:ResearchWorkflow;try{workflow=definitionSchema.parse(JSON.parse(selected.payload));}catch{return fail('WORKFLOW_DAMAGED','Workflow metadata is invalid; its stored bytes were retained.');}
    if(workflow.id!==workflowId||workflow.studyId!==studyId||workflow.revision!==(revision??row.revision)||(!revision||revision===row.revision)&&row.payload!==selected.payload||!graph(workflow).ok)fail('WORKFLOW_DAMAGED','Workflow identity, graph or immutable version does not match.');
    if(workflow.parentBranch){
      const origin=workflow.parentBranch;
      if(origin.workflowId===workflow.id)fail('WORKFLOW_DAMAGED','A workflow branch cannot name itself as its source.');
      const parent=this.db!.prepare('SELECT payload,length(CAST(payload AS BLOB)) bytes FROM research_workflow_versions WHERE workflow_id=? AND revision=?').get(origin.workflowId,origin.revision) as {payload:string;bytes:number}|undefined;
      if(!parent||parent.bytes>LIMITS.draftBytes)fail('WORKFLOW_DAMAGED','The immutable source revision for this branch is missing or oversized.');
      let parentRecord:ResearchWorkflow;try{parentRecord=definitionSchema.parse(JSON.parse(parent.payload));}catch{return fail('WORKFLOW_DAMAGED','The immutable source revision for this branch is malformed.');}
      if(parentRecord.id!==origin.workflowId||parentRecord.studyId!==studyId||sha(canonical(parentRecord))!==origin.definitionSha256)fail('WORKFLOW_DAMAGED','The immutable source revision digest for this branch does not match.');
    }
    return workflow;
  }
  private execution(studyId:string,workflowId:string,id:string):StoredExecution {
    guardDatabase(this.root,this.path);
    const row=this.db!.prepare('SELECT revision,host,payload,status,workflow_revision,length(CAST(payload AS BLOB)) bytes FROM research_workflow_executions WHERE id=? AND workflow_id=? AND study_id=?').get(id,workflowId,studyId) as {revision:number;host:string;payload:string;status:string;workflow_revision:number;bytes:number}|undefined;
    if(!row)fail('EXECUTION_NOT_FOUND','This execution does not belong to the selected workflow and project.');
    if(row.bytes>LIMITS.executionBytes)fail('EXECUTION_DAMAGED','Execution metadata exceeds its retention bound.');
    if(!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.host!=='string'||!row.host||row.host.length>255||/[\x00-\x1f\x7f]/.test(row.host))fail('EXECUTION_DAMAGED','Execution storage revision or host identity is invalid.');
    let execution:WorkflowExecution;try{execution=executionSchema.parse(JSON.parse(row.payload)) as WorkflowExecution;canonical(execution);}catch{return fail('EXECUTION_DAMAGED','Execution metadata is invalid.');}
    const definition=this.definition(studyId,workflowId,execution.workflowRevision);
    if(execution.id!==id||execution.workflowId!==workflowId||execution.studyId!==studyId||execution.status!==row.status||execution.workflowRevision!==row.workflow_revision||execution.steps.length!==definition.steps.length||execution.steps.some((step,index)=>step.stepId!==definition.steps[index].id||step.tool!==definition.steps[index].tool)||!active.has(execution.status)&&execution.steps.some(step=>!terminalStep.has(step.status)))fail('EXECUTION_DAMAGED','Execution identity, state or saved workflow version does not match.');
    if(execution.steps.some(step=>step.title!==definition.steps.find(value=>value.id===step.stepId)?.title||step.request&&step.request.tool!==step.tool||step.binding&&step.binding.tool!==step.tool||successful.has(step.status)&&(!step.runId||!step.binding||!step.fingerprint||!step.cacheKey||!step.finishedAt)||step.status==='reused'&&!step.reusedFromExecutionId||terminalStep.has(step.status)&&!step.finishedAt||step.status==='running'&&!step.startedAt||step.blockedBy?.some(id=>!definition.steps.some(value=>value.id===id)))||new Set(execution.forceSteps).size!==execution.forceSteps.length||execution.forceSteps.some(id=>!definition.steps.some(step=>step.id===id))||execution.status==='succeeded'&&!execution.steps.every(step=>successful.has(step.status))||active.has(execution.status)&&execution.finishedAt!==undefined||!active.has(execution.status)&&!execution.finishedAt)fail('EXECUTION_DAMAGED','Execution terminal state, step receipt or force selection is inconsistent.');
    const attempts=this.db!.prepare('SELECT step_id,payload FROM research_workflow_attempts WHERE execution_id=? LIMIT ?').all(id,LIMITS.steps+1) as {step_id:string;payload:string}[];
    try{if(attempts.length!==execution.steps.length||execution.steps.some(step=>{const attempt=attempts.find(attempt=>attempt.step_id===step.stepId);return !attempt||!same(stepExecutionSchema.parse(JSON.parse(attempt.payload)),step);}))fail('EXECUTION_DAMAGED','Execution steps do not match their retained attempts.');}catch{return fail('EXECUTION_DAMAGED','Execution steps do not match their retained attempts.');}
    return {...row,execution};
  }
  private mutateExecution(identity:Pick<WorkflowExecution,'studyId'|'workflowId'|'id'>,mutate:(execution:WorkflowExecution)=>void,allowOtherOwner=false){
    return this.transaction(()=>{
      const stored=this.execution(identity.studyId,identity.workflowId,identity.id),before=stored.execution;
      if(!allowOtherOwner&&before.owner.instanceId!==this.instanceId)fail('EXECUTION_OWNERSHIP','Another host owns this execution.');
      if(!active.has(before.status))fail('EXECUTION_TERMINAL','A terminal execution cannot be rewritten.');
      const value=JSON.parse(stored.payload) as WorkflowExecution;mutate(value);value.updatedAt=now();
      if(!active.has(value.status))value.finishedAt=value.updatedAt;
      const payload=JSON.stringify(value);if(Buffer.byteLength(payload)>LIMITS.executionBytes)fail('EXECUTION_LIMIT','Execution metadata exceeds its explicit bound.');
      for(const step of value.steps){
        const previous=before.steps.find(item=>item.stepId===step.stepId)!;
        if(terminalStep.has(previous.status)&&!same(previous,step))fail('ATTEMPT_IMMUTABLE','A terminal step attempt cannot be changed.');
        this.db!.prepare('UPDATE research_workflow_attempts SET payload=? WHERE execution_id=? AND step_id=?').run(JSON.stringify(step),value.id,step.stepId);
      }
      if(Number(this.db!.prepare('UPDATE research_workflow_executions SET status=?,revision=?,payload=? WHERE id=? AND revision=? AND payload=?').run(value.status,stored.revision+1,payload,value.id,stored.revision,stored.payload).changes)!==1)fail('EXECUTION_CONFLICT','Execution state changed concurrently.');
      return value;
    });
  }
  private async catalog(step:WorkflowStep):Promise<ComputeTool>{
    const catalog=await this.dependencies.catalog(step.tool),tool=catalog.tools?.find(tool=>tool.id===step.tool);
    if(!catalog.ok||catalog.execution==='recorded'||!tool?.input_schema)fail('TOOL_UNAVAILABLE',`The current typed schema for ${step.tool} is unavailable.`);
    return tool;
  }
  private async validate(draft:WorkflowDraft):Promise<WorkflowValidation>{
    if(Buffer.byteLength(canonical(draft))>LIMITS.draftBytes)fail('WORKFLOW_LIMIT','Workflow definition exceeds 2 MiB.');
    const validation=graph(draft),tools=new Map<string,ComputeTool>();
    for(const step of draft.steps){
      try{
        const tool=tools.get(step.tool)??await this.catalog(step);tools.set(step.tool,tool);
        const schema=JSON.parse(JSON.stringify(tool.input_schema)) as Record<string,unknown>;
        const bound=new Set(step.bindings.map(binding=>binding.argument));
        schema.required=(Array.isArray(schema.required)?schema.required:[]).filter(name=>!bound.has(String(name)));
        if(!ajv.compile(schema)(step.arguments))validation.diagnostics.push({code:'ARGUMENT_TYPE',stepId:step.id,message:'Literal arguments do not satisfy the current tool schema.'});
        for(const binding of step.bindings){
          const target=tool.input_schema?.properties?.[binding.argument];
          if(!target||target.type!==binding.type&&!(target.type==='number'&&binding.type==='integer'))validation.diagnostics.push({code:'BINDING_TYPE',stepId:step.id,argument:binding.argument,message:'The binding type does not match the destination argument schema.'});
        }
      }catch(error){validation.diagnostics.push({code:error instanceof ResearchWorkflowError?error.code:'SCHEMA_INVALID',stepId:step.id,message:error instanceof Error?error.message:'The current tool schema could not be checked.'});}
    }
    validation.ok=validation.diagnostics.length===0;return validation;
  }
  private createExecution(workflow:ResearchWorkflow,forceSteps:string[],parentExecutionId?:string):WorkflowExecution {
    const forced=forcedClosure(workflow,forceSteps);
    const carriedOperationIds=new Map<string,string>();
    if(parentExecutionId){
      const parent=this.execution(workflow.studyId,workflow.id,parentExecutionId).execution;
      for(const step of parent.steps){
        // A transport/receipt failure can leave a dispatched write unknown even
        // though the workflow step is terminal. Only an explicit retained
        // no-effect or tool-error verdict permits recovery to use a fresh ID.
        // Legacy failed steps lack that verdict and keep their prior identity.
        const uncertainFailure=step.status==='failed'&&!['no-effect','tool-error'].includes(step.error?.executionState??'');
        if(!['running','interrupted','cancelled'].includes(step.status)&&!uncertainFailure)continue;
        const previous=this.db!.prepare('SELECT id FROM research_workflow_attempts WHERE execution_id=? AND step_id=?').get(parentExecutionId,step.stepId) as {id:string}|undefined;
        const operationId=step.operationId??previous?.id;
        if(operationId)carriedOperationIds.set(step.stepId,operationId);
      }
    }
    return this.transaction(()=>{
      if(!parentExecutionId&&this.definition(workflow.studyId,workflow.id).revision!==workflow.revision)fail('WORKFLOW_CONFLICT','Workflow changed before execution ownership could be acquired.');
      if(this.db!.prepare("SELECT id FROM research_workflow_executions WHERE workflow_id=? AND status IN ('pending','running')").get(workflow.id))fail('EXECUTION_ACTIVE','This workflow already has an unfinished execution; inspect or recover it before starting another.');
      if((this.db!.prepare('SELECT count(*) n FROM research_workflow_executions WHERE workflow_id=?').get(workflow.id) as {n:number}).n>=LIMITS.executionsPerWorkflow)fail('EXECUTION_HISTORY_LIMIT','Execution history is full; no earlier record has been deleted.');
      const at=now(),execution:WorkflowExecution={id:randomUUID(),workflowId:workflow.id,workflowRevision:workflow.revision,studyId:workflow.studyId,name:workflow.name,status:'pending',createdAt:at,updatedAt:at,owner:{pid:process.pid,instanceId:this.instanceId},steps:workflow.steps.map(step=>({stepId:step.id,title:step.title,tool:step.tool,status:'pending',operationId:carriedOperationIds.get(step.id)??randomUUID()})),forceSteps:forced,...(parentExecutionId?{parentExecutionId}:{})};
      this.db!.prepare('INSERT INTO research_workflow_executions VALUES(?,?,?,?,?,?,?,?)').run(execution.id,workflow.id,workflow.studyId,workflow.revision,execution.status,1,hostname(),JSON.stringify(execution));
      for(const step of execution.steps)this.db!.prepare('INSERT INTO research_workflow_attempts VALUES(?,?,?,?)').run(randomUUID(),execution.id,step.stepId,JSON.stringify(step));
      return execution;
    });
  }
  private priorSuccessfulSteps(workflow:ResearchWorkflow){
    const rows=this.db!.prepare('SELECT id FROM research_workflow_executions WHERE workflow_id=? ORDER BY rowid DESC LIMIT ?').all(workflow.id,MAX_PREVIEW_BASELINE_EXECUTIONS) as {id:string}[];
    const prior=new Map<string,WorkflowStepExecution>(),warnings:string[]=[];
    for(const row of rows){
      try{
        const execution=this.execution(workflow.studyId,workflow.id,row.id).execution;
        for(const step of execution.steps)if(successful.has(step.status)&&step.runId&&step.fingerprint&&!prior.has(step.stepId))prior.set(step.stepId,step);
      }catch(error){warnings.push(`Execution ${row.id} was excluded from comparison because its retained record did not verify: ${(error instanceof Error?error.message:String(error)).slice(0,240)}`);}
      if(prior.size===workflow.steps.length)break;
    }
    if(prior.size<workflow.steps.length&&rows.length===MAX_PREVIEW_BASELINE_EXECUTIONS)warnings.push(`Only the ${MAX_PREVIEW_BASELINE_EXECUTIONS} most recent workflow executions were scanned for change explanations; older receipts may exist.`);
    return {prior,warnings:warnings.slice(0,20)};
  }
  private async reusableResult(
    workflowId:string,
    studyId:string,
    stepId:string,
    tool:string,
    request:ComputeRequest,
    current:ComputeFingerprint,
    key:string,
  ):Promise<{run:ComputeStudyOpenedRun;entry:CacheRecord}|{reason:string}>{
    const cached=this.db!.prepare('SELECT payload FROM research_workflow_cache WHERE workflow_id=? AND step_id=? AND cache_key=? AND length(CAST(payload AS BLOB))<65536').get(workflowId,stepId,key) as {payload:string}|undefined;
    if(!cached)return {reason:'No retained result matches the current request, runtime fingerprint and upstream bindings.'};
    try{
      const entry=JSON.parse(cached.payload) as CacheRecord;
      if(entry.workflowId!==workflowId||entry.stepId!==stepId||entry.key!==key)fail('CACHE_IDENTITY','Cached step identity is inconsistent.');
      const prior=this.execution(studyId,workflowId,entry.executionId).execution.steps.find(item=>item.stepId===stepId);
      if(!prior||!successful.has(prior.status)||prior.runId!==entry.runId||prior.cacheKey!==key||!same(prior.binding,entry.binding))fail('CACHE_IDENTITY','Cache entry does not match a retained terminal attempt.');
      const run=checkedRun(await this.dependencies.openRun(entry.runId),tool,entry.binding,true);
      if(!same(run.request,request)||!matchingExecutionFingerprint(run,current,true))fail('CACHE_FINGERPRINT','Saved execution fingerprint does not match current inputs and runtime.');
      const confirmed=fingerprint(await this.dependencies.fingerprint(request));
      if(!confirmed.cacheable||confirmed.fingerprint_sha256!==current.fingerprint_sha256)fail('CACHE_FINGERPRINT','Inputs or runtime changed while checking the cached result.');
      return {run,entry};
    }catch(error){return {reason:`Cached result not reused: ${(error instanceof Error?error.message:String(error)).slice(0,1500)}`};}
  }
  private async buildPreview(workflow:ResearchWorkflow,requestedForceSteps:string[]):Promise<WorkflowPreview>{
    const forcedClosureIds=forcedClosure(workflow,requestedForceSteps),forced=new Set(forcedClosureIds),order=graph(workflow).order;
    const {prior,warnings}=this.priorSuccessfulSteps(workflow),resolved=new Map<string,ComputeStudyOpenedRun>(),steps:WorkflowPreview['steps']=[];
    let canStart=true;
    for(const id of order){
      const step=workflow.steps.find(item=>item.id===id)!,dependencies=[...new Set(step.bindings.map(binding=>binding.fromStep))];
      const unavailable=dependencies.filter(dependency=>!resolved.has(dependency));
      if(unavailable.length){
        steps.push({stepId:id,title:step.title,tool:step.tool,state:forced.has(id)?'forced':'conditional',reason:forced.has(id)?`This node is in the forced descendant closure; upstream result(s) ${unavailable.join(', ')} will not be known until execution.`:`Upstream result(s) ${unavailable.join(', ')} are not reusable in the preview, so this node's request and cache decision will be resolved after they finish.`,dependencies,changedMaterials:['upstream_result_pending']});
        continue;
      }
      const args=JSON.parse(canonical(step.arguments)) as Record<string,unknown>,upstream:Array<{stepId:string;runId:string;binding:ComputeStudyRunBinding}>=[],upstreamSeen=new Set<string>();
      try{
        for(const binding of step.bindings){
          const run=resolved.get(binding.fromStep)!;
          if(!run.runId||!run.binding)fail('UPSTREAM_MISSING','A reusable upstream step has no verified saved result binding.');
          const selected=pointer(run.receipt!.result,binding.pointer);
          if(!typeMatches(selected,binding.type))fail('BINDING_VALUE_TYPE',`Saved result ${binding.fromStep}${binding.pointer} does not have declared type ${binding.type}.`);
          Object.defineProperty(args,binding.argument,{value:JSON.parse(canonical(selected)),enumerable:true,writable:true,configurable:true});
          if(!upstreamSeen.has(binding.fromStep)){upstreamSeen.add(binding.fromStep);upstream.push({stepId:binding.fromStep,runId:run.runId,binding:run.binding});}
        }
        const request:ComputeRequest={tool:step.tool,arguments:args},requestText=canonical(request);
        if(Buffer.byteLength(requestText)>2*1024*1024)fail('REQUEST_LIMIT','Resolved step request exceeds the Compute 2 MiB bound.');
        const tool=await this.catalog(step);
        if(!tool.available||!ajv.compile(tool.input_schema!)(args))fail('TOOL_UNAVAILABLE',`The current schema or dependencies for ${step.tool} do not permit this request.`);
        const current=fingerprint(await this.dependencies.fingerprint(request));
        const key=sha(canonical({fingerprint:current.fingerprint_sha256,upstream:upstream.sort((a,b)=>a.stepId.localeCompare(b.stepId))}));
        const previous=prior.get(id),previousMaterials=previous?.fingerprint?.materials;
        const changedMaterials=previousMaterials
          ? (['request','files','implementation','runtime'] as const).filter(name=>!same(current.materials[name],previousMaterials[name]))
          : ['no_prior_successful_receipt'];
        const base={stepId:id,title:step.title,tool:step.tool,dependencies,requestSha256:sha(requestText),fingerprintSha256:current.fingerprint_sha256,cacheKey:key,changedMaterials,...(previous?.runId?{previousRunId:previous.runId}:{})};
        if(forced.has(id)){
          steps.push({...base,state:'forced',reason:'This node was explicitly forced or is a descendant of a forced node; it will be recomputed.'});
          continue;
        }
        if(!current.cacheable){
          steps.push({...base,state:'execute',reason:current.reasons.join('; ')||'The current method inputs are not declared cacheable.'});
          continue;
        }
        const candidate=await this.reusableResult(workflow.id,workflow.studyId,id,step.tool,request,current,key);
        if('run' in candidate){
          resolved.set(id,candidate.run);
          steps.push({...base,state:'reusable',reason:'The retained result, artifact bytes, source freshness and current fingerprint all verify.'});
        }else steps.push({...base,state:'execute',reason:candidate.reason});
      }catch(error){
        canStart=false;
        steps.push({stepId:id,title:step.title,tool:step.tool,state:'blocked',reason:(error instanceof Error?error.message:String(error)).slice(0,2000),dependencies,changedMaterials:['preview_error']});
      }
    }
    const base={
      schema:'proto-agent.workflow-preview.v1' as const,
      workflowId:workflow.id,
      workflowRevision:workflow.revision,
      requestedForceSteps:[...requestedForceSteps],
      forcedClosure:forcedClosureIds,
      steps,
      comparisonWarnings:warnings,
      canStart,
      resourceEstimate:{state:'unknown' as const,reason:'The current method registry has no verified wall-time, memory, storage, or accelerator estimator for this exact request.'},
    };
    const planSha256=sha(canonical(base));
    return {...base,planSha256,generatedAt:now()};
  }
  private createBranch(studyId:string,sourceWorkflowId:string,sourceRevision:number,name:string):ResearchWorkflow{
    const source=this.definition(studyId,sourceWorkflowId,sourceRevision),draft:WorkflowDraft={name,description:source.description,steps:source.steps};
    return this.transaction(()=>{
      if((this.db!.prepare('SELECT count(*) n FROM research_workflows WHERE study_id=?').get(studyId) as {n:number}).n>=LIMITS.workflowsPerStudy)fail('WORKFLOW_LIMIT','This project has reached its workflow limit.');
      const at=now(),id=randomUUID(),value:ResearchWorkflow={...draft,id,studyId,revision:1,createdAt:at,updatedAt:at,parentBranch:{workflowId:source.id,revision:source.revision,definitionSha256:sha(canonical(source))}},payload=JSON.stringify(value);
      if(Buffer.byteLength(payload)>LIMITS.draftBytes)fail('WORKFLOW_LIMIT','Branch definition exceeds its metadata bound.');
      this.db!.prepare('INSERT INTO research_workflow_versions VALUES(?,?,?)').run(id,1,payload);
      this.db!.prepare('INSERT INTO research_workflows VALUES(?,?,?,?,?,?)').run(id,studyId,1,value.name,at,payload);
      return value;
    });
  }
  private async compareExecutions(studyId:string,leftWorkflowId:string,leftExecutionId:string,rightWorkflowId:string,rightExecutionId:string):Promise<WorkflowExecutionComparison>{
    const left=this.execution(studyId,leftWorkflowId,leftExecutionId).execution,right=this.execution(studyId,rightWorkflowId,rightExecutionId).execution;
    const leftSteps=new Map(left.steps.map(step=>[step.stepId,step])),rightSteps=new Map(right.steps.map(step=>[step.stepId,step]));
    const ids=[...new Set([...left.steps.map(step=>step.stepId),...right.steps.map(step=>step.stepId)])],steps:WorkflowExecutionComparison['steps']=[];
    for(const stepId of ids){
      const a=leftSteps.get(stepId),b=rightSteps.get(stepId),base={stepId,...(a?{leftTool:a.tool,...(a.runId?{leftRunId:a.runId}:{})}:{}),...(b?{rightTool:b.tool,...(b.runId?{rightRunId:b.runId}:{})}:{}),changedArgumentNames:[] as string[],changedMaterials:[] as string[]};
      if(!a||!b){steps.push({...base,state:'missing-result',resultBytes:'unavailable',sourceFreshness:'unavailable'});continue;}
      if(!successful.has(a.status)||!successful.has(b.status)||!a.runId||!b.runId||!a.binding||!b.binding){steps.push({...base,state:'missing-result',resultBytes:'unavailable',sourceFreshness:'unavailable'});continue;}
      try{
        const [runA,runB]=await Promise.all([
          this.dependencies.openRun(a.runId).then(run=>checkedRun(run,a.tool,a.binding)),
          this.dependencies.openRun(b.runId).then(run=>checkedRun(run,b.tool,b.binding)),
        ]);
        if(a.tool!==b.tool){steps.push({...base,state:'different-method',resultBytes:a.binding.resultSha256===b.binding.resultSha256?'same':'different',sourceFreshness:runA.sourceFreshness.status==='current'&&runB.sourceFreshness.status==='current'?'both-current':'stale-or-unknown'});continue;}
        const argumentsA=runA.request!.arguments,argumentsB=runB.request!.arguments,names=[...new Set([...Object.keys(argumentsA),...Object.keys(argumentsB)])];
        const changedArgumentNames=names.filter(name=>Object.hasOwn(argumentsA,name)!==Object.hasOwn(argumentsB,name)||Object.hasOwn(argumentsA,name)&&!same(argumentsA[name],argumentsB[name])).slice(0,100);
        const changedMaterials=a.fingerprint&&b.fingerprint?(['request','files','implementation','runtime'] as const).filter(name=>!same(a.fingerprint!.materials[name],b.fingerprint!.materials[name])):['fingerprint_unavailable'];
        steps.push({
          ...base,
          state:same(runA.request,runB.request)?'comparable-inputs-equal':'comparable-inputs-changed',
          changedArgumentNames,
          changedMaterials,
          resultBytes:a.binding.resultSha256===b.binding.resultSha256?'same':'different',
          sourceFreshness:runA.sourceFreshness.status==='current'&&runB.sourceFreshness.status==='current'?'both-current':'stale-or-unknown',
        });
      }catch{
        steps.push({...base,state:'unverified-result',resultBytes:'unavailable',sourceFreshness:'unavailable'});
      }
    }
    const base={
      schema:'proto-agent.workflow-execution-comparison.v1' as const,
      studyId,
      left:{workflowId:left.workflowId,executionId:left.id,workflowRevision:left.workflowRevision},
      right:{workflowId:right.workflowId,executionId:right.id,workflowRevision:right.workflowRevision},
      steps,
      limits:[
        'Compares saved method, request, fingerprint and result-byte identities only; it does not establish scientific equivalence or causal attribution.',
        'A stale or unknown source freshness state is shown explicitly and does not become current through comparison.',
        'At most 100 changed top-level argument names are returned per step.',
      ],
    };
    return {...base,comparisonSha256:sha(canonical(base)),generatedAt:now()};
  }
  private async ownerState(pid:number){
    if(this.dependencies.ownerState)return this.dependencies.ownerState(pid);
    try{process.kill(pid,0);return 'alive' as const;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'?'dead' as const:'unknown' as const;}
  }
  private async recovery(stored:StoredExecution){
    if(this.jobs.has(stored.execution.id))return {recoveryAvailable:false,recoveryReason:'An owned job is still running; cancel it and wait for termination.'};
    if(!active.has(stored.execution.status))return {recoveryAvailable:stored.execution.status!=='succeeded',recoveryReason:stored.execution.status==='succeeded'?'This execution finished successfully. Start the saved workflow to create another execution.':'The retained terminal attempt is stopped; explicit recovery creates a separate execution.'};
    if(stored.host!==hostname())return {recoveryAvailable:false,recoveryReason:'The recorded owner is on another host; owner death cannot be established.'};
    const state=await this.ownerState(stored.execution.owner.pid);
    return {recoveryAvailable:state==='dead',recoveryReason:state==='dead'?'The owned job is absent and the recorded host process no longer exists. Explicit recovery preserves interruption.':state==='alive'?'The recorded host process is still live; this execution cannot be recovered.':'Owner status is unknown; elapsed time does not establish interruption.'};
  }
  async request(input:unknown):Promise<ResearchWorkflowsResponse>{
    if(this.closing)fail('WORKFLOW_CLOSED','This workspace workflow service is closing.');
    const request=ResearchWorkflowsRequestSchema.parse(input);await this.ready();
    if(this.closing)fail('WORKFLOW_CLOSED','This workspace workflow service is closing.');
    await requestComputeStudies(this.root,{action:'get',studyId:request.studyId},this.options);
    if(request.action==='list'){
      const rows=this.db!.prepare('SELECT id FROM research_workflows WHERE study_id=? ORDER BY updated_at DESC,id DESC LIMIT ?').all(request.studyId,LIMITS.workflowsPerStudy+1) as {id:string}[];
      if(rows.length>LIMITS.workflowsPerStudy)fail('WORKFLOW_LIMIT','The workflow index exceeds its declared bound.');
      return {migrationReport:this.migrationReport,workflows:rows.map(row=>{const value=this.definition(request.studyId,row.id);return {id:value.id,studyId:value.studyId,revision:value.revision,name:value.name,stepCount:value.steps.length,updatedAt:value.updatedAt,...(value.parentBranch?{parentBranch:value.parentBranch}:{})};})};
    }
    if(request.action==='validate')return {validation:await this.validate(request.draft)};
    if(request.action==='save'){
      const validation=await this.validate(request.draft);if(!validation.ok)return {validation};
      const workflow=this.transaction(()=>{
        const previous=request.workflowId?this.definition(request.studyId,request.workflowId):undefined;
        if(previous?request.expectedRevision!==previous.revision:request.expectedRevision!==undefined)fail('WORKFLOW_CONFLICT','Workflow revision changed; reload before saving.');
        if(previous&&previous.revision>=LIMITS.versionsPerWorkflow)fail('WORKFLOW_HISTORY_LIMIT','Workflow version history is full; earlier versions remain retained.');
        if(!previous&&(this.db!.prepare('SELECT count(*) n FROM research_workflows WHERE study_id=?').get(request.studyId) as {n:number}).n>=LIMITS.workflowsPerStudy)fail('WORKFLOW_LIMIT','This project has reached its workflow limit.');
        const at=now(),value:ResearchWorkflow={...request.draft,...(previous?.parentBranch?{parentBranch:previous.parentBranch}:{}),id:previous?.id??randomUUID(),studyId:request.studyId,revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??at,updatedAt:at},payload=JSON.stringify(value);
        if(Buffer.byteLength(payload)>LIMITS.draftBytes)fail('WORKFLOW_LIMIT','Workflow definition exceeds its metadata bound.');
        this.db!.prepare('INSERT INTO research_workflow_versions VALUES(?,?,?)').run(value.id,value.revision,payload);
        if(previous){if(Number(this.db!.prepare('UPDATE research_workflows SET revision=?,name=?,updated_at=?,payload=? WHERE id=? AND revision=?').run(value.revision,value.name,at,payload,value.id,previous.revision).changes)!==1)fail('WORKFLOW_CONFLICT','Workflow changed concurrently.');}
        else this.db!.prepare('INSERT INTO research_workflows VALUES(?,?,?,?,?,?)').run(value.id,value.studyId,value.revision,value.name,at,payload);
        return value;
      });return {workflow,validation};
    }
    if(request.action==='branch')return {workflow:this.createBranch(request.studyId,request.workflowId,request.revision,request.name)};
    if(request.action==='compare-executions')return {comparison:await this.compareExecutions(request.studyId,request.leftWorkflowId,request.leftExecutionId,request.rightWorkflowId,request.rightExecutionId)};
    const workflow=this.definition(request.studyId,request.workflowId,request.action==='get'?request.revision:undefined);
    if(request.action==='get'){
      const versions=(this.db!.prepare('SELECT revision FROM research_workflow_versions WHERE workflow_id=? ORDER BY revision DESC LIMIT ?').all(workflow.id,LIMITS.versionsPerWorkflow+1) as {revision:number}[]).map(row=>{const value=this.definition(workflow.studyId,workflow.id,row.revision);return {revision:value.revision,name:value.name,createdAt:value.updatedAt};});
      const executions=this.db!.prepare('SELECT id,workflow_id AS workflowId,workflow_revision AS workflowRevision,status,json_extract(payload,\'$.createdAt\') AS createdAt,json_extract(payload,\'$.updatedAt\') AS updatedAt FROM research_workflow_executions WHERE workflow_id=? ORDER BY rowid DESC LIMIT ?').all(workflow.id,LIMITS.executionsPerWorkflow) as unknown as NonNullable<ResearchWorkflowsResponse['executions']>;
      return {workflow,versions,executions};
    }
    if(request.action==='preview'){
      if(workflow.revision!==request.expectedRevision)fail('WORKFLOW_CONFLICT','Workflow changed; reload before previewing its run impact.');
      return {preview:await this.buildPreview(workflow,request.forceSteps??[])};
    }
    if(request.action==='start'){
      if(workflow.revision!==request.expectedRevision)fail('WORKFLOW_CONFLICT','Workflow changed; reload before starting.');
      const preview=await this.buildPreview(workflow,request.forceSteps??[]);
      if(!preview.canStart)fail('WORKFLOW_PREVIEW_BLOCKED','The current workflow preview contains blocked nodes; resolve them before starting.');
      if(preview.planSha256!==request.expectedPlanSha256)fail('WORKFLOW_PREVIEW_STALE','Inputs, dependencies, cache evidence, or source fingerprints changed after preview. Review a fresh preview before starting.');
      const execution=this.createExecution(workflow,request.forceSteps??[]);this.launch(execution,workflow);return {execution};
    }
    const stored=this.execution(request.studyId,request.workflowId,request.executionId);
    if(request.action==='get-execution')return {execution:{...stored.execution,...await this.recovery(stored)}};
    if(request.action==='cancel'){
      if(!active.has(stored.execution.status))return {execution:stored.execution};
      const job=this.jobs.get(stored.execution.id);if(!job||stored.execution.owner.instanceId!==this.instanceId)fail('EXECUTION_OWNERSHIP','Only the live owning service can cancel this execution.');
      const execution=this.mutateExecution(stored.execution,value=>{value.cancelRequested=true;});job.controller.abort();return {execution};
    }
    const state=await this.recovery(stored);if(!state.recoveryAvailable)fail('RECOVERY_UNAVAILABLE',state.recoveryReason);
    if(active.has(stored.execution.status))this.mutateExecution(stored.execution,value=>{value.status='interrupted';for(const step of value.steps)if(!terminalStep.has(step.status)){step.status='interrupted';step.finishedAt=now();step.error={code:'OWNER_STOPPED',message:'The owner process stopped before a terminal step receipt. The previous attempt is retained.'};}},true);
    const previousWorkflow=this.definition(request.studyId,request.workflowId,stored.execution.workflowRevision);
    const execution=this.createExecution(previousWorkflow,stored.execution.forceSteps,stored.execution.id);this.launch(execution,previousWorkflow);return {execution};
  }
  private launch(execution:WorkflowExecution,workflow:ResearchWorkflow){
    const controller=new AbortController();
    // Queue work after registration so start returns an observable durable job.
    const job:Job={controller,done:Promise.resolve()};this.jobs.set(execution.id,job);
    job.done=Promise.resolve().then(()=>this.execute(execution,workflow,controller.signal)).finally(()=>this.jobs.delete(execution.id));
  }
  private async execute(identity:WorkflowExecution,workflow:ResearchWorkflow,signal:AbortSignal){
    try{
      this.mutateExecution(identity,value=>{value.status='running';});
      for(const stepId of graph(workflow).order){
        const step=workflow.steps.find(step=>step.id===stepId)!,before=this.execution(identity.studyId,identity.workflowId,identity.id).execution;
        if(signal.aborted||before.cancelRequested){this.mutateExecution(identity,value=>{for(const item of value.steps)if(!terminalStep.has(item.status)){item.status='cancelled';item.finishedAt=now();}value.status='cancelled';});return;}
        const blocked=[...new Set(step.bindings.map(binding=>binding.fromStep))].filter(id=>!successful.has(before.steps.find(item=>item.stepId===id)!.status));
        if(blocked.length){this.mutateExecution(identity,value=>Object.assign(value.steps.find(item=>item.stepId===stepId)!,{status:'blocked',blockedBy:blocked,finishedAt:now()}));continue;}
        this.mutateExecution(identity,value=>Object.assign(value.steps.find(item=>item.stepId===stepId)!,{status:'running',startedAt:now()}));
        try{await this.executeStep(identity,step,signal);}catch(error){
          const detail=error&&typeof error==='object'?error as {code?:unknown;effectState?:unknown;executionState?:unknown}:{};
          const code=typeof detail.code==='string'&&/^[A-Z][A-Z0-9_]{0,119}$/.test(detail.code)?detail.code:signal.aborted?'EXECUTION_CANCELLED':'STEP_FAILED';
          const executionState=detail.executionState==='tool-error'?'tool-error':detail.executionState==='effect-unknown'||detail.effectState==='unknown'||['TOOL_EFFECT_UNKNOWN','TOOL_OPERATION_CONFLICT','TOOL_OPERATION_IN_PROGRESS','WORKSPACE_JOURNAL_UNAVAILABLE'].includes(code)?'effect-unknown':detail.executionState==='no-effect'||detail.effectState==='none'?'no-effect':undefined;
          this.mutateExecution(identity,value=>Object.assign(value.steps.find(item=>item.stepId===stepId)!,{status:signal.aborted?'cancelled':'failed',finishedAt:now(),error:{code,message:(error instanceof Error?error.message:String(error)).slice(0,2000),...(executionState?{executionState}:{})}}));
        }
      }
      this.mutateExecution(identity,value=>{value.status=value.steps.every(step=>successful.has(step.status))?'succeeded':signal.aborted||value.cancelRequested?'cancelled':'failed';});
    }catch(error){
      // A persistence/ownership failure cannot safely be rewritten as success.
      // Keep the last durable unfinished state if even its failure cannot commit.
      try{this.mutateExecution(identity,value=>{value.status=signal.aborted?'cancelled':'failed';for(const step of value.steps)if(!terminalStep.has(step.status)){step.status=signal.aborted?'cancelled':'blocked';step.finishedAt=now();step.error={code:'WORKFLOW_INTERRUPTED',message:(error instanceof Error?error.message:String(error)).slice(0,2000)};}});}catch{/* Exact durable record remains available for explicit owner-checked recovery. */}
    }
  }
  private async executeStep(identity:WorkflowExecution,step:WorkflowStep,signal:AbortSignal){
    const execution=this.execution(identity.studyId,identity.workflowId,identity.id).execution;
    const args=JSON.parse(canonical(step.arguments)) as Record<string,unknown>,upstream:Array<{stepId:string;runId:string;binding:ComputeStudyRunBinding}>=[];
    const opened=new Map<string,ComputeStudyOpenedRun>();
    for(const binding of step.bindings){
      const previous=execution.steps.find(value=>value.stepId===binding.fromStep)!;
      if(!previous.runId||!previous.binding)fail('UPSTREAM_MISSING','An upstream step has no retained result binding.');
      let run=opened.get(binding.fromStep);if(!run){run=checkedRun(await this.dependencies.openRun(previous.runId),previous.tool,previous.binding);opened.set(binding.fromStep,run);upstream.push({stepId:binding.fromStep,runId:previous.runId,binding:previous.binding});}
      const selected=pointer(run.receipt!.result,binding.pointer);if(!typeMatches(selected,binding.type))fail('BINDING_VALUE_TYPE',`Saved result ${binding.fromStep}${binding.pointer} does not have declared type ${binding.type}.`);
      Object.defineProperty(args,binding.argument,{value:JSON.parse(canonical(selected)),enumerable:true,writable:true,configurable:true});
    }
    const request:ComputeRequest={tool:step.tool,arguments:args},requestText=canonical(request);
    if(Buffer.byteLength(requestText)>2*1024*1024)fail('REQUEST_LIMIT','Resolved step request exceeds the Compute 2 MiB bound.');
    const tool=await this.catalog(step);if(!tool.available||!ajv.compile(tool.input_schema!)(args))fail('ARGUMENT_TYPE','Resolved step arguments or the current tool availability do not satisfy the catalog.');
    const current=fingerprint(await this.dependencies.fingerprint(request));
    const key=sha(canonical({fingerprint:current.fingerprint_sha256,upstream:upstream.sort((a,b)=>a.stepId.localeCompare(b.stepId))}));
    const forced=execution.forceSteps.includes(step.id);
    this.mutateExecution(identity,value=>Object.assign(value.steps.find(item=>item.stepId===step.id)!,{fingerprint:current,cacheKey:key,cacheReason:forced?'Forced step or descendant.':current.cacheable?'Checking retained result bytes and current source fingerprints.':current.reasons.join('; ').slice(0,2000),...(Buffer.byteLength(requestText)<=32768?{request}:{})}));
    const cached=this.db!.prepare('SELECT payload FROM research_workflow_cache WHERE workflow_id=? AND step_id=? AND cache_key=? AND length(CAST(payload AS BLOB))<65536').get(identity.workflowId,step.id,key) as {payload:string}|undefined;
    if(cached&&current.cacheable&&!forced){
      try{
        const entry=JSON.parse(cached.payload) as CacheRecord;
        if(entry.workflowId!==identity.workflowId||entry.stepId!==step.id||entry.key!==key)fail('CACHE_IDENTITY','Cached step identity is inconsistent.');
        const prior=this.execution(identity.studyId,identity.workflowId,entry.executionId).execution.steps.find(item=>item.stepId===step.id);
        if(!prior||!successful.has(prior.status)||prior.runId!==entry.runId||prior.cacheKey!==key||!same(prior.binding,entry.binding))fail('CACHE_IDENTITY','Cache entry does not match a retained terminal attempt.');
        const run=checkedRun(await this.dependencies.openRun(entry.runId),step.tool,entry.binding,true);
        if(!same(run.request,request)||!matchingExecutionFingerprint(run,current,true))fail('CACHE_FINGERPRINT','Saved execution fingerprint does not match current inputs and runtime.');
        const confirmed=fingerprint(await this.dependencies.fingerprint(request));
        if(!confirmed.cacheable||confirmed.fingerprint_sha256!==current.fingerprint_sha256)fail('CACHE_FINGERPRINT','Inputs or runtime changed while checking the cached result.');
        if(signal.aborted)fail('EXECUTION_CANCELLED','Execution was cancelled while checking a saved result.');
        this.mutateExecution(identity,value=>Object.assign(value.steps.find(item=>item.stepId===step.id)!,{status:'reused',finishedAt:now(),runId:entry.runId,binding:run.binding,reusedFromExecutionId:entry.executionId,cacheReason:'Exact retained result, current sources and execution fingerprint verified.'}));return;
      }catch(error){this.mutateExecution(identity,value=>{value.steps.find(item=>item.stepId===step.id)!.cacheReason=`Cached result not reused: ${(error instanceof Error?error.message:String(error)).slice(0,1500)}`;});}
    }
    if(signal.aborted)fail('EXECUTION_CANCELLED','Execution was cancelled before running the step.');
    const attempt=this.db!.prepare('SELECT id FROM research_workflow_attempts WHERE execution_id=? AND step_id=?').get(identity.id,step.id) as {id:string};
    const operationId=execution.steps.find(item=>item.stepId===step.id)?.operationId??attempt.id;
    const receipt:ComputeRun=await this.dependencies.run(request,{signal,executionId:identity.id,stepId:step.id,attemptId:attempt.id,operationId});
    if(signal.aborted){
      if(typeof receipt.run_id==='string'&&/^[a-f0-9]{32}$/.test(receipt.run_id)){
        let observedBinding:ComputeStudyRunBinding|undefined;
        try{observedBinding=checkedRun(await this.dependencies.openRun(receipt.run_id),step.tool).binding;}catch{/* Keep the returned identity even if its bytes cannot yet verify. */}
        this.mutateExecution(identity,value=>Object.assign(value.steps.find(item=>item.stepId===step.id)!,{status:'cancelled',finishedAt:now(),runId:receipt.run_id,...(observedBinding?{binding:observedBinding}:{}),cacheReason:'A result identity returned after cancellation; retained for effect review, never cached or promoted to success.',error:{code:'EXECUTION_CANCELLED',message:'Cancellation was requested before this completed result could be accepted.'}}));return;
      }
      fail('EXECUTION_CANCELLED','The interrupted attempt is retained; its result is not promoted to a successful workflow step.');
    }
    if(receipt.ok!==true)throw Object.assign(new ResearchWorkflowError('COMPUTE_FAILED',receipt.diagnostics?.map(item=>item.message).join('; ').slice(0,1800)||'The Compute step returned a failed execution receipt.'),{executionState:'tool-error'});
    if(!receipt.run_id)fail('COMPUTE_FAILED','The Compute step did not return a saved execution identity.');
    const run=checkedRun(await this.dependencies.openRun(receipt.run_id),step.tool);
    if(!same(run.request,request)||!matchingExecutionFingerprint(run,current,false))fail('EXECUTION_FINGERPRINT','Execution inputs or runtime changed between preparation and the saved result.');
    const reusable=matchingExecutionFingerprint(run,current,true)&&run.sourceFreshness.status==='current';
    this.mutateExecution(identity,value=>{
      const saved=value.steps.find(item=>item.stepId===step.id)!,prior=saved.cacheReason?.startsWith('Cached result not reused:')?saved.cacheReason+' ':'';
      Object.assign(saved,{status:'succeeded',finishedAt:now(),runId:run.runId,binding:run.binding,cacheReason:prior+(reusable?'Fresh result saved; eligible for later verified reuse.':'Saved execution succeeded; source freshness or post-execution fingerprint prevents cache reuse.')});
    });
    if(reusable)this.transaction(()=>{
      const entry:CacheRecord={key,workflowId:identity.workflowId,stepId:step.id,executionId:identity.id,runId:run.runId,binding:run.binding!};
      this.db!.prepare('INSERT INTO research_workflow_cache VALUES(?,?,?,?) ON CONFLICT(workflow_id,step_id,cache_key) DO UPDATE SET payload=excluded.payload').run(identity.workflowId,step.id,key,JSON.stringify(entry));
    });
  }
  async wait(executionId:string):Promise<void>{await this.jobs.get(executionId)?.done;}
  async close():Promise<void>{this.closing=true;await this.initialization?.catch(()=>{});for(const job of this.jobs.values())job.controller.abort();await Promise.allSettled([...this.jobs.values()].map(job=>job.done));this.db?.close();this.db=undefined;}
}
