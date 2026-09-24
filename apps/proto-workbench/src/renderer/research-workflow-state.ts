import {createStore} from "zustand/vanilla";
import type {ComputeCatalog,ComputeTool} from "../shared/compute.ts";
import type {ComputeStudy,ComputeStudyOpenedRun} from "../shared/compute-studies.ts";
import {RESEARCH_WORKFLOW_LIMITS,WorkflowDraftSchema,WorkflowStepSchema,type WorkflowDraft,type WorkflowStep,type ResearchWorkflow,type ResearchWorkflowSummary,type WorkflowVersionSummary,type WorkflowValidation,type WorkflowPreview,type WorkflowExecution,type WorkflowExecutionComparison,type WorkflowExecutionSummary,type ResearchWorkflowsRequest,type ResearchWorkflowsResponse} from "../shared/research-workflows.ts";

export type WorkflowRequester=(request:ResearchWorkflowsRequest)=>Promise<ResearchWorkflowsResponse>;
export type WorkflowEditor={key:string;draft:WorkflowDraft;argumentsText:Record<string,string>;baseline?:ResearchWorkflow;remoteRevision?:number;dirty:boolean};
type Session={editors:WorkflowEditor[];selectedKey?:string;executionSelection:Record<string,string>};
const copy=<T>(value:T):T=>structuredClone(value),equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),message=(error:unknown)=>error instanceof Error?error.message:String(error);
const json=(value:unknown)=>JSON.stringify(value,null,2);
export const workflowDraft=(record:ResearchWorkflow):WorkflowDraft=>({name:record.name,description:record.description,steps:copy(record.steps)});
const texts=(draft:WorkflowDraft)=>Object.fromEntries(draft.steps.map(step=>[step.id,json(step.arguments)]));
export const selectedWorkflow=(state:Pick<ResearchWorkflowState,"editors"|"selectedKey">)=>state.editors.find(editor=>editor.key===state.selectedKey);
export const workflowScopeReady=(state:Pick<ResearchWorkflowState,"workspace"|"study">,workspace:string,study:ComputeStudy)=>state.workspace===workspace&&state.study?.id===study.id&&state.study?.revision===study.revision;
export const workflowExecutionActive=(execution?:Pick<WorkflowExecution,"status">)=>execution?.status==="running"||execution?.status==="pending";
export function workflowResultMatches(step:WorkflowExecution["steps"][number],run:ComputeStudyOpenedRun):boolean {
  if(!["succeeded","reused"].includes(step.status)||!step.runId||!step.binding||step.binding.tool!==step.tool||run.runId!==step.runId||run.integrity.status!=="verified"||!run.binding||!run.request||run.receipt?.ok!==true||run.request.tool!==step.tool||run.receipt.tool!==step.tool)return false;
  return (["tool","createdAt","manifestSha256","provenanceSha256","inputSha256","resultSha256"]as const).every(key=>step.binding![key]===run.binding![key]);
}

