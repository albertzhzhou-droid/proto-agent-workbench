import { applySchemaMigrations, type SchemaMigrationReport } from "./schema-migrations.ts";
import { artifactReaders } from "./artifact-reader-registry.ts";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readContained } from "./research-documents.ts";
import { COMPUTE_STUDY_LIMITS, ComputeStudiesRequestSchema } from "../../shared/compute-studies.ts";
import type { ComputeRequest, ComputeRun } from "../../shared/compute.ts";
import { computeResultByteLimit, computeResultNodeLimit } from "../../shared/compute-limits.ts";
import type { ComputeStudiesRequest, ComputeStudiesResponse, ComputeStudy, ComputeStudyIntegrity, ComputeStudyOpenedRun, ComputeStudyRunBinding, ComputeStudyRunSummary, ComputeStudySourceDetail, ComputeStudiesPage } from "../../shared/compute-studies.ts";

const MiB=1024*1024;
export const COMPUTE_STUDIES_IO_LIMITS={manifestBytes:MiB,inputBytes:2*MiB,resultBytes:4*MiB,provenanceBytes:MiB,provenanceFiles:1024,discoveryEntries:2048,discoveredRuns:1000,discoveryHeaders:30,sourceBytes:32*MiB,totalSourceBytes:64*MiB,sourceFiles:64} as const;
export class ComputeStudiesError extends Error { readonly code:string;constructor(code:string,message:string){super(message);this.code=code;} }
function fail(code:string,message:string):never{throw new ComputeStudiesError(code,message);}
const sha=(data:Uint8Array|string)=>createHash("sha256").update(data).digest("hex");
const now=()=>new Date().toISOString();
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const digest=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const stamp=(value:unknown):value is string=>typeof value==="string"&&value.length<=80&&Number.isFinite(Date.parse(value));
function safePath(value:unknown):string {
  if(typeof value!=="string"||!value||value.length>1024||/[\\:\x00-\x1f\x7f]/.test(value)||value.startsWith("/")||value.split("/").some(part=>!part||part==="."||part===".."||/[. ]$/.test(part)))fail("UNSAFE_PATH","Artifact paths must be normalized relative workspace paths.");
  return value;
}
function requestPathMatches(value:unknown,path:string):boolean {
  if(typeof value!=="string")return false;
  // The producer accepts either separator, but preserves the original request bytes.
  // It rejects empty, dot and parent segments; do not normalize those into eligibility.
  const requested=safePath(value.replaceAll("\\","/"));
  return process.platform==="win32"?requested.toLowerCase()===path.toLowerCase():requested===path;
}

/** Strict JSON: duplicate object keys, non-finite numbers, invalid UTF-8 and excessive depth are rejected. */
function parseJson(bytes:Buffer,nodeLimit=600000):unknown {
  let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{fail("INVALID_JSON","Artifact is not valid UTF-8.");}
  let at=0,nodes=0;const whitespace=()=>{while(/[\t\n\r ]/.test(text[at]??"x"))at++;};
  const string=():string=>{const start=at++;while(at<text.length){const char=text[at++];if(char==='"'){try{return JSON.parse(text.slice(start,at)) as string;}catch{break;}}if(char==='\\')at++;}return fail("INVALID_JSON","Invalid JSON string.");};
  const value=(depth:number):unknown=>{
    whitespace();if(depth>64||++nodes>nodeLimit)fail("JSON_LIMIT","JSON exceeds the depth or node budget.");
    const char=text[at];
    if(char==='"')return string();
    if(char==="{") {at++;whitespace();const result:Record<string,unknown>=Object.create(null);if(text[at]==="}"){at++;return result;}
      while(at<text.length){whitespace();if(text[at]!=='"')fail("INVALID_JSON","Expected JSON object key.");const key=string();if(Object.hasOwn(result,key))fail("DUPLICATE_JSON_KEY","Duplicate JSON object keys are not accepted.");whitespace();if(text[at++]!==":")fail("INVALID_JSON","Expected colon.");result[key]=value(depth+1);whitespace();const end=text[at++];if(end==="}")return result;if(end!==",")fail("INVALID_JSON","Expected object separator.");}
    }else if(char==="["){at++;whitespace();const result:unknown[]=[];if(text[at]==="]"){at++;return result;}while(at<text.length){result.push(value(depth+1));whitespace();const end=text[at++];if(end==="]")return result;if(end!==",")fail("INVALID_JSON","Expected array separator.");}}
    else {for(const [token,result] of [["true",true],["false",false],["null",null]] as const)if(text.startsWith(token,at)){at+=token.length;return result;}
      const match=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));if(match){at+=match[0].length;const number=Number(match[0]);if(!Number.isFinite(number))fail("NON_FINITE_JSON","Non-finite JSON numbers are not accepted.");if(/^-?\d+$/.test(match[0])&&!Number.isSafeInteger(number))fail("UNSAFE_JSON_INTEGER","Integer JSON values outside the exact JavaScript range cannot be reopened without loss.");return number;}}
    return fail("INVALID_JSON","Invalid JSON value.");
  };
  const parsed=value(0);whitespace();if(at!==text.length)fail("INVALID_JSON","Trailing JSON content.");return parsed;
}

