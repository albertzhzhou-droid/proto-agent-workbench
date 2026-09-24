import {createStore} from "zustand/vanilla";
import type {ComputeStudiesPage,ComputeStudiesRequest,ComputeStudiesResponse,ComputeStudy,ComputeStudyOpenedRun,ComputeStudyRunSummary,ComputeStudySummary} from "../shared/compute-studies.ts";
import {createStudyRequestScope} from "./research-study-comparison.ts";

export const STUDY_RUN_WINDOW=120;
export type StudyEditorDraft={name:string;question:string;baseline?:number;saved:boolean};
type StudyEditorAction=
  | {type:"edit";field:"name"|"question";value:string}
  | {type:"record";study:ComputeStudy}
  | {type:"reload";study:ComputeStudy}
  | {type:"saving"}
  | {type:"accepted";submitted:StudyEditorDraft};
export const studyEditorDraft=(study?:ComputeStudy):StudyEditorDraft=>({name:study?.name??"",question:study?.question??"",baseline:study?.revision,saved:false});
export function reduceStudyEditorDraft(draft:StudyEditorDraft,action:StudyEditorAction):StudyEditorDraft {
  if(action.type==="edit")return {...draft,[action.field]:action.value,saved:false};
  if(action.type==="reload")return studyEditorDraft(action.study);
  if(action.type==="record")return draft.name===action.study.name&&draft.question===action.study.question?{...draft,baseline:action.study.revision}:draft;
  if(action.type==="saving")return {...draft,saved:false};
  // The acknowledgement belongs to the submitted revision, even if the saved-record
  // effect has already advanced the current draft while the promise was resolving.
  return {...draft,baseline:action.submitted.baseline===undefined?undefined:action.submitted.baseline+1,saved:draft.name===action.submitted.name&&draft.question===action.submitted.question};
}
type PageState<T>={rows:T[];page?:ComputeStudiesPage;busy:boolean;changed:boolean;offset:number;error?:string};
const emptyPage=<T>():PageState<T>=>({rows:[],busy:false,changed:false,offset:0});
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const merge=<T>(old:T[],next:T[],key:(row:T)=>string)=>{
  const fresh=new Map(next.map(row=>[key(row),row]));
  return [...old.map(row=>{const id=key(row),value=fresh.get(id)??row;fresh.delete(id);return value;}),...fresh.values()];
};
export type StudyRequester=(request:ComputeStudiesRequest)=>Promise<ComputeStudiesResponse>;
export interface ResearchStudyState {
  workspace:string;studies:PageState<ComputeStudySummary>;runs:PageState<ComputeStudyRunSummary>;
  selectedId?:string;study?:ComputeStudy;selectionBusy:boolean;mutationBusy:boolean;openBusy:boolean;
  runMode:"all"|"linked";error?:string;opened?:ComputeStudyOpenedRun;
  compareIds:string[];comparison?:[ComputeStudyOpenedRun,ComputeStudyOpenedRun];
  activate(workspace:string):void;
  suspend():void;
  loadStudies(mode?:"refresh"|"reset"|"older"):Promise<void>;
  select(id?:string):Promise<void>;
  setRunMode(mode:"all"|"linked"):Promise<void>;
  loadRuns(mode?:"refresh"|"reset"|"older"|"next"):Promise<void>;
  create(name:string,question:string):Promise<boolean>;
  update(name:string,question:string,expectedRevision:number):Promise<boolean>;
  link(runId:string,unlink?:boolean):Promise<boolean>;
  openRun(runId:string):Promise<ComputeStudyOpenedRun|undefined>;
  toggleCompare(runId:string):void;compare():Promise<void>;
}

