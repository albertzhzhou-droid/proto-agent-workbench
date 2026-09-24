import {createStore} from "zustand/vanilla";
import type {ComputeStudy} from "../shared/compute-studies.ts";
import {FigureDraftSchema,type FigureDraft,type FigureExportFile,type FigureInspection,type FigurePanelDraft,type FigureSeries,type ResearchFigure,type ResearchFigureExport,type ResearchFiguresRequest,type ResearchFiguresResponse,type ResearchFigureSummary} from "../shared/research-figures.ts";

export type FigureRequester=(request:ResearchFiguresRequest)=>Promise<ResearchFiguresResponse>;
export type FigureEditor={key:string;draft:FigureDraft;baseline?:ResearchFigure;remoteRevision?:number;dirty:boolean};
type Session={editors:FigureEditor[];selectedKey?:string};
type Download={name:string;mimeType:string;bytes:Uint8Array<ArrayBuffer>};
const copy=<T>(value:T):T=>structuredClone(value);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
export const figureDraft=(figure:ResearchFigure):FigureDraft=>({title:figure.title,caption:figure.caption,columns:figure.columns,panels:figure.panels.map(({binding:_,...panel})=>copy(panel))});
const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
export function editFigure(editor:FigureEditor,change:Partial<FigureDraft>):FigureEditor {
  const draft={...editor.draft,...copy(change)};
  return {...editor,draft,dirty:!editor.baseline||!equal(draft,figureDraft(editor.baseline))};
}
/** A late save acknowledgement updates its baseline, without replacing edits made while saving. */
export function acceptFigure(editor:FigureEditor,submitted:FigureDraft,figure:ResearchFigure):FigureEditor {
  const draft=equal(editor.draft,submitted)?figureDraft(figure):editor.draft;
  return {key:figure.id,draft,baseline:figure,dirty:!equal(draft,figureDraft(figure))};
}
export function moveFigurePanel(panels:FigurePanelDraft[],id:string,direction:-1|1) {
  const index=panels.findIndex(panel=>panel.id===id),target=index+direction;
  if(index<0||target<0||target>=panels.length)return panels;
  const next=[...panels];[next[index],next[target]]=[next[target],next[index]];return next;
}
export async function verifyFigureArtifact(artifact:NonNullable<ResearchFiguresResponse["artifact"]>,file:FigureExportFile):Promise<Download> {
  if(!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>64*1024*1024)throw Error("Export size is outside the supported download limit.");
  if(artifact.sha256!==file.sha256||artifact.mimeType!==file.mimeType)throw Error("The download receipt does not match this export.");
  if(!/^[a-f0-9]{64}$/.test(file.sha256)||!artifact.name||/[\\/\x00-\x1f]/.test(artifact.name))throw Error("The export identity is invalid.");
  if(artifact.base64.length!==4*Math.ceil(file.bytes/3)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.base64))throw Error("The downloaded bytes are malformed or truncated.");
  const raw=atob(artifact.base64),bytes=new Uint8Array(raw.length);for(let index=0;index<raw.length;index++)bytes[index]=raw.charCodeAt(index);
  if(bytes.length!==file.bytes)throw Error("The downloaded size differs from the export receipt.");
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");
  if(digest!==file.sha256)throw Error("Download stopped: exported bytes failed the SHA-256 check.");
  return {name:artifact.name,mimeType:artifact.mimeType,bytes};
}