function integrity(status:ComputeStudyIntegrity["status"],code:string,message:string,hashes?:ComputeStudyIntegrity["hashes"]):ComputeStudyIntegrity{return{status,code,message,checkedAt:now(),authority:"unsigned-local-artifacts",...(hashes?{hashes}:{})};}
function sameBinding(a:ComputeStudyRunBinding,b:ComputeStudyRunBinding){return Object.keys(a).every(key=>a[key as keyof ComputeStudyRunBinding]===b[key as keyof ComputeStudyRunBinding])&&Object.keys(a).length===Object.keys(b).length;}
const metadataSchema=z.object({implementation:z.string().max(1000).optional(),implementation_version:z.number().int().optional(),upstream_commit:z.string().max(1000).nullable().optional(),method_references:z.array(z.string().max(4000)).max(100).optional(),upstream_functions:z.array(z.union([z.string().max(1000),z.object({path:z.string().min(1).max(1000),name:z.string().min(1).max(1000)}).strict()])).max(100).optional(),runtime:z.record(z.string().max(1000),z.string().max(4000)).optional(),review_status:z.string().max(1000).optional(),scope:z.string().max(10000).optional(),maturity:z.object({schema_version:z.literal("proto.compute-maturity.v1"),method_stage:z.enum(["method-implementation","numerical-reference-tested","demonstration","heuristic"]),scientific_validation:z.literal("not-established"),domain_validation:z.literal("not-established"),applicability:z.array(z.string()),known_limitations:z.array(z.string()),evidence:z.array(z.object({kind:z.string(),path:z.string(),scope:z.string(),execution_status:z.literal("not-evaluated-here"),test_ids:z.array(z.string()).optional()})),assessment_basis:z.string(),availability_is_separate:z.literal(true),automatic_promotion:z.literal(false)}).optional()}).passthrough();
type FileRecord={name:string;path:string;sha256:string;size:number};
function fileRecord(value:unknown):FileRecord {if(!object(value)||typeof value.name!=="string"||value.name.length>200||!digest(value.sha256)||!Number.isSafeInteger(value.size)||(value.size as number)<0)fail("INVALID_PROVENANCE","Invalid provenance file record.");return{name:value.name,path:safePath(value.path),sha256:value.sha256,size:value.size as number};}
function records(value:unknown):FileRecord[]{if(!Array.isArray(value)||value.length>COMPUTE_STUDIES_IO_LIMITS.provenanceFiles)fail("INVALID_PROVENANCE","Invalid provenance file list.");const result=value.map(fileRecord);if(new Set(result.map(item=>item.name)).size!==result.length)fail("INVALID_PROVENANCE","Duplicate provenance file names.");return result;}
function matches(record:FileRecord,path:string,bytes:Buffer,name:string){if(record.name!==name||record.path!==path||record.sha256!==sha(bytes)||record.size!==bytes.length)fail("DIGEST_MISMATCH",`The ${name} identity, size or digest does not match its file.`);}
async function sourceFreshness(root:string,claims:Array<{name:string;path:string;sha256:string}>) {
  const details:ComputeStudySourceDetail[]=[];let consumed=0;
  for(const claim of claims){const detail:ComputeStudySourceDetail={name:claim.name,path:claim.path,expectedSha256:claim.sha256,status:"not-checked",code:"SOURCE_BUDGET",message:"Original source was not checked within this request's bounded read budget."};details.push(detail);
    if(details.length>COMPUTE_STUDIES_IO_LIMITS.sourceFiles||consumed>=COMPUTE_STUDIES_IO_LIMITS.totalSourceBytes)continue;
    try{const size=(await lstat(resolve(root,claim.path))).size;if(size>COMPUTE_STUDIES_IO_LIMITS.sourceBytes||consumed+size>COMPUTE_STUDIES_IO_LIMITS.totalSourceBytes)continue;consumed+=size;
      const bytes=await readContained(root,claim.path,COMPUTE_STUDIES_IO_LIMITS.sourceBytes);detail.actualSha256=sha(bytes);detail.status=detail.actualSha256===claim.sha256?"current":"changed";detail.code=detail.status==="current"?"SOURCE_MATCH":"SOURCE_CHANGED";detail.message=detail.status==="current"?"Original source bytes match the saved execution digest.":"Original source bytes have changed; the retained internal result is checked separately.";
    }catch{detail.status="unavailable";detail.code="SOURCE_UNAVAILABLE";detail.message="Original source is missing, linked, unreadable or changed during the check.";}
  }
  const status=details.some(item=>item.status==="changed")?"changed":details.some(item=>item.status==="unavailable")?"unavailable":details.some(item=>item.status==="not-checked")?"not-checked":"current";
  return{status,checkedAt:now(),details} as ComputeStudyOpenedRun["sourceFreshness"];
}

