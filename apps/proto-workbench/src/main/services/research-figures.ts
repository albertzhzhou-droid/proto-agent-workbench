import { applySchemaMigrations, type SchemaMigrationReport } from "./schema-migrations.ts";
import { artifactReaders } from "./artifact-reader-registry.ts";
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,realpath,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {databasePath,guardDatabase,requestComputeStudies} from './compute-studies.ts';
import {readContained} from './research-documents.ts';
import {discoverFigureSeries,selectFigurePoints,buildFigureMethods} from './research-figure-data.ts';
import {FigureDraftSchema,FigurePanelDraftSchema,ResearchFiguresRequestSchema} from '../../shared/research-figures.ts';
import type {FigureInspection,FigurePanel,FigurePanelView,ResearchFigure,ResearchFigureExport,ResearchFiguresRequest,ResearchFiguresResponse} from '../../shared/research-figures.ts';
import type {ComputeStudy,ComputeStudyOpenedRun,ComputeStudyRunBinding} from '../../shared/compute-studies.ts';

const MiB=1024*1024;
export const FIGURE_LIMITS={perStudy:32,versions:64,documentBytes:128*1024,renderRequestBytes:16*MiB,totalPoints:20000,exportsPerFigure:64} as const;
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const digest=z.string().regex(/^[a-f0-9]{64}$/),stamp=z.string().max(80).refine(value=>Number.isFinite(Date.parse(value)));
const bindingSchema=z.object({tool:z.string().min(1).max(200),createdAt:stamp,manifestSha256:digest,provenanceSha256:digest,inputSha256:digest,resultSha256:digest}).strict();
const figureSchema=FigureDraftSchema.extend({id:z.string().uuid(),studyId:z.string().uuid(),revision:z.number().int().min(1).max(FIGURE_LIMITS.versions),createdAt:stamp,updatedAt:stamp,change:z.enum(['create','edit','rebind']),panels:z.array(FigurePanelDraftSchema.extend({binding:bindingSchema}).strict()).min(1).max(6)}).strict();
const fileSchema=z.object({format:z.enum(['svg','pdf','csv','data','methods','methods-json']),path:z.string().max(1024),sha256:digest,bytes:z.number().int().min(1).max(16*MiB),mimeType:z.string().max(120)}).strict();
const exportSchema=z.object({exportId:z.string().regex(/^[a-f0-9]{32}$/),figureId:z.string().uuid(),figureRevision:z.number().int().min(1).max(FIGURE_LIMITS.versions),createdAt:stamp,files:z.array(fileSchema).length(6),manifestPath:z.string().max(1024),manifestSha256:digest}).strict();
const sameBinding=(a:ComputeStudyRunBinding,b:ComputeStudyRunBinding)=>Object.entries(a).every(([key,value])=>b[key as keyof ComputeStudyRunBinding]===value);
export class ResearchFigureError extends Error {
  readonly code:string;
  constructor(code:string,message:string){super(message);this.code=code;}
}
function fail(code:string,message:string):never {throw new ResearchFigureError(code,message);}
type Row={id:string;study_id:string;revision:number;payload:string};