export function parseWorkflowArguments(raw:string):Record<string,unknown> {
  if(new TextEncoder().encode(raw).byteLength>RESEARCH_WORKFLOW_LIMITS.draftBytes)throw Error("Literal arguments exceed the 2 MiB workflow limit.");
  let value:unknown;try{value=JSON.parse(raw);}catch{throw Error("Literal arguments must be valid JSON. Your text has been retained.");}
  if(!value||Array.isArray(value)||typeof value!=="object")throw Error("Literal arguments must be a JSON object.");
  let nodes=0;const visit=(item:unknown,depth:number):void=>{if(++nodes>100000||depth>20)throw Error("Literal arguments exceed the supported nesting or value count.");if(typeof item==="number"&&(!Number.isFinite(item)||Math.abs(item)>1e100))throw Error("Literal numbers must be finite and within ±1e100.");if(item&&typeof item==="object")for(const[key,next]of Object.entries(item)){if(["__proto__","prototype","constructor"].includes(key))throw Error("Prototype keys cannot be workflow arguments.");visit(next,depth+1);}};visit(value,0);return value as Record<string,unknown>;
}
export function materializeWorkflowEditor(editor:WorkflowEditor):WorkflowDraft {
  const candidate={...editor.draft,steps:editor.draft.steps.map(step=>({...step,arguments:parseWorkflowArguments(editor.argumentsText[step.id]??json(step.arguments))}))};
  const parsed=WorkflowDraftSchema.safeParse(candidate);if(!parsed.success)throw Error(parsed.error.issues.map(issue=>`${issue.path.join(".")}: ${issue.message}`).join("; "));
  if(new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength>RESEARCH_WORKFLOW_LIMITS.draftBytes)throw Error("The complete workflow exceeds 2 MiB.");return parsed.data;
}
function changed(editor:WorkflowEditor){if(!editor.baseline)return true;try{return !equal(materializeWorkflowEditor(editor),workflowDraft(editor.baseline));}catch{return true;}}
export function acceptWorkflow(editor:WorkflowEditor,submitted:WorkflowEditor,record:ResearchWorkflow):WorkflowEditor {
  const untouched=equal(editor.draft,submitted.draft)&&equal(editor.argumentsText,submitted.argumentsText),draft=untouched?workflowDraft(record):editor.draft;
  const next={key:record.id,draft,argumentsText:untouched?texts(draft):editor.argumentsText,baseline:record,dirty:false};return {...next,dirty:changed(next)};
}
export function moveWorkflowStep(steps:WorkflowStep[],id:string,direction:-1|1){const index=steps.findIndex(step=>step.id===id),target=index+direction;if(index<0||target<0||target>=steps.length)return steps;const next=[...steps];[next[index],next[target]]=[next[target],next[index]];return next;}

export interface ResearchWorkflowState {
  workspace:string;study?:ComputeStudy;workflows:ResearchWorkflowSummary[];editors:WorkflowEditor[];selectedKey?:string;
  catalog?:ComputeCatalog;toolDetails:Record<string,ComputeTool>;catalogBusy:boolean;toolBusy?:string;listBusy:boolean;opening:boolean;busy?:"save"|"validate"|"preview"|"start"|"cancel"|"recover"|"version";
  versions:WorkflowVersionSummary[];historical?:ResearchWorkflow;validation?:WorkflowValidation;preview?:WorkflowPreview;comparison?:WorkflowExecutionComparison;branchSource?:{workflow:ResearchWorkflow;executions:WorkflowExecutionSummary[]};execution?:WorkflowExecution;executions:WorkflowExecutionSummary[];executionBusy:boolean;branchSourceBusy:boolean;comparisonBusy:boolean;error?:string;notice?:string;
  activate(workspace:string,study?:ComputeStudy):void;suspend():void;loadCatalog():Promise<void>;loadTool(id:string):Promise<ComputeTool|undefined>;
  list():Promise<void>;create():void;select(key:string):Promise<void>;reload():Promise<void>;viewVersion(revision?:number):Promise<void>;useHistorical():Promise<void>;
  edit(change:Partial<Pick<WorkflowDraft,"name"|"description">>):void;editStep(id:string,change:Partial<WorkflowStep>):void;editArguments(id:string,text:string):void;addStep(toolId:string):Promise<void>;removeStep(id:string):void;moveStep(id:string,direction:-1|1):void;
  validate():Promise<boolean>;save():Promise<boolean>;forkVersion(name:string):Promise<boolean>;loadBranchSource():Promise<void>;compareExecutions(leftWorkflowId:string,leftExecutionId:string,rightWorkflowId:string,rightExecutionId:string):Promise<boolean>;previewPlan(forceSteps?:string[]):Promise<WorkflowPreview|undefined>;start(forceSteps?:string[]):Promise<boolean>;selectExecution(id:string):Promise<void>;refreshExecution():Promise<void>;cancel():Promise<boolean>;recover(acknowledged:boolean):Promise<boolean>;
}

/** Authoring state is scoped to workspace/project/selection generations. Execution
 * status always comes from the host, never from an elapsed timer or local guess. */