async function verifyRun(root:string,runId:string,binding?:ComputeStudyRunBinding):Promise<ComputeStudyOpenedRun>{
  const result:ComputeStudyOpenedRun={runId,...(binding?{binding,tool:binding.tool,createdAt:binding.createdAt}:{}),integrity:integrity("not-checked","NOT_CHECKED","Not yet checked."),sourceFreshness:{status:"not-checked",checkedAt:now(),details:[]}};
  const prefix=`build/compute/${runId}`;
  const paths=[`${prefix}/manifest.json`,`${prefix}/input.json`,`${prefix}/result.json`,`${prefix}/provenance.json`];
  const limits=[COMPUTE_STUDIES_IO_LIMITS.manifestBytes,COMPUTE_STUDIES_IO_LIMITS.inputBytes,COMPUTE_STUDIES_IO_LIMITS.resultBytes,COMPUTE_STUDIES_IO_LIMITS.provenanceBytes];
  let reading=true;
  try{
    const buffers:Buffer[]=[];for(let index=0;index<paths.length;index++){
      if(index===1){
        const manifest=parseJson(buffers[0]),reader=artifactReaders.select("compute",manifest);
        if(reader.status!=="current"){
          if(object(manifest)&&manifest.run_id===runId){if(typeof manifest.tool==="string"&&manifest.tool.length<=200)result.tool=manifest.tool;if(stamp(manifest.created_at))result.createdAt=manifest.created_at;}
          result.integrity=integrity(reader.status,reader.code,reader.message);return result;
        }
      }
      if(index===2){const header=parseJson(buffers[0]);limits[2]=computeResultByteLimit(object(header)?header.tool:undefined);}
      buffers.push(await readContained(root,paths[index],limits[index]));
    }reading=false;
    const [manifestBytes,inputBytes,resultBytes,provenanceBytes]=buffers;
    const manifest=parseJson(manifestBytes),request=parseJson(inputBytes),output=parseJson(resultBytes,computeResultNodeLimit(object(manifest)?manifest.tool:undefined)),provenance=parseJson(provenanceBytes);
    if(!object(manifest)||manifest.schema_version!=="proto-agent.compute.v1"||manifest.ok!==true||manifest.run_id!==runId||typeof manifest.tool!=="string"||!manifest.tool||manifest.tool.length>200||!stamp(manifest.created_at)||!object(manifest.source)||!digest(manifest.source.sha256)||!object(manifest.inputs)||!Array.isArray(manifest.artifacts)||manifest.artifacts.length!==1||manifest.artifacts[0]!==paths[2]||!digest(manifest.result_sha256))fail("INVALID_MANIFEST","The saved Compute manifest identity or required fields are invalid.");
    if(!object(request)||Object.keys(request).length!==2||request.tool!==manifest.tool||!object(request.arguments)||!object(output))fail("INVALID_REQUEST_RESULT","Input snapshot and result must be supported Compute objects for the manifest tool.");
    if(!metadataSchema.safeParse(manifest).success)fail("INVALID_MANIFEST_METADATA","Historical method metadata has an unsupported shape.");
    const provenanceReader=artifactReaders.select("provenance",provenance);
    if(provenanceReader.status!=="current"){result.integrity=integrity(provenanceReader.status,provenanceReader.code,provenanceReader.message);return result;}
    if(!object(provenance)||provenance.run_id!==runId||!object(provenance.policy)||provenance.policy.digest!=="sha256"||provenance.policy.signature!=="none")fail("INVALID_PROVENANCE","The run provenance identity or digest policy is invalid.");
    matches(fileRecord(provenance.subject),`compute/${runId}/manifest.json`,manifestBytes,"manifest");
    const artifacts=records(provenance.artifacts),materials=records(provenance.materials);
    if(artifacts.length!==1)fail("INVALID_PROVENANCE","Expected exactly one retained result artifact.");matches(artifacts[0],`compute/${runId}/result.json`,resultBytes,"artifact:0");
    if(manifest.result_sha256!==sha(resultBytes)||manifest.source.sha256!==sha(inputBytes)||manifest.inputs.request_snapshot!==paths[1])fail("DIGEST_MISMATCH","Manifest result or request snapshot digest/identity mismatch.");
    const materialSnapshot=materials.find(item=>item.name==="input:request_snapshot");if(!materialSnapshot)fail("INVALID_PROVENANCE","Missing request snapshot provenance.");matches(materialSnapshot,paths[1],inputBytes,"input:request_snapshot");
    const sources=[{name:"request",path:safePath(manifest.source.path),sha256:manifest.source.sha256}];
    const inputs=Object.entries(manifest.inputs);if(inputs.length>COMPUTE_STUDIES_IO_LIMITS.provenanceFiles||materials.length!==inputs.length)fail("INVALID_PROVENANCE","Input claims and provenance materials do not correspond exactly.");
    for(const [name,claim] of inputs){if(name==="request_snapshot")continue;
      const locator=/^file:([A-Za-z_][A-Za-z0-9_]*)(?:\[(0|[1-9]\d*)\])?$/.exec(name);if(!locator||!object(claim)||!digest(claim.sha256))fail("INVALID_FILE_INPUT","Unsupported file-input claim.");
      const path=safePath(claim.path);const argument=request.arguments[locator[1]];const selected=locator[2]===undefined?argument:Array.isArray(argument)?argument[Number(locator[2])]:undefined;
      if(!requestPathMatches(selected,path))fail("INVALID_FILE_INPUT","File-input path does not match the retained request argument.");
      const material=materials.find(item=>item.name===`input:${name}`);if(!material||material.path!==path||material.sha256!==claim.sha256)fail("FILE_INPUT_PROVENANCE_MISMATCH","Execution-time and publication-time input digests differ or have missing provenance.");
      sources.push({name,path,sha256:claim.sha256});
    }
    const current:ComputeStudyRunBinding={tool:manifest.tool,createdAt:manifest.created_at,manifestSha256:sha(manifestBytes),inputSha256:sha(inputBytes),resultSha256:sha(resultBytes),provenanceSha256:sha(provenanceBytes)};
    if(binding&&!sameBinding(binding,current))fail("LINK_ANCHOR_CHANGED","Run bytes no longer match the immutable digests saved when this study linked the run.");
    result.sourceFreshness=await sourceFreshness(root,sources);
    // Reopen every component after all other I/O. Each guarded read checks handle identity;
    // this second pass also detects bundle changes between individual initial reads.
    for(let index=0;index<paths.length;index++)if(sha(await readContained(root,paths[index],limits[index]))!==sha(buffers[index]))fail("BUNDLE_CHANGED","The run bundle changed during verification.");
    result.tool=manifest.tool;result.createdAt=manifest.created_at;result.binding=current;
    result.integrity=integrity("verified","BYTES_VERIFIED","Unsigned local artifact bytes and identities match. This does not establish independent execution or scientific validity.",current);
    result.request=request as unknown as ComputeRequest;
    result.receipt={...manifest,manifest_path:paths[0],artifacts:[paths[2],paths[1],paths[0],paths[3]],result:output} as unknown as ComputeRun;
    return result;
  }catch(error){
    const code=error instanceof ComputeStudiesError?error.code:(error as NodeJS.ErrnoException).code==="ENOENT"?"RUN_UNAVAILABLE":reading?"RUN_UNREADABLE":"BUNDLE_CHANGED";
    result.integrity=integrity(code==="RUN_UNAVAILABLE"||code==="RUN_UNREADABLE"?"unavailable":"damaged",code,error instanceof ComputeStudiesError?error.message:"Run files are missing, unsafe, oversized or changed while being read.");
    return result;
  }
}