export interface ResearchFigureState {
  workspace:string;study?:ComputeStudy;figures:ResearchFigureSummary[];editors:FigureEditor[];selectedKey?:string;
  series:Record<string,FigureSeries[]>;seriesTruncated:Record<string,boolean>;seriesBusy:Record<string,boolean>;
  listBusy:boolean;opening:boolean;busy?:"save"|"rebind"|"export";inspectionBusy:boolean;downloadBusy?:string;
  inspection?:FigureInspection;exported?:ResearchFigureExport;exports:ResearchFigureExport[];error?:string;notice?:string;
  activate(workspace:string,study?:ComputeStudy):void;suspend():void;
  list():Promise<void>;create():void;select(key:string):Promise<void>;reload():Promise<void>;
  edit(change:Partial<FigureDraft>):void;loadSeries(runId:string):Promise<void>;
  save():Promise<boolean>;inspect():Promise<void>;rebind(panelIds:string[]):Promise<boolean>;
  export(acknowledgeChangedSources:boolean):Promise<boolean>;showExport(exportId:string):void;download(file:FigureExportFile):Promise<Download|undefined>;
}
export const selectedFigure=(state:Pick<ResearchFigureState,"editors"|"selectedKey">)=>state.editors.find(editor=>editor.key===state.selectedKey);
export const figureScopeReady=(state:Pick<ResearchFigureState,"workspace"|"study">,workspace:string,study:ComputeStudy)=>state.workspace===workspace&&state.study?.id===study.id&&state.study?.revision===study.revision;
export function captureFigureDownloadScope(state:ResearchFigureState) {
  const editor=selectedFigure(state);
  return {workspace:state.workspace,studyId:state.study?.id,studyRevision:state.study?.revision,selectedKey:state.selectedKey,draft:editor?.draft,figureRevision:editor?.baseline?.revision,exportId:state.exported?.exportId};
}
export function figureDownloadScopeCurrent(scope:ReturnType<typeof captureFigureDownloadScope>,state:ResearchFigureState) {
  const now=captureFigureDownloadScope(state);return Object.keys(scope).every(key=>scope[key as keyof typeof scope]===now[key as keyof typeof now]);
}