export function createResearchWorkflowStore(request:WorkflowRequester,catalog:(tool?:string)=>Promise<ComputeCatalog>){
  let epoch=0;const counters=new Map<string,number>(),sessions=new Map<string,Session>();let executionSelection:Record<string,string>={};
  return createStore<ResearchWorkflowState>((set,get)=>{
    const clean=()=>({catalogBusy:false,toolBusy:undefined,listBusy:false,opening:false,busy:undefined,executionBusy:false,branchSourceBusy:false,comparisonBusy:false,preview:undefined,comparison:undefined,branchSource:undefined});
    const token=(kind:string)=>{const count=(counters.get(kind)??0)+1;counters.set(kind,count);return {epoch,kind,count};};
    const current=(value:ReturnType<typeof token>)=>value.epoch===epoch&&counters.get(value.kind)===value.count;
    const invalidate=()=>{epoch++;set(clean());};
    const remember=()=>{const state=get();if(state.study)sessions.set(state.study.id,{editors:state.editors,selectedKey:state.selectedKey,executionSelection});};
    const setEditor=(editor:WorkflowEditor,old=editor.key)=>{set({editors:get().editors.some(item=>item.key===old)?get().editors.map(item=>item.key===old?editor:item):[...get().editors,editor],selectedKey:editor.key});remember();};
    const amend=(fn:(editor:WorkflowEditor)=>WorkflowEditor)=>{const old=selectedWorkflow(get());if(!old||get().historical)return;const next=fn(old);setEditor({...next,dirty:changed(next)});token("validation");token("preview");set({validation:undefined,preview:undefined,error:undefined,notice:undefined,...(["validate","preview"].includes(get().busy??"")?{busy:undefined}:{})});};
    const assertWorkflow=(record:ResearchWorkflow|undefined,id?:string,revision?:number)=>{if(!record||record.studyId!==get().study?.id||(id&&record.id!==id)||(revision!==undefined&&record.revision!==revision)||!Number.isSafeInteger(record.revision)||record.revision<1||!WorkflowDraftSchema.safeParse(workflowDraft(record)).success)throw Error("The saved workflow identity or definition does not match this request.");return record;};
    const refreshSummary=(record:ResearchWorkflow)=>{token("list");set({listBusy:false,workflows:[{id:record.id,studyId:record.studyId,revision:record.revision,name:record.name,stepCount:record.steps.length,updatedAt:record.updatedAt,...(record.parentBranch?{parentBranch:record.parentBranch}:{})},...get().workflows.filter(item=>item.id!==record.id)]});};
    const assertExecution=(execution:WorkflowExecution|undefined,id?:string,revision?:number)=>{const editor=selectedWorkflow(get());if(!execution||execution.studyId!==get().study?.id||execution.workflowId!==editor?.baseline?.id||(id&&execution.id!==id)||(revision!==undefined&&execution.workflowRevision!==revision)||!Number.isSafeInteger(execution.workflowRevision)||execution.workflowRevision<1||!["pending","running","succeeded","failed","cancelled","interrupted"].includes(execution.status)||!Array.isArray(execution.steps)||execution.steps.length>16||new Set(execution.steps.map(step=>step.stepId)).size!==execution.steps.length||execution.steps.some(step=>!["pending","running","reused","succeeded","failed","blocked","cancelled","interrupted"].includes(step.status)||step.runId!==undefined&&!/^[a-f0-9]{32}$/.test(step.runId)))throw Error("The execution identity or state does not match this workflow.");return execution;};
    const setExecution=(execution:WorkflowExecution)=>{executionSelection={...executionSelection,[execution.workflowId]:execution.id};set({execution,executions:[{id:execution.id,workflowId:execution.workflowId,workflowRevision:execution.workflowRevision,status:execution.status,createdAt:execution.createdAt,updatedAt:execution.updatedAt},...get().executions.filter(item=>item.id!==execution.id)].slice(0,100)});remember();};
    const mutateExecution=async(action:"cancel"|"recover",acknowledged=false)=>{const state=get(),execution=state.execution;if(!state.study||!execution||state.busy)return false;if(action==="cancel"&&(!workflowExecutionActive(execution)||execution.cancelRequested))return false;if(action==="recover"&&(!acknowledged||!execution.recoveryAvailable)){set({error:"Review and acknowledge the previous execution before requesting recovery."});return false;}const active=token("execution-mutation");token("execution");set({busy:action,executionBusy:false,error:undefined});try{const response=await request({action,studyId:state.study.id,workflowId:execution.workflowId,executionId:execution.id,...(action==="recover"?{acknowledgeInterrupted:true as const}:{})} as ResearchWorkflowsRequest);if(!current(active))return false;const returned=assertExecution(response.execution,action==="cancel"?execution.id:undefined);setExecution(returned);set({notice:action==="cancel"?"Cancellation requested; the host reports when execution has stopped.":"The host returned the recovered execution. Earlier attempts remain in its history."});return true;}catch(error){if(current(active))set({error:message(error)});return false;}finally{if(current(active))set({busy:undefined});}};
    return {workspace:"",workflows:[],editors:[],toolDetails:{},versions:[],executions:[],...clean(),
      activate(workspace,study){const old=get();if(old.workspace===workspace&&old.study?.id===study?.id&&old.study?.revision===study?.revision){set({study});return;}remember();invalidate();if(old.workspace!==workspace)sessions.clear();const session=study?sessions.get(study.id):undefined,same=old.workspace===workspace&&old.study?.id===study?.id;executionSelection=session?.executionSelection??{};set({workspace,study,editors:session?.editors??[],selectedKey:session?.selectedKey,workflows:same?old.workflows:[],catalog:old.workspace===workspace?old.catalog:undefined,toolDetails:old.workspace===workspace?old.toolDetails:{},historical:undefined,validation:undefined,versions:[],executions:[],execution:undefined,error:undefined,notice:undefined});},
      suspend(){remember();invalidate();},
      async loadCatalog(){if(get().catalogBusy)return;const active=token("catalog");set({catalogBusy:true,error:undefined});try{const response=await catalog();if(!current(active))return;if(!response.ok||!Array.isArray(response.tools))throw Error("The local method catalog was not returned.");set({catalog:response});}catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({catalogBusy:false});}},
      async loadTool(id){const cached=get().toolDetails[id];if(cached)return cached;const active=token("tool");set({toolBusy:id,error:undefined});try{const response=await catalog(id);if(!current(active))return;const tool=response.tools?.[0];if(!response.ok||response.tools.length!==1||tool?.id!==id||!tool.input_schema)throw Error("The selected method schema was not returned.");set({toolDetails:{...get().toolDetails,[id]:tool}});return tool;}catch(error){if(current(active))set({error:message(error)});return;}finally{if(current(active))set({toolBusy:undefined});}},
      async list(){const study=get().study;if(!study)return;const active=token("list");set({listBusy:true,error:undefined});try{const response=await request({action:"list",studyId:study.id});if(!current(active))return;if(!response.workflows||response.workflows.some(item=>item.studyId!==study.id))throw Error("The project workflow list was not returned.");set({workflows:response.workflows});}catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({listBusy:false});}},
      create(){if(!get().study)return;invalidate();const draft={name:"Untitled workflow",description:"",steps:[]};setEditor({key:`draft-${crypto.randomUUID()}`,draft,argumentsText:{},dirty:true});set({versions:[],historical:undefined,validation:undefined,executions:[],execution:undefined,error:undefined,notice:undefined});},
      async select(key){if(!get().study)return;invalidate();set({selectedKey:key,historical:undefined,validation:undefined,versions:[],executions:[],execution:undefined,error:undefined,notice:undefined});remember();const cached=selectedWorkflow(get());if(cached&&!cached.baseline)return;const study=get().study!,active=token("open");set({opening:true});try{const response=await request({action:"get",studyId:study.id,workflowId:key});if(!current(active))return;const record=assertWorkflow(response.workflow,key),latest=selectedWorkflow(get());if(latest?.baseline){if(record.revision!==latest.baseline.revision)setEditor({...latest,remoteRevision:record.revision});}else{const draft=workflowDraft(record);setEditor({key:record.id,draft,argumentsText:texts(draft),baseline:record,dirty:false});}refreshSummary(record);set({versions:response.versions??[],executions:(response.executions??[]).filter(item=>item.workflowId===record.id)});const previous=executionSelection[record.id];if(previous)await get().selectExecution(previous);}catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({opening:false});}},
      async reload(){const editor=selectedWorkflow(get()),study=get().study;if(!editor?.baseline||!study||get().busy)return;invalidate();const active=token("open");set({opening:true,historical:undefined,validation:undefined,error:undefined});try{const response=await request({action:"get",studyId:study.id,workflowId:editor.baseline.id});if(!current(active))return;const record=assertWorkflow(response.workflow,editor.baseline.id),draft=workflowDraft(record);setEditor({key:record.id,draft,argumentsText:texts(draft),baseline:record,dirty:false});refreshSummary(record);set({versions:response.versions??[],executions:response.executions??[]});}catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({opening:false});}},
      async viewVersion(revision){const editor=selectedWorkflow(get()),study=get().study;if(!editor?.baseline||!study||get().busy)return;token("version");if(revision===undefined){set({historical:undefined,error:undefined});return;}const active=token("version");set({busy:"version",error:undefined});try{const response=await request({action:"get",studyId:study.id,workflowId:editor.baseline.id,revision});if(!current(active))return;set({historical:assertWorkflow(response.workflow,editor.baseline.id,revision),versions:response.versions??get().versions});}catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({busy:undefined});}},
      async useHistorical(){const state=get(),history=state.historical,editor=selectedWorkflow(state);if(!state.study||!history||!editor?.baseline||state.busy)return;const active=token("version");set({busy:"version",error:undefined});try{const response=await request({action:"get",studyId:state.study.id,workflowId:editor.baseline.id});if(!current(active))return;const latest=assertWorkflow(response.workflow,editor.baseline.id),draft=workflowDraft(history),next={key:latest.id,draft,argumentsText:texts(draft),baseline:latest,dirty:true};setEditor({...next,dirty:changed(next)});refreshSummary(latest);set({historical:undefined,validation:undefined,versions:response.versions??[],notice:`Historical revision ${history.revision} copied into a draft against current revision ${latest.revision}. Save to create a new revision.`});}catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({busy:undefined});}},
      edit(change){amend(editor=>({...editor,draft:{...editor.draft,...change}}));},
      editStep(id,change){amend(editor=>({...editor,draft:{...editor.draft,steps:editor.draft.steps.map(step=>step.id===id?{...step,...copy(change),id}:step)},argumentsText:Object.hasOwn(change,"arguments")?{...editor.argumentsText,[id]:json(change.arguments)}:editor.argumentsText}));},
      editArguments(id,raw){amend(editor=>({...editor,argumentsText:{...editor.argumentsText,[id]:raw}}));},
      async addStep(toolId){const editor=selectedWorkflow(get());if(!editor||editor.draft.steps.length>=16||get().historical)return;const active=token("add-step"),key=editor.key,tool=await get().loadTool(toolId);if(!tool||!current(active)||selectedWorkflow(get())?.key!==key)return;try{amend(latest=>{let number=1;while(latest.draft.steps.some(step=>step.id===`step-${number}`))number++;const step=WorkflowStepSchema.parse({id:`step-${number}`,title:tool.title,tool:tool.id,arguments:copy(tool.example??{}),bindings:[]});return {...latest,draft:{...latest.draft,steps:[...latest.draft.steps,step]},argumentsText:{...latest.argumentsText,[step.id]:json(step.arguments)}};});}catch(error){set({error:`The method example is not valid workflow data: ${message(error)}`});}},
      removeStep(id){amend(editor=>{const argumentsText={...editor.argumentsText};delete argumentsText[id];return {...editor,argumentsText,draft:{...editor.draft,steps:editor.draft.steps.filter(step=>step.id!==id)}};});},
      moveStep(id,direction){amend(editor=>({...editor,draft:{...editor.draft,steps:moveWorkflowStep(editor.draft.steps,id,direction)}}));},
      async validate(){const editor=selectedWorkflow(get()),study=get().study;if(!editor||!study||get().busy||get().historical)return false;let draft:WorkflowDraft;try{draft=materializeWorkflowEditor(editor);}catch(error){set({error:message(error)});return false;}const active=token("validation");set({busy:"validate",error:undefined});try{const response=await request({action:"validate",studyId:study.id,draft});if(!current(active))return false;if(!response.validation)throw Error("The host validation result was not returned.");set({validation:response.validation});return response.validation.ok;}catch(error){if(current(active))set({error:message(error)});return false;}finally{if(current(active))set({busy:undefined});}},
      async save(){const editor=selectedWorkflow(get()),study=get().study;if(!editor||!study||get().busy||get().historical||editor.remoteRevision)return false;let draft:WorkflowDraft;try{draft=materializeWorkflowEditor(editor);}catch(error){set({error:message(error)});return false;}const active=token("save"),submitted=copy(editor);set({busy:"save",error:undefined});try{const response=await request({action:"save",studyId:study.id,...(editor.baseline?{workflowId:editor.baseline.id,expectedRevision:editor.baseline.revision}:{}),draft});if(!current(active))return false;const record=assertWorkflow(response.workflow,editor.baseline?.id),latest=selectedWorkflow(get());if(!latest||latest.key!==editor.key)return false;setEditor(acceptWorkflow(latest,submitted,record),editor.key);refreshSummary(record);set({versions:response.versions??[{revision:record.revision,name:record.name,createdAt:record.updatedAt},...get().versions],validation:undefined,notice:`Workflow saved at revision ${record.revision}.`});return true;}catch(error){if(current(active))set({error:message(error)});return false;}finally{if(current(active))set({busy:undefined});}},
      async forkVersion(name){
        const state=get(),editor=selectedWorkflow(state),study=state.study,source=state.historical??editor?.baseline;
        if(!editor?.baseline||!source||!study||state.busy||editor.dirty||editor.remoteRevision)return false;
        const active=token("branch");set({busy:"version",error:undefined,notice:undefined,comparison:undefined});
        try{
          const response=await request({action:"branch",studyId:study.id,workflowId:source.id,revision:source.revision,name});
          if(!current(active))return false;
          const record=assertWorkflow(response.workflow,undefined,1),origin=record.parentBranch;
          if(!origin||origin.workflowId!==source.id||origin.revision!==source.revision||!/^[a-f0-9]{64}$/.test(origin.definitionSha256))throw Error("The returned branch does not match the selected immutable source revision.");
          const draft=workflowDraft(record),next={key:record.id,draft,argumentsText:texts(draft),baseline:record,dirty:false};
          setEditor(next,editor.key);refreshSummary(record);set({versions:[{revision:1,name:record.name,createdAt:record.createdAt}],historical:undefined,validation:undefined,preview:undefined,comparison:undefined,branchSource:undefined,executions:[],execution:undefined,notice:`Created an independent branch from revision ${source.revision}. Existing executions remain on the source workflow; no execution or active goal was copied.`});
          return true;
        }catch(error){if(current(active))set({error:message(error)});return false;}
        finally{if(current(active))set({busy:undefined});}
      },
      async loadBranchSource(){
        const state=get(),editor=selectedWorkflow(state),study=state.study,origin=editor?.baseline?.parentBranch;
        if(!study||!origin)return;
        const active=token("branch-source");set({branchSourceBusy:true,error:undefined});
        try{
          const response=await request({action:"get",studyId:study.id,workflowId:origin.workflowId,revision:origin.revision});
          if(!current(active))return;
          const workflow=assertWorkflow(response.workflow,origin.workflowId,origin.revision);
          if(!response.executions||workflow.studyId!==study.id)throw Error("The immutable source branch and execution index were not returned.");
          set({branchSource:{workflow,executions:response.executions.filter(item=>item.workflowId===origin.workflowId)},comparison:undefined});
        }catch(error){if(current(active))set({error:message(error),branchSource:undefined});}
        finally{if(current(active))set({branchSourceBusy:false});}
      },
      async compareExecutions(leftWorkflowId,leftExecutionId,rightWorkflowId,rightExecutionId){
        const study=get().study;if(!study||get().busy||!leftWorkflowId||!leftExecutionId||!rightWorkflowId||!rightExecutionId)return false;
        const active=token("comparison");set({comparisonBusy:true,error:undefined});
        try{
          const response=await request({action:"compare-executions",studyId:study.id,leftWorkflowId,leftExecutionId,rightWorkflowId,rightExecutionId});
          if(!current(active))return false;
          const value=response.comparison;
          if(!value||value.schema!=="proto-agent.workflow-execution-comparison.v1"||value.studyId!==study.id||value.left.workflowId!==leftWorkflowId||value.left.executionId!==leftExecutionId||value.right.workflowId!==rightWorkflowId||value.right.executionId!==rightExecutionId||!/^[a-f0-9]{64}$/.test(value.comparisonSha256))throw Error("The host comparison does not match the selected execution pair.");
          set({comparison:value});return true;
        }catch(error){if(current(active))set({error:message(error),comparison:undefined});return false;}
        finally{if(current(active))set({comparisonBusy:false});}
      },
      async previewPlan(forceSteps=[]){
        const editor=selectedWorkflow(get()),study=get().study;
        if(!editor?.baseline||!study||get().busy||editor.dirty||editor.remoteRevision||get().historical||workflowExecutionActive(get().execution))return;
        if(forceSteps.some(id=>!editor.baseline!.steps.some(step=>step.id===id))){set({error:"Forced steps must belong to this saved workflow revision."});return;}
        const selected=[...new Set(forceSteps)].sort(),active=token("preview");
        set({busy:"preview",preview:undefined,error:undefined,notice:undefined});
        try{
          const response=await request({action:"preview",studyId:study.id,workflowId:editor.baseline.id,expectedRevision:editor.baseline.revision,...(selected.length?{forceSteps:selected}:{})});
          if(!current(active))return;
          const plan=response.preview;
          if(!plan||plan.schema!=="proto-agent.workflow-preview.v1"||plan.workflowId!==editor.baseline.id||plan.workflowRevision!==editor.baseline.revision||plan.planSha256.length!==64||!/^[a-f0-9]{64}$/.test(plan.planSha256)||plan.requestedForceSteps.join("\0")!==selected.join("\0")||plan.steps.length!==editor.baseline.steps.length||plan.steps.length>RESEARCH_WORKFLOW_LIMITS.steps)throw Error("The host run-impact preview did not match the selected workflow revision.");
          set({preview:plan,notice:plan.canStart?"Run-impact preview is ready. The host will recheck this exact plan before starting.":"The host preview found blocked nodes; resolve the listed issues before starting."});
          return plan;
        }catch(error){if(current(active))set({error:message(error),preview:undefined});return;}
        finally{if(current(active))set({busy:undefined});}
      },
      async start(forceSteps=[]){
        const state=get(),editor=selectedWorkflow(state),study=state.study,plan=state.preview,selected=[...new Set(forceSteps)].sort();
        if(!editor?.baseline||!study||state.busy||editor.dirty||editor.remoteRevision||state.historical||workflowExecutionActive(state.execution))return false;
        if(!plan||!plan.canStart||plan.workflowId!==editor.baseline.id||plan.workflowRevision!==editor.baseline.revision||plan.requestedForceSteps.join("\0")!==selected.join("\0")){set({error:"Preview the current workflow revision and forced-step selection before starting."});return false;}
        const active=token("start");token("execution");set({busy:"start",executionBusy:false,error:undefined});
        try{
          const response=await request({action:"start",studyId:study.id,workflowId:editor.baseline.id,expectedRevision:editor.baseline.revision,expectedPlanSha256:plan.planSha256,...(selected.length?{forceSteps:selected}:{})});
          if(!current(active))return false;
          setExecution(assertExecution(response.execution,undefined,editor.baseline.revision));
          set({notice:"Execution accepted by the host after it recomputed the preview plan. Step states below report actual execution and reuse."});return true;
        }catch(error){if(current(active))set({error:message(error),preview:undefined});return false;}
        finally{if(current(active))set({busy:undefined});}
      },
      async selectExecution(id){const editor=selectedWorkflow(get()),study=get().study;if(!editor?.baseline||!study)return;const active=token("execution");token("execution-mutation");set({executionBusy:true,execution:undefined,error:undefined,...(["cancel","recover"].includes(get().busy??"")?{busy:undefined}:{})});try{const response=await request({action:"get-execution",studyId:study.id,workflowId:editor.baseline.id,executionId:id});if(!current(active))return;setExecution(assertExecution(response.execution,id));}catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({executionBusy:false});}},
      async refreshExecution(){const state=get(),execution=state.execution;if(!state.study||!execution||state.executionBusy||state.busy)return;const active=token("execution");set({executionBusy:true});try{const response=await request({action:"get-execution",studyId:state.study.id,workflowId:execution.workflowId,executionId:execution.id});if(!current(active))return;setExecution(assertExecution(response.execution,execution.id));}catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({executionBusy:false});}},
      cancel(){return mutateExecution("cancel");},recover(acknowledged){return mutateExecution("recover",acknowledged);},
    };
  });
}