export function databasePath(root:string,requested:string):string {
  const rel=safePath(requested);if(!rel.startsWith("build/")||!rel.endsWith(".sqlite"))fail("DATABASE_PATH","Study storage must be a workspace build .sqlite path.");
  let current=root;
  for(const part of rel.split("/").slice(0,-1)){current=join(current,part);if(!existsSync(current))mkdirSync(current);const info=lstatSync(current);if(info.isSymbolicLink()||!info.isDirectory()||realpathSync(current)!==current)fail("DATABASE_PATH","Study database parents must be regular workspace directories.");}
  const path=join(root,...rel.split("/"));if(!existsSync(path)){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);closeSync(fd);}
  guardDatabase(root,path);return path;
}
export function guardDatabase(root:string,path:string){
  let current=root;for(const part of relative(root,dirname(path)).split(sep).filter(Boolean)){current=join(current,part);const info=lstatSync(current);if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(current)!==current)fail("DATABASE_PATH","Study database directory identity changed.");}
  for(const candidate of [path,`${path}-wal`,`${path}-shm`,`${path}-journal`])if(existsSync(candidate)){const stat=lstatSync(candidate);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>64*MiB||realpathSync(candidate)!==candidate)fail("DATABASE_PATH","Study storage must be a bounded, unlinked local file.");}
}