/** Drafts remain in this workspace store while the result view is open or another project is selected. */
export function createResearchFigureStore(request:FigureRequester) {
  let epoch=0;const counts=new Map<string,number>(),sessions=new Map<string,Session>();
  return createStore<ResearchFigureState>((set,get)=>{
    const cleanActivity=()=>({listBusy:false,opening:false,busy:undefined,inspectionBusy:false,downloadBusy:undefined,seriesBusy:{}});
    const token=(kind:string)=>{const count=(counts.get(kind)??0)+1;counts.set(kind,count);return {epoch,kind,count};};
    const current=(value:ReturnType<typeof token>)=>value.epoch===epoch&&counts.get(value.kind)===value.count;
    const invalidate=()=>{epoch++;set({...cleanActivity()});};
    const remember=()=>{const state=get();if(state.study)sessions.set(state.study.id,{editors:state.editors,selectedKey:state.selectedKey});};
    const setEditor=(editor:FigureEditor,previousKey=editor.key)=>{set({editors:get().editors.some(item=>item.key===previousKey)?get().editors.map(item=>item.key===previousKey?editor:item):[...get().editors,editor],selectedKey:editor.key});remember();};
    const assertFigure=(figure:ResearchFigure|undefined,id?:string)=>{if(!figure||figure.studyId!==get().study?.id||(id&&figure.id!==id))throw Error("The selected figure board was not returned.");return figure;};
    const refreshSummary=(figure:ResearchFigure)=>{counts.set("list",(counts.get("list")??0)+1);set({listBusy:false,figures:[{id:figure.id,studyId:figure.studyId,revision:figure.revision,title:figure.title,panelCount:figure.panels.length,updatedAt:figure.updatedAt},...get().figures.filter(item=>item.id!==figure.id)]});};
    return {
      workspace:"",figures:[],editors:[],series:{},seriesTruncated:{},exports:[],...cleanActivity(),
      activate(workspace,study){
        const previous=get();if(previous.workspace===workspace&&previous.study?.id===study?.id&&previous.study?.revision===study?.revision){set({study});return;}
        remember();invalidate();if(previous.workspace!==workspace)sessions.clear();
        const same=previous.workspace===workspace&&previous.study?.id===study?.id,session=study?sessions.get(study.id):undefined;
        set({workspace,study,editors:session?.editors??[],selectedKey:session?.selectedKey,figures:same?previous.figures:[],series:{},seriesTruncated:{},inspection:undefined,exported:undefined,exports:[],error:undefined,notice:same?"Project revision changed. Saved figure bindings will be checked again.":undefined});
      },
      suspend(){remember();invalidate();},
      async list(){
        const study=get().study;if(!study)return;const active=token("list");set({listBusy:true,error:undefined});
        try{const response=await request({action:"list",studyId:study.id});if(!current(active))return;if(!response.figures||response.figures.some(figure=>figure.studyId!==study.id))throw Error("The figure board list was not returned.");set({figures:response.figures});}
        catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({listBusy:false});}
      },
      create(){if(!get().study)return;invalidate();const key=`draft-${crypto.randomUUID()}`;setEditor({key,draft:{title:"Untitled figure board",caption:"",columns:1,panels:[]},dirty:true});set({inspection:undefined,exported:undefined,exports:[],error:undefined,notice:undefined});},
      async select(key){
        if(!get().study)return;invalidate();set({selectedKey:key,inspection:undefined,exported:undefined,exports:[],error:undefined,notice:undefined});remember();
        const editor=selectedFigure(get());if(editor&&!editor.baseline)return;
        const study=get().study!,active=token("open");set({opening:true});
        try{const response=await request({action:"get",studyId:study.id,figureId:key});if(!current(active))return;const figure=assertFigure(response.figure,key),latest=selectedFigure(get());if(latest?.baseline){if(figure.revision!==latest.baseline.revision)setEditor({...latest,remoteRevision:figure.revision});}else setEditor({key,draft:figureDraft(figure),baseline:figure,dirty:false});refreshSummary(figure);set({exports:(response.exports??[]).filter(item=>item.figureId===figure.id)});if(!selectedFigure(get())?.dirty)await get().inspect();}
        catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({opening:false});}
      },
      async reload(){
        const editor=selectedFigure(get()),study=get().study;if(!editor?.baseline||!study||get().busy)return;
        invalidate();const active=token("open");set({opening:true,inspection:undefined,exported:undefined,error:undefined});
        try{const response=await request({action:"get",studyId:study.id,figureId:editor.baseline.id});if(!current(active))return;const figure=assertFigure(response.figure,editor.baseline.id);setEditor({key:figure.id,draft:figureDraft(figure),baseline:figure,dirty:false},editor.key);refreshSummary(figure);set({exports:(response.exports??[]).filter(item=>item.figureId===figure.id)});await get().inspect();}
        catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({opening:false});}
      },
      edit(change){const editor=selectedFigure(get());if(!editor)return;setEditor(editFigure(editor,change));counts.set("inspect",(counts.get("inspect")??0)+1);counts.set("export",(counts.get("export")??0)+1);counts.set("download",(counts.get("download")??0)+1);set({inspection:undefined,inspectionBusy:false,exported:undefined,downloadBusy:undefined,...(get().busy==="export"?{busy:undefined}:{}),error:undefined,notice:undefined});},
      async loadSeries(runId){
        const study=get().study;if(!study||!study.links.some(link=>link.runId===runId)||get().seriesBusy[runId])return;
        const active=token(`series:${runId}`);set({seriesBusy:{...get().seriesBusy,[runId]:true},error:undefined});
        try{const response=await request({action:"series",studyId:study.id,runId});if(!current(active))return;if(!response.series)throw Error("Selectable data series were not returned.");set({series:{...get().series,[runId]:response.series},seriesTruncated:{...get().seriesTruncated,[runId]:!!response.seriesTruncated}});}
        catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({seriesBusy:{...get().seriesBusy,[runId]:false}});}
      },
      async save(){
        const editor=selectedFigure(get()),study=get().study;if(!editor||!study||get().busy)return false;
        const validated=FigureDraftSchema.safeParse(editor.draft);if(!validated.success){set({error:validated.error.issues.map(issue=>`${issue.path.join(".")}: ${issue.message}`).join("; ")});return false;}
        const active=token("save"),submitted=copy(editor.draft);set({busy:"save",error:undefined,exported:undefined});
        try{
          const response=await request({action:"save",studyId:study.id,expectedStudyRevision:study.revision,...(editor.baseline?{figureId:editor.baseline.id,expectedRevision:editor.baseline.revision}:{}),draft:validated.data});if(!current(active))return false;
          const figure=assertFigure(response.figure,editor.baseline?.id),latest=selectedFigure(get());if(!latest||latest.key!==editor.key)return false;
          setEditor(acceptFigure(latest,submitted,figure),editor.key);refreshSummary(figure);set({notice:`Figure board saved at revision ${figure.revision}.`});if(!selectedFigure(get())?.dirty)await get().inspect();return true;
        }catch(error){if(current(active))set({error:message(error)});return false;}finally{if(current(active))set({busy:undefined});}
      },
      async inspect(){
        const editor=selectedFigure(get()),study=get().study;if(!study||!editor?.baseline||editor.dirty)return;
        const active=token("inspect");set({inspectionBusy:true,error:undefined});
        try{const response=await request({action:"inspect",studyId:study.id,figureId:editor.baseline.id});if(!current(active))return;const inspection=response.inspection;if(!inspection)throw Error("The saved figure inspection was not returned.");assertFigure(inspection.figure,editor.baseline.id);
          if(inspection.figure.revision!==editor.baseline.revision){setEditor({...selectedFigure(get())!,remoteRevision:inspection.figure.revision});set({inspection:undefined,exported:undefined,notice:"A newer figure revision exists. Reload saved figure to use it; your draft is retained."});return;}
          set({inspection});
        }catch(error){if(current(active))set({error:message(error)});}finally{if(current(active))set({inspectionBusy:false});}
      },
      async rebind(panelIds){
        const editor=selectedFigure(get()),study=get().study;if(!study||!editor?.baseline||editor.dirty||get().busy||!panelIds.length)return false;
        const active=token("rebind"),submitted=copy(editor.draft);set({busy:"rebind",error:undefined,exported:undefined});
        try{const response=await request({action:"rebind",studyId:study.id,figureId:editor.baseline.id,expectedRevision:editor.baseline.revision,expectedStudyRevision:study.revision,panelIds});if(!current(active))return false;const figure=assertFigure(response.figure,editor.baseline.id),latest=selectedFigure(get());if(!latest||latest.key!==editor.key)return false;setEditor(acceptFigure(latest,submitted,figure));refreshSummary(figure);set({notice:"Selected panel bindings refreshed explicitly. The earlier saved revision remains historical."});if(!selectedFigure(get())?.dirty)await get().inspect();return true;}
        catch(error){if(current(active))set({error:message(error)});return false;}finally{if(current(active))set({busy:undefined});}
      },
      async export(acknowledgeChangedSources){
        const editor=selectedFigure(get()),study=get().study,inspection=get().inspection;if(!study||!editor?.baseline||editor.dirty||get().busy||!inspection?.canExport)return false;
        if(inspection.requiresSourceAcknowledgement&&!acknowledgeChangedSources){set({error:"Acknowledge the source-file changes before exporting the saved values."});return false;}
        const active=token("export");set({busy:"export",exported:undefined,error:undefined});
        try{const response=await request({action:"export",studyId:study.id,figureId:editor.baseline.id,expectedRevision:editor.baseline.revision,expectedStudyRevision:study.revision,acknowledgeChangedSources});if(!current(active))return false;const exported=response.export;if(!exported||exported.figureId!==editor.baseline.id||exported.figureRevision!==editor.baseline.revision)throw Error("The export receipt does not match this saved figure revision.");set({exported,exports:[exported,...get().exports.filter(item=>item.exportId!==exported.exportId)].slice(0,64),notice:"Figure bundle generated. Each download is checked against its recorded SHA-256."});return true;}
        catch(error){if(current(active))set({error:message(error)});return false;}finally{if(current(active))set({busy:undefined});}
      },
      showExport(exportId){const exported=get().exports.find(item=>item.exportId===exportId);if(!exported||exported.figureId!==selectedFigure(get())?.baseline?.id)return;counts.set("download",(counts.get("download")??0)+1);set({exported,downloadBusy:undefined,error:undefined});},
      async download(file){
        const study=get().study,exported=get().exported;if(!study||!exported||get().downloadBusy||!exported.files.some(item=>equal(item,file)))return;
        const active=token("download");set({downloadBusy:file.format,error:undefined});
        try{const response=await request({action:"artifact",studyId:study.id,figureId:exported.figureId,exportId:exported.exportId,format:file.format});if(!current(active))return;if(!response.artifact)throw Error("The exported artifact was not returned.");const verified=await verifyFigureArtifact(response.artifact,file);if(!current(active))return;return verified;}
        catch(error){if(current(active))set({error:message(error)});return;}finally{if(current(active))set({downloadBusy:undefined});}
      },
    };
  });
}