/** All mutable UI state is scoped to a workspace, selection and request generation. */
export function createResearchStudyStore(request:StudyRequester) {
  const scope=createStudyRequestScope();
  return createStore<ResearchStudyState>((set,get)=>{
    const initial=()=>({workspace:"",studies:emptyPage<ComputeStudySummary>(),runs:emptyPage<ComputeStudyRunSummary>(),selectionBusy:false,mutationBusy:false,openBusy:false,runMode:"all" as const,compareIds:[] as string[]});
    const mutate=async(input:ComputeStudiesRequest)=>{
      if(get().mutationBusy)return false;
      const token=scope.begin("mutation");set({mutationBusy:true,error:undefined});
      try {
        const response=await request(input);if(!scope.current(token))return false;
        if(!response.study)throw Error("The saved research project was not returned.");
        if("studyId" in input&&response.study.id!==input.studyId)throw Error("A different research project was returned.");
        // A response already in flight must not clear the mutation's stale-list notice.
        scope.begin("studies");
        const studies={...get().studies,busy:false,changed:true};
        if(input.action==="create"){
          scope.select();set({study:response.study,selectedId:response.study.id,selectionBusy:false,runMode:"linked",runs:emptyPage(),mutationBusy:false,openBusy:false,compareIds:[],comparison:undefined,opened:undefined,studies});
          void get().loadRuns("reset");
        }else {
          if(input.action==="link"||input.action==="unlink"){
            // An unbound open started before a link cannot become this project's result.
            scope.begin("open");scope.begin("runs");
            set({openBusy:false,opened:undefined,comparison:undefined,runs:{...get().runs,busy:false,changed:true}});
          }
          set({study:response.study,selectedId:response.study.id,studies});
        }
        return true;
      }catch(error){if(scope.current(token))set({error:message(error)});return false;}
      finally{if(scope.current(token))set({mutationBusy:false});}
    };
    return {...initial(),
      activate(workspace){if(scope.activate(workspace))set({...initial(),workspace,selectedId:undefined,study:undefined,error:undefined,opened:undefined,comparison:undefined});},
      suspend(){scope.select();set({selectionBusy:false,mutationBusy:false,openBusy:false,runs:{...get().runs,busy:false}});},
      async loadStudies(mode="refresh") {
        const previous=get().studies;
        if(mode==="older"&&(previous.busy||previous.changed||!previous.page?.nextCursor||previous.rows.length>=200))return;
        const token=scope.begin("studies");set({studies:{...previous,busy:true,error:undefined}});
        try {
          const response=await request({action:"list",limit:30,...(mode==="older"?{cursor:previous.page!.nextCursor!}:{})});
          if(!scope.current(token,false))return;
          if(!response.page||!response.studies)throw Error("The research project page was not returned.");
          const current=get().studies;
          if(response.page.resetRequired||(mode!=="reset"&&previous.page&&response.page.generation!==previous.page.generation)) {
            set({studies:{...current,busy:false,changed:true}});return;
          }
          const rows=mode==="reset"?response.studies:merge(current.rows,response.studies,row=>row.id);
          set({studies:{rows:rows.slice(0,200),page:mode==="refresh"&&previous.page?{...response.page,nextCursor:previous.page.nextCursor}:response.page,busy:false,changed:false,offset:0}});
        }catch(error){if(scope.current(token,false))set({studies:{...get().studies,busy:false,error:message(error)}});}
      },
      async select(id){
        scope.select();const token=scope.begin("selection");set({selectedId:id,study:undefined,selectionBusy:!!id,mutationBusy:false,openBusy:false,error:undefined,opened:undefined,comparison:undefined,compareIds:[],runs:emptyPage(),runMode:id?"linked":"all"});
        if(id)try {
          const response=await request({action:"get",studyId:id});if(!scope.current(token))return;
          if(!response.study||response.study.id!==id)throw Error("The selected research project was not returned.");
          set({study:response.study});
        }catch(error){if(scope.current(token))set({error:message(error)});}
        finally{if(scope.current(token))set({selectionBusy:false});}
        if(scope.current(token))await get().loadRuns("reset");
      },
      async setRunMode(runMode){
        if(get().mutationBusy||get().selectionBusy||(runMode==="linked"&&!get().study))return;
        scope.select();set({runMode,runs:emptyPage(),compareIds:[],comparison:undefined,opened:undefined,openBusy:false,mutationBusy:false});
        await get().loadRuns("reset");
      },
      async loadRuns(mode="refresh") {
        const previous=get().runs;
        if((mode==="older"||mode==="next")&&(previous.busy||previous.changed||!previous.page?.nextCursor))return;
        if(mode==="older"&&previous.rows.length>=STUDY_RUN_WINDOW)return;
        const token=scope.begin("runs"),studyId=get().runMode==="linked"?get().selectedId:undefined;
        const cursor=(mode==="older"||mode==="next")?previous.page?.nextCursor:undefined;
        // A later window is stable until the user explicitly resets to the latest runs.
        if(mode==="refresh"&&previous.offset>0)return;
        set({runs:{...previous,busy:true,error:undefined}});
        try {
          const response=await request({action:"runs",limit:30,...(studyId?{studyId}:{}),...(cursor?{cursor}:{})});
          if(!scope.current(token))return;
          if(!response.page||!response.runs)throw Error("The saved run page was not returned.");
          if(response.page.resetRequired||(mode!=="reset"&&previous.page&&response.page.generation!==previous.page.generation)){
            set({runs:{...get().runs,busy:false,changed:true,page:{...previous.page!,indexingPending:response.page.indexingPending,discoveryTruncated:response.page.discoveryTruncated}}});return;
          }
          const reset=mode==="reset"||mode==="next";
          set({runs:{rows:(reset?response.runs:merge(get().runs.rows,response.runs,row=>row.runId)).slice(0,STUDY_RUN_WINDOW),page:mode==="refresh"&&previous.page?{...response.page,nextCursor:previous.page.nextCursor}:response.page,busy:false,changed:false,offset:mode==="next"?previous.offset+previous.rows.length:mode==="reset"?0:previous.offset}});
        }catch(error){if(scope.current(token))set({runs:{...get().runs,busy:false,error:message(error)}});}
      },
      async create(name,question){return mutate({action:"create",name,question});},
      async update(name,question,expectedRevision){const study=get().study;if(!study)return false;return mutate({action:"update",studyId:study.id,expectedRevision,name,question});},
      async link(runId,unlink=false){const study=get().study;if(!study)return false;return mutate({action:unlink?"unlink":"link",studyId:study.id,expectedRevision:study.revision,runId});},
      async openRun(runId){
        const token=scope.begin("open"),studyId=get().study?.links.some(link=>link.runId===runId)?get().study?.id:undefined;
        set({openBusy:true,opened:undefined,error:undefined});
        try {
          const response=await request({action:"open-run",runId,...(studyId?{studyId}:{})});if(!scope.current(token))return;
          if(!response.run||response.run.runId!==runId)throw Error("The selected saved run was not returned.");
          set({opened:response.run});
          if(response.run.integrity.status!=="verified"||!response.run.request||!response.run.receipt)throw Error(`Cannot open saved result: ${response.run.integrity.message}`);
          return response.run;
        }catch(error){if(scope.current(token))set({error:message(error)});return;}
        finally{if(scope.current(token))set({openBusy:false});}
      },
      toggleCompare(runId){const ids=get().compareIds;if(ids.includes(runId))set({compareIds:ids.filter(id=>id!==runId),comparison:undefined});else if(ids.length<2)set({compareIds:[...ids,runId],comparison:undefined});},
      async compare(){
        const ids=[...get().compareIds];if(ids.length!==2||get().openBusy)return;
        const token=scope.begin("open"),study=get().study;
        set({openBusy:true,comparison:undefined,error:undefined});
        try {
          const responses=await Promise.all(ids.map(runId=>request({action:"open-run",runId,...(study?.links.some(link=>link.runId===runId)?{studyId:study.id}:{})})));
          if(!scope.current(token)||ids.join()!==get().compareIds.join())return;
          const runs=responses.map((response,index)=>{
            const run=response.run;if(!run||run.runId!==ids[index]||run.integrity.status!=="verified"||!run.request||!run.receipt)throw Error(`Cannot compare ${ids[index]}: ${run?.integrity.message??"saved record unavailable"}`);return run;
          });
          set({comparison:runs as [ComputeStudyOpenedRun,ComputeStudyOpenedRun]});
        }catch(error){if(scope.current(token))set({error:message(error)});}
        finally{if(scope.current(token))set({openBusy:false});}
      },
    };
  });
}