const bindingSchema=z.object({tool:z.string().min(1).max(200),createdAt:z.string().refine(stamp),manifestSha256:z.string().refine(digest),provenanceSha256:z.string().refine(digest),inputSha256:z.string().refine(digest),resultSha256:z.string().refine(digest)}).strict();
const studySchema=z.object({id:z.string().uuid(),revision:z.number().int().positive(),name:z.string().min(1).max(120),question:z.string().max(8000),createdAt:z.string().refine(stamp),updatedAt:z.string().refine(stamp),runCount:z.number().int().min(0).max(COMPUTE_STUDY_LIMITS.links),links:z.array(z.object({runId:z.string().regex(/^[a-f0-9]{32}$/),linkedAt:z.string().refine(stamp),binding:bindingSchema}).strict()).max(COMPUTE_STUDY_LIMITS.links),history:z.array(z.object({revision:z.number().int().positive(),at:z.string().refine(stamp),action:z.enum(["create","update","link","unlink"]),name:z.string().max(120).optional(),question:z.string().max(8000).optional(),runId:z.string().regex(/^[a-f0-9]{32}$/).optional(),binding:bindingSchema.optional()}).strict()).max(COMPUTE_STUDY_LIMITS.history)}).strict();
type StudyRow={id:string;revision:number;payload:string};
class Store {
  readonly migrationReport:SchemaMigrationReport;
  db:DatabaseSync;root:string;path:string;secret:string;
  constructor(root:string,path:string){this.root=root;this.path=path;this.db=new DatabaseSync(path);try{
    guardDatabase(root,path);this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.migrationReport=applySchemaMigrations(this.db,"compute-studies",[{version:1,sql:`
      CREATE TABLE IF NOT EXISTS compute_study_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS compute_studies(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,name TEXT NOT NULL,question TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,run_count INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS compute_studies_order ON compute_studies(updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS compute_study_runs(run_id TEXT PRIMARY KEY,summary TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS study_insert AFTER INSERT ON compute_studies BEGIN UPDATE compute_study_meta SET value=CAST(value AS INTEGER)+1 WHERE key='studies-generation'; END;
      CREATE TRIGGER IF NOT EXISTS study_update AFTER UPDATE ON compute_studies BEGIN UPDATE compute_study_meta SET value=CAST(value AS INTEGER)+1 WHERE key='studies-generation'; END;
      CREATE TRIGGER IF NOT EXISTS study_delete AFTER DELETE ON compute_studies BEGIN UPDATE compute_study_meta SET value=CAST(value AS INTEGER)+1 WHERE key='studies-generation'; END;
      CREATE TRIGGER IF NOT EXISTS run_insert AFTER INSERT ON compute_study_runs BEGIN UPDATE compute_study_meta SET value=CAST(value AS INTEGER)+1 WHERE key='runs-generation'; END;
      CREATE TRIGGER IF NOT EXISTS run_update AFTER UPDATE ON compute_study_runs BEGIN UPDATE compute_study_meta SET value=CAST(value AS INTEGER)+1 WHERE key='runs-generation'; END;`}]);
    this.db.prepare("INSERT OR IGNORE INTO compute_study_meta VALUES('workspace',?)").run(root);
    if(this.meta("workspace")!==root)fail("WORKSPACE_MISMATCH","The study database belongs to another workspace.");
    this.db.prepare("INSERT OR IGNORE INTO compute_study_meta VALUES('secret',?)").run(randomUUID());
    this.db.prepare("INSERT OR IGNORE INTO compute_study_meta VALUES('studies-generation','0')").run();this.db.prepare("INSERT OR IGNORE INTO compute_study_meta VALUES('runs-generation','0')").run();
    this.secret=this.meta("secret");guardDatabase(root,path);
  }catch(error){this.db.close();throw error;}}
  meta(key:string){return(this.db.prepare("SELECT value FROM compute_study_meta WHERE key=?").get(key) as {value:string}).value;}
  transaction<T>(fn:()=>T):T{guardDatabase(this.root,this.path);this.db.exec("BEGIN IMMEDIATE");try{const result=fn();this.db.exec("COMMIT");return result;}catch(error){this.db.exec("ROLLBACK");throw error;}}
  row(id:string):StudyRow{const header=this.db.prepare("SELECT length(CAST(payload AS BLOB)) AS bytes FROM compute_studies WHERE id=?").get(id) as {bytes:number}|undefined;if(!header)fail("STUDY_NOT_FOUND","This study does not exist.");if(header.bytes>COMPUTE_STUDY_LIMITS.studyBytes)fail("STUDY_DAMAGED","Stored study exceeds its byte budget; its original row has been retained.");return this.db.prepare("SELECT id,revision,payload FROM compute_studies WHERE id=?").get(id) as StudyRow;}
  decode(row:StudyRow):ComputeStudy{let study:ComputeStudy;try{study=studySchema.parse(parseJson(Buffer.from(row.payload)));}catch{fail("STUDY_DAMAGED","Stored study is unsupported or damaged; its original row has been retained.");}if(study.id!==row.id||study.revision!==row.revision||study.runCount!==study.links.length||new Set(study.links.map(link=>link.runId)).size!==study.links.length||study.history.length!==study.revision||study.history.some((event,index)=>event.revision!==index+1))fail("STUDY_DAMAGED","Stored study identity, revision or history is inconsistent.");return study;}
  get(id:string){return this.decode(this.row(id));}
  create(name:string,question:string){return this.transaction(()=>{if((this.db.prepare("SELECT COUNT(*) n FROM compute_studies").get() as {n:number}).n>=COMPUTE_STUDY_LIMITS.studies)fail("STUDY_LIMIT","This workspace has reached its study count limit.");const at=now(),id=randomUUID(),study:ComputeStudy={id,revision:1,name,question,createdAt:at,updatedAt:at,runCount:0,links:[],history:[{revision:1,at,action:"create",name,question}]};this.db.prepare("INSERT INTO compute_studies VALUES(?,?,?,?,?,?,?,?)").run(id,1,name,question,at,at,0,JSON.stringify(study));return study;});}
  mutate(request:Extract<ComputeStudiesRequest,{action:"update"|"link"|"unlink"}>,binding?:ComputeStudyRunBinding){return this.transaction(()=>{const row=this.row(request.studyId),study=this.decode(row);if(study.revision!==request.expectedRevision)fail("REVISION_CONFLICT","The study changed. Reload it before editing.");if(study.history.length>=COMPUTE_STUDY_LIMITS.history)fail("HISTORY_LIMIT","Study history is full; no prior event was removed.");const at=now();study.revision++;study.updatedAt=at;
    if(request.action==="update"){study.name=request.name;study.question=request.question;study.history.push({revision:study.revision,at,action:"update",name:study.name,question:study.question});}
    else if(request.action==="link"){if(study.links.some(item=>item.runId===request.runId))fail("ALREADY_LINKED","This run is already linked; existing anchors cannot be rewritten.");if(study.links.length>=COMPUTE_STUDY_LIMITS.links)fail("LINK_LIMIT","This study has reached its run link limit.");if(!binding)fail("RUN_NOT_VERIFIED","Only a verified retained Compute run can be linked.");study.links.push({runId:request.runId,linkedAt:at,binding});study.history.push({revision:study.revision,at,action:"link",runId:request.runId,binding});}
    else {const link=study.links.find(item=>item.runId===request.runId);if(!link)fail("RUN_NOT_LINKED","This run is not linked to the study.");study.links=study.links.filter(item=>item.runId!==request.runId);study.history.push({revision:study.revision,at,action:"unlink",runId:request.runId,binding:link.binding});}
    study.runCount=study.links.length;const payload=JSON.stringify(study);if(Buffer.byteLength(payload)>COMPUTE_STUDY_LIMITS.studyBytes)fail("STUDY_LIMIT","Study metadata exceeds its byte budget.");const changed=this.db.prepare("UPDATE compute_studies SET revision=?,name=?,question=?,updated_at=?,run_count=?,payload=? WHERE id=? AND revision=? AND payload=?").run(study.revision,study.name,study.question,study.updatedAt,study.runCount,payload,study.id,request.expectedRevision,row.payload);if(Number(changed.changes)!==1)fail("REVISION_CONFLICT","Another writer changed the study.");return study;});}
  summary(run:ComputeStudyOpenedRun){const {request:_request,receipt:_receipt,sourceFreshness:_freshness,...summary}=run;const saved=JSON.stringify(summary);this.transaction(()=>{
    const existing=this.db.prepare("SELECT 1 FROM compute_study_runs WHERE run_id=?").get(run.runId);
    // Arbitrary missing IDs must not grow the discovery index. Links remain in their
    // project independently of this cache, including when discovery is already full.
    if(!existing&&(run.integrity.status!=="verified"||(this.db.prepare("SELECT COUNT(*) n FROM compute_study_runs").get() as {n:number}).n>=COMPUTE_STUDIES_IO_LIMITS.discoveredRuns))return;
    this.db.prepare("INSERT INTO compute_study_runs VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET summary=excluded.summary WHERE summary!=excluded.summary").run(run.runId,saved);
  });}
  cursor(scope:string,limit:number,generation:string,offset:number){const data=Buffer.from(JSON.stringify({workspace:sha(this.root),scope,limit,generation,offset})).toString("base64url");return`${data}.${createHmac("sha256",this.secret).update(data).digest("hex")}`;}
  offset(cursor:string|undefined,scope:string,limit:number,generation:string):number|null{if(!cursor)return 0;const parts=cursor.split(".");if(parts.length!==2||!/^[a-zA-Z0-9_-]+$/.test(parts[0])||!digest(parts[1]))fail("INVALID_CURSOR","Invalid study page cursor.");const expected=createHmac("sha256",this.secret).update(parts[0]).digest();if(!timingSafeEqual(expected,Buffer.from(parts[1],"hex")))fail("INVALID_CURSOR","This cursor was not issued by this study database.");let value:unknown;try{value=parseJson(Buffer.from(parts[0],"base64url"));}catch{fail("INVALID_CURSOR","Invalid study page cursor.");}if(!object(value)||value.workspace!==sha(this.root)||value.scope!==scope||value.limit!==limit||!Number.isSafeInteger(value.offset)||(value.offset as number)<0||(value.offset as number)>COMPUTE_STUDIES_IO_LIMITS.discoveredRuns+COMPUTE_STUDY_LIMITS.studies)fail("INVALID_CURSOR","Page cursor belongs to a different workspace, scope or page size.");return value.generation===generation?value.offset as number:null;}
  page(scope:string,limit:number,cursor:string|undefined,items:()=>unknown[],generationKey:string):{items:unknown[];page:ComputeStudiesPage}{this.db.exec("BEGIN");try{const generation=this.meta(generationKey),offset=this.offset(cursor,scope,limit,generation);if(offset===null)return{items:[],page:{generation,nextCursor:null,resetRequired:true}};const all=items(),selected=all.slice(offset,offset+limit);return{items:selected,page:{generation,nextCursor:offset+limit<all.length?this.cursor(scope,limit,generation,offset+limit):null}};}finally{this.db.exec("COMMIT");}}
  close(){this.db.close();}
}