class FigureRepository {
  readonly migrationReport:SchemaMigrationReport;
  db:DatabaseSync;
  readonly root:string;
  readonly path:string;
  constructor(root:string,path:string){
    this.root=root;this.path=path;
    this.db=new DatabaseSync(path);
    try {
      guardDatabase(root,path);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.migrationReport=applySchemaMigrations(this.db,"research-figures",[{version:1,sql:`
        CREATE TABLE IF NOT EXISTS research_figures(id TEXT PRIMARY KEY,study_id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS research_figures_study ON research_figures(study_id,updated_at DESC,id DESC);
        CREATE TABLE IF NOT EXISTS research_figure_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS research_figure_exports(id TEXT PRIMARY KEY,figure_id TEXT NOT NULL,study_id TEXT NOT NULL,figure_revision INTEGER NOT NULL,payload TEXT NOT NULL);`}]);
    }catch(error){this.db.close();throw error;}
  }
  transaction<T>(run:()=>T):T {
    guardDatabase(this.root,this.path);this.db.exec('BEGIN IMMEDIATE');
    try{const value=run();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  get(studyId:string,id:string):ResearchFigure {
    const size=this.db.prepare('SELECT length(CAST(payload AS BLOB)) bytes FROM research_figures WHERE id=? AND study_id=?').get(id,studyId) as {bytes:number}|undefined;
    if(!size)fail('FIGURE_NOT_FOUND','This figure is not saved in the selected project.');
    if(size.bytes>FIGURE_LIMITS.documentBytes)fail('FIGURE_DAMAGED','Figure metadata exceeds its bound; its row has been retained.');
    const row=this.db.prepare('SELECT id,study_id,revision,payload FROM research_figures WHERE id=? AND study_id=?').get(id,studyId) as Row;
    let figure:ResearchFigure;
    try{figure=figureSchema.parse(JSON.parse(row.payload));}catch{fail('FIGURE_DAMAGED','Figure metadata is damaged or unsupported; its row has been retained.');}
    if(figure.id!==row.id||figure.studyId!==row.study_id||figure.revision!==row.revision||new Set(figure.panels.map(panel=>panel.id)).size!==figure.panels.length)fail('FIGURE_DAMAGED','Figure identity or panel identity is inconsistent.');
    const version=this.db.prepare('SELECT payload FROM research_figure_versions WHERE id=? AND revision=?').get(id,figure.revision) as {payload:string}|undefined;
    if(!version||version.payload!==row.payload)fail('FIGURE_DAMAGED','Figure history does not match its current revision.');
    return figure;
  }
  list(studyId:string){
    const rows=this.db.prepare('SELECT id FROM research_figures WHERE study_id=? ORDER BY updated_at DESC,id DESC LIMIT ?').all(studyId,FIGURE_LIMITS.perStudy+1) as Array<{id:string}>;
    if(rows.length>FIGURE_LIMITS.perStudy)fail('FIGURE_LIMIT','The project figure index exceeds its bound.');
    return rows.map(row=>{const figure=this.get(studyId,row.id);return{id:figure.id,studyId,revision:figure.revision,title:figure.title,panelCount:figure.panels.length,updatedAt:figure.updatedAt};});
  }
  put(figure:ResearchFigure,previous:ResearchFigure|undefined,study:ComputeStudy){
    return this.transaction(()=>{
      this.assertStudy(study);
      if(previous){const current=this.get(study.id,figure.id);if(JSON.stringify(current)!==JSON.stringify(previous))fail('FIGURE_CONFLICT','The figure changed. Reload it before saving.');}
      else if((this.db.prepare('SELECT COUNT(*) n FROM research_figures WHERE study_id=?').get(study.id) as {n:number}).n>=FIGURE_LIMITS.perStudy)fail('FIGURE_LIMIT','This project has reached its figure limit.');
      if(figure.revision>FIGURE_LIMITS.versions)fail('FIGURE_HISTORY_LIMIT','Figure history is full; no earlier version has been removed.');
      const payload=JSON.stringify(figureSchema.parse(figure));
      if(Buffer.byteLength(payload)>FIGURE_LIMITS.documentBytes)fail('FIGURE_LIMIT','Figure metadata exceeds its byte budget.');
      this.db.prepare('INSERT INTO research_figure_versions VALUES(?,?,?)').run(figure.id,figure.revision,payload);
      if(previous)this.db.prepare('UPDATE research_figures SET revision=?,title=?,updated_at=?,payload=? WHERE id=?').run(figure.revision,figure.title,figure.updatedAt,payload,figure.id);
      else this.db.prepare('INSERT INTO research_figures VALUES(?,?,?,?,?,?)').run(figure.id,study.id,figure.revision,figure.title,figure.updatedAt,payload);
      return figure;
    });
  }
  assertStudy(study:ComputeStudy){
    const row=this.db.prepare('SELECT revision FROM compute_studies WHERE id=?').get(study.id) as {revision:number}|undefined;
    if(!row||row.revision!==study.revision)fail('STUDY_CONFLICT','The project changed. Refresh it before editing or exporting a figure.');
  }
  saveExport(receipt:ResearchFigureExport,figure:ResearchFigure,study:ComputeStudy){
    this.transaction(()=>{
      this.assertStudy(study);if(JSON.stringify(this.get(study.id,figure.id))!==JSON.stringify(figure))fail('FIGURE_CONFLICT','The figure changed during export. Generated files remain unregistered.');
      if((this.db.prepare('SELECT COUNT(*) n FROM research_figure_exports WHERE figure_id=?').get(figure.id) as {n:number}).n>=FIGURE_LIMITS.exportsPerFigure)fail('FIGURE_EXPORT_LIMIT','This figure has reached its retained export limit.');
      this.db.prepare('INSERT INTO research_figure_exports VALUES(?,?,?,?,?)').run(receipt.exportId,figure.id,study.id,figure.revision,JSON.stringify(receipt));
    });
  }
  export(studyId:string,figureId:string,id:string){
    const row=this.db.prepare('SELECT payload,figure_revision FROM research_figure_exports WHERE id=? AND figure_id=? AND study_id=? AND length(CAST(payload AS BLOB))<32768').get(id,figureId,studyId) as {payload:string;figure_revision:number}|undefined;
    if(!row)fail('EXPORT_NOT_FOUND','This export does not belong to the selected figure and project.');
    try{
      const receipt=exportSchema.parse(JSON.parse(row.payload));
      if(receipt.exportId!==id||receipt.figureId!==figureId||receipt.figureRevision!==row.figure_revision)fail('EXPORT_DAMAGED','The retained export receipt belongs to another identity or revision.');
      return receipt;
    }catch{return fail('EXPORT_DAMAGED','The retained export receipt is invalid.');}
  }
  exports(studyId:string,figureId:string){
    const rows=this.db.prepare('SELECT id FROM research_figure_exports WHERE figure_id=? AND study_id=? ORDER BY figure_revision DESC,rowid DESC LIMIT ?').all(figureId,studyId,FIGURE_LIMITS.exportsPerFigure+1) as Array<{id:string}>;
    if(rows.length>FIGURE_LIMITS.exportsPerFigure)fail('FIGURE_EXPORT_LIMIT','The retained export index exceeds its bound.');
    return rows.map(row=>this.export(studyId,figureId,row.id));
  }
  close(){this.db.close();}
}

type StudiesOptions={databaseRelativePath?:string};
export type FigureRenderCall=(name:string,input:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const filesByFormat={svg:['figure.svg','image/svg+xml'],pdf:['figure.pdf','application/pdf'],csv:['plotted-values.csv','text/csv'],data:['figure-data.json','application/json'],methods:['methods.md','text/markdown'],'methods-json':['methods.json','application/json']} as const;
async function checkedStudy(root:string,id:string,options:StudiesOptions,expected?:number){
  const study=(await requestComputeStudies(root,{action:'get',studyId:id},options)).study!;
  if(expected!==undefined&&study.revision!==expected)fail('STUDY_CONFLICT','The project changed. Refresh it before editing or exporting a figure.');
  return study;
}
async function checkedRun(root:string,studyId:string,runId:string,options:StudiesOptions){
  const run=(await requestComputeStudies(root,{action:'open-run',studyId,runId},options)).run!;
  if(run.integrity.status!=='verified'||!run.request||!run.receipt||!run.binding)fail('RUN_NOT_VERIFIED',run.integrity.message);
  return run;
}
async function inspectFigure(root:string,figure:ResearchFigure,study:ComputeStudy,options:StudiesOptions):Promise<FigureInspection>{
  const runs=new Map<string,ComputeStudyOpenedRun>(),panels:FigurePanelView[]=[];let total=0;
  for(const panel of figure.panels){
    const link=study.links.find(link=>link.runId===panel.runId);
    if(!link||!sameBinding(panel.binding,link.binding)){panels.push({id:panel.id,status:'binding-changed',message:link?'The project association differs from this saved panel. Refresh the source binding explicitly.':'This run is no longer associated with the project.'});continue;}
    try {
      let run=runs.get(panel.runId);if(!run){run=await checkedRun(root,study.id,panel.runId,options);runs.set(panel.runId,run);}
      if(!sameBinding(panel.binding,run.binding!))fail('BINDING_CHANGED','Saved panel bytes differ from the current run.');
      let points;try{points=selectFigurePoints(run,panel);}catch(error){panels.push({id:panel.id,status:'invalid-selection',message:error instanceof Error?error.message:String(error)});continue;}
      total+=points.length;if(total>FIGURE_LIMITS.totalPoints)fail('POINT_LIMIT','The board exceeds 20,000 plotted points.');
      const changed=run.sourceFreshness.status!=='current';
      panels.push({id:panel.id,status:changed?'source-changed':'ready',message:changed?'Saved result bytes match; some original source files changed, are unavailable or were not checked.':'Saved panel binding and current source checks match.',points,sourceFreshness:run.sourceFreshness});
    }catch(error){panels.push({id:panel.id,status:'unavailable',message:error instanceof Error?error.message:String(error)});}
  }
  const methods=buildFigureMethods(figure,study,[...runs.values()],panels);
  return {figure,panels,canExport:panels.every(panel=>panel.status==='ready'||panel.status==='source-changed'),requiresSourceAcknowledgement:panels.some(panel=>panel.status==='source-changed'),...methods};
}
async function writeRenderRequest(root:string,payload:unknown){
  const bytes=Buffer.from(JSON.stringify(payload));if(bytes.length>FIGURE_LIMITS.renderRequestBytes)fail('FIGURE_REQUEST_LIMIT','Figure data and exact methods exceed the 16 MiB export budget.');
  let directory=root;
  for(const part of ['build','research-figures','requests']){
    directory=join(directory,part);await mkdir(directory).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)fail('FIGURE_PATH','Figure request directories must be regular workspace directories.');
  }
  const path=`build/research-figures/requests/${randomUUID()}.json`;await writeFile(join(root,path),bytes,{flag:'wx'});return {path,sha256:sha(bytes)};
}
async function verifyExportFiles(root:string,receipt:ResearchFigureExport){
  const prefix=`build/research-figures/exports/${receipt.exportId}/`;
  if(receipt.manifestPath!==`${prefix}manifest.json`||new Set(receipt.files.map(file=>file.format)).size!==6)fail('INVALID_EXPORT','Unexpected export paths or formats.');
  const manifestBytes=await readContained(root,receipt.manifestPath,MiB);if(sha(manifestBytes)!==receipt.manifestSha256)fail('EXPORT_CHANGED','Export manifest changed.');
  const decoded=JSON.parse(manifestBytes.toString('utf8')),reader=artifactReaders.select('research-figure',decoded);
  if(reader.status!=='current')fail(reader.code,reader.message);
  const manifest=z.object({schema:z.literal('proto.research-figure-export.v1'),ok:z.literal(true),exportId:z.string(),figureId:z.string(),figureRevision:z.number(),createdAt:z.string(),requestSha256:digest,files:z.array(fileSchema).length(6)}).passthrough().parse(decoded);
  if(manifest.exportId!==receipt.exportId||manifest.figureId!==receipt.figureId||manifest.figureRevision!==receipt.figureRevision||manifest.createdAt!==receipt.createdAt||JSON.stringify(manifest.files)!==JSON.stringify(receipt.files))fail('INVALID_EXPORT','The export manifest and receipt describe different artifacts.');
  for(const file of receipt.files){
    const [name,mime]=filesByFormat[file.format];
    if(file.path!==prefix+name||file.mimeType!==mime)fail('INVALID_EXPORT','Unexpected export file identity.');
    const bytes=await readContained(root,file.path,16*MiB);if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)fail('EXPORT_CHANGED',`The ${file.format} export bytes do not match their receipt.`);
  }
  return manifest;
}

/** Renderer requests contain identities and plot choices only; verified data and output paths are host-owned. */
export async function requestResearchFigures(workspace:string,input:unknown,options:StudiesOptions&{render?:FigureRenderCall}={}):Promise<ResearchFiguresResponse>{
  const request=ResearchFiguresRequestSchema.parse(input),root=await realpath(workspace);
  const study=await checkedStudy(root,request.studyId,options,'expectedStudyRevision'in request?request.expectedStudyRevision:undefined);
  const repository=new FigureRepository(root,databasePath(root,options.databaseRelativePath??'build/compute-studies/studies.sqlite'));
  try {
    if(request.action==='list')return{migrationReport:repository.migrationReport,figures:repository.list(study.id)};
    if(request.action==='series'){const run=await checkedRun(root,study.id,request.runId,options);const {series,truncated}=discoverFigureSeries(run);return{series,seriesTruncated:truncated};}
    if(request.action==='save'){
      if(!!request.figureId!==(request.expectedRevision!==undefined))fail('FIGURE_REVISION','Figure identity and expected revision must be supplied together.');
      const previous=request.figureId?repository.get(study.id,request.figureId):undefined;
      if(previous&&previous.revision!==request.expectedRevision)fail('FIGURE_CONFLICT','The figure changed. Reload it before saving.');
      const panels:FigurePanel[]=[];let count=0;
      const runs=new Map<string,ComputeStudyOpenedRun>();
      for(const draft of request.draft.panels){
        let run=runs.get(draft.runId);if(!run){run=await checkedRun(root,study.id,draft.runId,options);runs.set(draft.runId,run);}
        const prior=previous?.panels.find(panel=>panel.id===draft.id&&panel.runId===draft.runId);
        if(prior&&!sameBinding(prior.binding,run.binding!))fail('BINDING_CHANGED','This panel source changed. Refresh its saved binding explicitly before editing.');
        count+=selectFigurePoints(run,draft).length;if(count>FIGURE_LIMITS.totalPoints)fail('POINT_LIMIT','The board exceeds 20,000 plotted points.');
        panels.push({...draft,binding:prior?.binding??run.binding!});
      }
      const at=new Date().toISOString();const figure:ResearchFigure={...request.draft,id:previous?.id??randomUUID(),studyId:study.id,revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??at,updatedAt:at,change:previous?'edit':'create',panels};
      return{figure:repository.put(figure,previous,study)};
    }
    const figure=repository.get(study.id,request.figureId);
    if(request.action==='get')return{figure,exports:repository.exports(study.id,figure.id)};
    if('expectedRevision'in request&&request.expectedRevision!==figure.revision)fail('FIGURE_CONFLICT','The figure changed. Reload it before continuing.');
    if(request.action==='rebind'){
      if(new Set(request.panelIds).size!==request.panelIds.length||request.panelIds.some(id=>!figure.panels.some(panel=>panel.id===id)))fail('PANEL_NOT_FOUND','Choose distinct panels from the saved figure.');
      const panels:FigurePanel[]=[];let count=0;
      for(const panel of figure.panels){
        if(!request.panelIds.includes(panel.id)){
          panels.push(panel);
          // An unavailable untouched panel remains stale. Any readable points still
          // contribute to the bound; refreshing another panel cannot hide their size.
          try{const run=await checkedRun(root,study.id,panel.runId,options);count+=selectFigurePoints(run,panel).length;}catch{}
        }else{
          const run=await checkedRun(root,study.id,panel.runId,options);count+=selectFigurePoints(run,panel).length;panels.push({...panel,binding:run.binding!});
        }
        if(count>FIGURE_LIMITS.totalPoints)fail('POINT_LIMIT','The board exceeds 20,000 plotted points.');
      }
      const updated:ResearchFigure={...figure,revision:figure.revision+1,updatedAt:new Date().toISOString(),change:'rebind',panels};
      return{figure:repository.put(updated,figure,study)};
    }
    if(request.action==='artifact'){
      const exported=repository.export(study.id,figure.id,request.exportId);await verifyExportFiles(root,exported);
      const file=exported.files.find(file=>file.format===request.format)!;
      const bytes=await readContained(root,file.path,16*MiB);if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)fail('EXPORT_CHANGED','The requested export changed while being read.');
      return{artifact:{name:`${exported.exportId}-${filesByFormat[file.format][0]}`,mimeType:file.mimeType,base64:bytes.toString('base64'),sha256:file.sha256}};
    }
    const inspection=await inspectFigure(root,figure,study,options);
    if(request.action==='inspect')return{inspection};
    if(!inspection.canExport)fail('FIGURE_NOT_READY','One or more saved panels cannot be verified or plotted. Inspect the figure before exporting.');
    if(inspection.requiresSourceAcknowledgement&&!request.acknowledgeChangedSources)fail('SOURCE_ACKNOWLEDGEMENT_REQUIRED','Some original source files changed or could not be checked. Explicitly acknowledge exporting the retained result snapshot.');
    if(!options.render)fail('FIGURE_RENDERER_UNAVAILABLE','A local figure renderer is not connected.');
    const payload={schema:'proto.research-figure-render.v1',figure:{id:figure.id,revision:figure.revision,title:figure.title,caption:figure.caption,columns:figure.columns},
      panels:figure.panels.map(panel=>({id:panel.id,title:panel.title,kind:panel.kind,xLabel:panel.xLabel,yLabel:panel.yLabel,xUnit:panel.xUnit,yUnit:panel.yUnit,points:inspection.panels.find(view=>view.id===panel.id)!.points,
        source:{runId:panel.runId,binding:panel.binding,selection:{y:panel.y,...(panel.x?{x:panel.x}:{})},sourceFreshness:inspection.panels.find(view=>view.id===panel.id)!.sourceFreshness!.status}})),methodsMarkdown:inspection.methodsMarkdown,methods:inspection.methods};
    const prepared=await writeRenderRequest(root,payload);
    const response=await options.render('proto_research_figure_render',{path:prepared.path});
    if(response.ok===false){
      const diagnostics=z.array(z.object({code:z.string().max(100),message:z.string().max(4000)}).passthrough()).max(32).safeParse(response.diagnostics);
      const diagnostic=diagnostics.success?diagnostics.data[0]:undefined;
      fail(diagnostic?.code??'FIGURE_RENDER_FAILED',diagnostic?.message??'The local figure renderer did not return a successful export.');
    }
    const exported=exportSchema.parse(response);
    if(exported.figureId!==figure.id||exported.figureRevision!==figure.revision)fail('INVALID_EXPORT','The renderer returned a different figure or revision.');
    const manifest=await verifyExportFiles(root,exported);
    if(manifest.requestSha256!==prepared.sha256)fail('INVALID_EXPORT','The export is not bound to the prepared request bytes.');
    const finalStudy=await checkedStudy(root,study.id,options,study.revision);
    const finalInspection=await inspectFigure(root,figure,finalStudy,options);
    // The observation time advances on each check; compare the observed states and digests.
    const observations=(value:FigureInspection)=>value.panels.map(panel=>({id:panel.id,status:panel.status,details:panel.sourceFreshness?.details}));
    if(!finalInspection.canExport||JSON.stringify(observations(finalInspection))!==JSON.stringify(observations(inspection)))fail('FIGURE_CHANGED_DURING_EXPORT','Source observations changed during export; generated files remain unregistered. Inspect and export again.');
    if(sha(await readContained(root,prepared.path,FIGURE_LIMITS.renderRequestBytes))!==prepared.sha256)fail('FIGURE_REQUEST_CHANGED','The prepared render request changed during export.');
    repository.saveExport(exported,figure,study);return{export:exported};
  }finally{repository.close();}
}