async function discover(store:Store):Promise<{truncated:boolean;pending:number}>{
  const directory=join(store.root,"build","compute");let directoryHandle;
  try{const rootInfo=await lstat(directory);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||await realpath(directory)!==directory)fail("DISCOVERY_PATH","Run discovery directory must be an unlinked workspace directory.");directoryHandle=await opendir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return{truncated:false,pending:0};throw error;}
  let count=0,truncated=false;const ids:string[]=[];
  try{for await(const entry of directoryHandle){if(++count>COMPUTE_STUDIES_IO_LIMITS.discoveryEntries){truncated=true;break;}if(entry.isDirectory()&&!entry.isSymbolicLink()&&/^[a-f0-9]{32}$/.test(entry.name))ids.push(entry.name);}}finally{/* for-await closes its directory handle */}
  store.transaction(()=>{let indexed=(store.db.prepare("SELECT COUNT(*) n FROM compute_study_runs").get() as {n:number}).n;for(const id of ids.sort()){if(store.db.prepare("SELECT 1 FROM compute_study_runs WHERE run_id=?").get(id))continue;if(indexed>=COMPUTE_STUDIES_IO_LIMITS.discoveredRuns){truncated=true;break;}const summary:ComputeStudyRunSummary={runId:id,integrity:integrity("not-checked","OPEN_REQUIRED","Directory discovered; reopen to verify its saved artifact bytes.")};store.db.prepare("INSERT INTO compute_study_runs VALUES(?,?)").run(id,JSON.stringify(summary));indexed++;}});
  const pending=store.db.prepare("SELECT run_id,summary FROM compute_study_runs WHERE json_extract(summary,'$.integrity.code')='OPEN_REQUIRED' AND json_extract(summary,'$.tool') IS NULL ORDER BY run_id DESC LIMIT ?").all(COMPUTE_STUDIES_IO_LIMITS.discoveredRuns) as Array<{run_id:string;summary:string}>;
  for(const row of pending.slice(0,COMPUTE_STUDIES_IO_LIMITS.discoveryHeaders)){
    const summary:ComputeStudyRunSummary={runId:row.run_id,integrity:integrity("not-checked","MANIFEST_UNREADABLE","Manifest metadata is unavailable; reopen for a full diagnostic.")};
    try{
      const manifest=parseJson(await readContained(store.root,`build/compute/${row.run_id}/manifest.json`,COMPUTE_STUDIES_IO_LIMITS.manifestBytes));
      const reader=artifactReaders.select("compute",manifest);
      if(reader.status!=="current")summary.integrity=integrity(reader.status,reader.code,reader.message);
      if(object(manifest)&&manifest.run_id===row.run_id&&typeof manifest.tool==="string"&&manifest.tool.length>0&&manifest.tool.length<=200&&stamp(manifest.created_at)){
        summary.tool=manifest.tool;summary.createdAt=manifest.created_at;
        if(reader.status==="current")summary.integrity=integrity("not-checked","OPEN_REQUIRED","Manifest labels indexed without verifying the bundle. Reopen to check saved bytes.");
      }
    }catch{/* Keep the run discoverable with an explicit unchecked metadata diagnostic. */}
    // Do not overwrite a concurrent full verification with an unchecked header.
    store.transaction(()=>store.db.prepare("UPDATE compute_study_runs SET summary=? WHERE run_id=? AND summary=?").run(JSON.stringify(summary),row.run_id,row.summary));
  }
  return{truncated,pending:Math.max(0,pending.length-COMPUTE_STUDIES_IO_LIMITS.discoveryHeaders)};
}

/** Host-only path option supports isolated preview databases; renderer requests cannot choose paths. */
export async function requestComputeStudies(workspace:string,input:unknown,options:{databaseRelativePath?:string}={}):Promise<ComputeStudiesResponse>{
  const request=ComputeStudiesRequestSchema.parse(input),root=await realpath(workspace);const path=databasePath(root,options.databaseRelativePath??"build/compute-studies/studies.sqlite");const store=new Store(root,path);
  try{
    if(request.action==="create")return{study:store.create(request.name,request.question)};
    if(request.action==="get")return{study:store.get(request.studyId)};
    if(request.action==="update"||request.action==="unlink")return{study:store.mutate(request)};
    if(request.action==="list"){const result=store.page("studies",request.limit??30,request.cursor,()=>store.db.prepare("SELECT id,revision,name,question,created_at AS createdAt,updated_at AS updatedAt,run_count AS runCount FROM compute_studies ORDER BY updated_at DESC,id DESC").all(),"studies-generation");return{migrationReport:store.migrationReport,studies:result.items as NonNullable<ComputeStudiesResponse["studies"]>,page:result.page};}
    if(request.action==="link"){const study=store.get(request.studyId);if(study.revision!==request.expectedRevision)fail("REVISION_CONFLICT","The study changed. Reload it before editing.");const run=await verifyRun(root,request.runId);store.summary(run);if(run.integrity.status!=="verified"||!run.integrity.hashes||!run.tool||!run.createdAt)fail("RUN_NOT_VERIFIED",`${run.integrity.code}: ${run.integrity.message}`);return{study:store.mutate(request,{...run.integrity.hashes,tool:run.tool,createdAt:run.createdAt})};}
    if(request.action==="open-run"){let binding:ComputeStudyRunBinding|undefined;if(request.studyId){binding=store.get(request.studyId).links.find(link=>link.runId===request.runId)?.binding;if(!binding)fail("RUN_NOT_LINKED","This run is not linked to the requested study.");}const run=await verifyRun(root,request.runId,binding);store.summary(run);return{run};}
    if(request.studyId){const study=store.get(request.studyId);const limit=request.limit??20,generation=String(study.revision),scope=`study:${study.id}`,offset=store.offset(request.cursor,scope,limit,generation);if(offset===null)return{runs:[],page:{generation,nextCursor:null,resetRequired:true}};const links=study.links.slice().sort((a,b)=>b.linkedAt.localeCompare(a.linkedAt)||b.runId.localeCompare(a.runId));const runs=links.slice(offset,offset+limit).map(link=>({runId:link.runId,tool:link.binding.tool,createdAt:link.binding.createdAt,linkedAt:link.linkedAt,binding:link.binding,integrity:integrity("not-checked","OPEN_REQUIRED","Linked run retained. Reopen to verify bytes against this study's immutable anchor.")}));return{runs,page:{generation,nextCursor:offset+limit<links.length?store.cursor(scope,limit,generation,offset+limit):null}};}
    const discovery=await discover(store);const result=store.page("runs",request.limit??20,request.cursor,()=>store.db.prepare("SELECT summary FROM compute_study_runs ORDER BY json_extract(summary,'$.createdAt') DESC,run_id DESC").all().map(row=>{const summary=JSON.parse(row.summary as string) as ComputeStudyRunSummary;return{...summary,integrity:summary.integrity.status==="verified"?{...summary.integrity,status:"not-checked",code:"REOPEN_REQUIRED",message:"Previous byte check retained. Reopen to check the current files."}:summary.integrity};}),"runs-generation");return{migrationReport:store.migrationReport,runs:result.items as ComputeStudyRunSummary[],page:{...result.page,indexingPending:discovery.pending,discoveryTruncated:discovery.truncated}};
  }finally{store.close();}
}
