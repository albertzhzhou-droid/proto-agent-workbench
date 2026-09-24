import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { minimalChildEnvironment, terminateOwnedProcessTree } from "./process-security.ts";
import type { ChemWorkbenchStatus } from "../../shared/chem-workbench.ts";

const GET_API = new Set(["/api/workspace", "/api/workflows", "/api/projects", "/api/profiles", "/api/model/status", "/api/design/catalog", "/api/design/history"]);
const POST_API = new Set(["/api/compile", "/api/orchestrate", "/api/tool", "/api/export/png", "/api/workflow/prepare", "/api/workflow/approve", "/api/workflow/submit", "/api/workflow/cancel", "/api/workflow/read", "/api/workflow/refinement/prepare", "/api/workflow/refinement/approve", "/api/project/save", "/api/structure/import", "/api/structure/edit", "/api/structure/build", "/api/structure/compare", "/api/design/run", "/api/design/read", "/api/design/import", "/api/design/export", "/api/design/export-interface"]);
const STATIC = new Set(["/", "/app.js", "/workflow.js", "/structure-lab.js", "/design-studio.js", "/design-studio.css", "/refinement-lab.js", "/refinement-lab.css", "/dispersion-diagnostics.js", "/dispersion-diagnostics.css", "/style.css", "/viewer.js", "/geometry-view-model.js", "/interface-workbench.js", "/vendor/3Dmol-2.5.5.min.js"]);
const UI_ASSETS = new Set(["paper-chem.css", "paper-chem.js", "fonts.css", "xdl-panel.css", "xdl-panel.js"]);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function chemEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Chem's existing worker supervisor admits these Windows runtime descriptors.
  // QCEngine/py-cpuinfo requires the real architecture values; omitting them can
  // misidentify a working x86 runtime as unsupported. No model/provider secrets.
  const runtime: NodeJS.ProcessEnv = {};
  for (const key of ["USERPROFILE", "USERNAME", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "COMPUTERNAME"]) {
    if (process.env[key]) runtime[key] = process.env[key];
  }
  return minimalChildEnvironment({...runtime,...extra});
}
interface Snapshot { version: string; sourceRoot: string; sourceManifestHash: string; files: Record<string, {sha256: string; bytes: number}> }
export interface ChemWorkbenchOptions {
  repoRoot: string;
  workspacePath: string;
  runtimeRoot?: string;
  uiRoot?: string;
  integrationRoot?: string;
  pythonExecutable?: string;
  psi4Prefix?: string;
  xdlPython?: string;
  sourceRoot?: string;
}

export function chemRouteLimit(path: string): number {
  return path === "/api/design/import" ? 20 * 1024 * 1024 : path === "/api/export/png" ? 3_000_000 : path.startsWith("/api/xdl/") ? 200 * 1024 : 512 * 1024;
}
export function admittedChemRoute(method: string, path: string): boolean {
  return method === "GET" ? GET_API.has(path) || STATIC.has(path) || /^\/exports\/[0-9a-f]{64}\.png$/.test(path) || path === "/api/xdl/status"
    : method === "POST" && (POST_API.has(path) || path === "/api/xdl/inspect");
}
export function chemParentOrigin(value: string): string {
  if (value === "file:" || value === "file://" || value === "null") return "file:";
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || url.origin !== value) throw new Error("Chem embedding requires a local Workbench origin.");
  return url.origin;
}
async function exists(path: string): Promise<boolean> { try {await lstat(path);return true;} catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;throw error;} }
async function containedPath(root: string, name: string): Promise<string> {
  if (!name || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || name.includes(":")) throw new Error("Invalid Chem snapshot path.");
  const target = resolve(root,name), rel = relative(resolve(root),target);
  if (rel.startsWith("..") || rel === "" || rel.startsWith(sep)) throw new Error("Chem path leaves its root.");
  for (let cursor = target; cursor !== dirname(root) && cursor.length >= root.length; cursor = dirname(cursor)) {
    if (await exists(cursor) && (await lstat(cursor)).isSymbolicLink()) throw new Error("Linked Chem workspace paths are not admitted.");
    if (cursor === root) break;
  }
  return target;
}

/** Unchanged Chem science runs in a verified local snapshot. Only this wrapper owns
 * the loopback process, narrow HTTP bridge, and presentation-layer integration. */
export class ChemWorkbenchService {
  private child?: ChildProcess;
  private bridge?: Server;
  private bridgeOrigin = "";
  private upstreamOrigin = "";
  private parentOrigin = "";
  private prefix = `/${randomBytes(32).toString("hex")}/`;
  private starting?: Promise<ChemWorkbenchStatus>;
  private lastStatus?: ChemWorkbenchStatus;
  private closing = false;
  private readonly options: ChemWorkbenchOptions;
  readonly workspacePath: string;
  private readonly runtimeRoot: string;
  private readonly uiRoot: string;
  private readonly integrationRoot: string;
  private readonly auxiliary = new Set<ChildProcess>();

  constructor(options: ChemWorkbenchOptions) {
    this.options = options;
    this.workspacePath = resolve(options.workspacePath,"build/chem-workspace");
    this.runtimeRoot = resolve(options.runtimeRoot ?? join(options.repoRoot,"apps/proto-workbench/runtime/chem-workbench"));
    this.uiRoot = resolve(options.uiRoot ?? join(options.repoRoot,"apps/proto-workbench/runtime/chem-ui"));
    this.integrationRoot = resolve(options.integrationRoot ?? join(dirname(this.runtimeRoot),"chem-integration"));
  }
  async start(parentOrigin: string): Promise<ChemWorkbenchStatus> {
    const admitted = chemParentOrigin(parentOrigin);
    if (this.parentOrigin && this.parentOrigin !== admitted) throw new Error("Chem bridge is already bound to another Workbench origin.");
    this.parentOrigin = admitted;
    if (this.closing) return {available:false,error:"Chem workspace is closing.",workspacePath:this.workspacePath};
    if (this.lastStatus?.available && this.child?.exitCode === null && this.bridge?.listening) return this.lastStatus;
    if (!this.starting) this.starting = this.launch().catch(async error => {
      await this.stopOwned();
      return this.lastStatus = {available:false,error:error instanceof Error ? error.message : "Chem workspace failed to start.",workspacePath:this.workspacePath};
    }).finally(() => {this.starting = undefined;});
    return this.starting;
  }
  private async stage(): Promise<{manifest: Snapshot; migrated: {designs:number;projects:number}}> {
    const manifest = JSON.parse(await readFile(join(this.runtimeRoot,"snapshot-manifest.json"),"utf8")) as Snapshot;
    if (manifest.version !== "chem-source-snapshot/v1" || hash(JSON.stringify(manifest.files)) !== manifest.sourceManifestHash) throw new Error("Chem source manifest is invalid.");
    // Confirm the owned staging root itself is not redirected before any write.
    await containedPath(resolve(this.options.workspacePath),"build/chem-workspace");
    await mkdir(this.workspacePath,{recursive:true});
    if (await realpath(this.workspacePath) !== this.workspacePath) throw new Error("Chem working root must be a real local directory.");
    for (const [name, entry] of Object.entries(manifest.files)) {
      const source = await containedPath(this.runtimeRoot,name), target = await containedPath(this.workspacePath,name);
      const bytes = await readFile(source);
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Chem snapshot integrity failure: ${name}`);
      if (!await exists(target) || hash(await readFile(target)) !== entry.sha256) {
        await mkdir(dirname(target),{recursive:true}); await writeFile(target,bytes);
      }
    }
    await writeFile(join(this.workspacePath,"snapshot-manifest.json"),JSON.stringify(manifest,null,2)+"\n");
    const migrated = {designs:0,projects:0}, receiptPath = join(this.workspacePath,"migration-receipt.json");
    if (await exists(receiptPath)) {
      const receipt = JSON.parse(await readFile(receiptPath,"utf8"));
      return {manifest,migrated:receipt.migrated ?? migrated};
    }
    const sourceRoot = this.options.sourceRoot ?? manifest.sourceRoot, records: {path:string;sha256:string;bytes:number}[] = [];
    for (const category of ["designs","projects"] as const) {
      const source = join(sourceRoot,"build/workspace",category);
      if (!await exists(source)) continue;
      for (const file of await readdir(source,{withFileTypes:true})) {
        if (!file.isFile() || !/^[0-9a-f]{64}\.json$/.test(file.name)) continue;
        const bytes = await readFile(join(source,file.name));
        if (bytes.length > 20 * 1024 * 1024) throw new Error("Legacy Chem record exceeds its migration bound.");
        const name = `build/workspace/${category}/${file.name}`, target = await containedPath(this.workspacePath,name);
        await mkdir(dirname(target),{recursive:true});
        if (await exists(target)) {if (hash(await readFile(target)) !== hash(bytes)) throw new Error("Chem migration would overwrite a different record.");}
        else await writeFile(target,bytes,{flag:"wx"});
        records.push({path:name,sha256:hash(bytes),bytes:bytes.length}); migrated[category]++;
      }
    }
    await writeFile(receiptPath,JSON.stringify({version:"chem-history-migration/v1",sourceRoot,createdAt:new Date().toISOString(),migrated,records,retainedAtSource:["plans","approvals","jobs","runs","workflows","refinement-preparations"],executionApprovalsTransferred:false},null,2)+"\n");
    return {manifest,migrated};
  }
  private async launch(): Promise<ChemWorkbenchStatus> {
    if(this.bridge || this.child)await this.stopOwned();
    const {manifest,migrated} = await this.stage();
    const sourceRoot = this.options.sourceRoot ?? manifest.sourceRoot;
    const python = this.options.pythonExecutable ?? process.env.PROTO_CHEM_PYTHON ?? join(sourceRoot,process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
    if (!await exists(python)) throw new Error("Chem's configured Python runtime is unavailable. Restore its installed environment or configure PROTO_CHEM_PYTHON.");
    const child = this.child = spawn(python,["-B","-X","utf8",join(this.integrationRoot,"launch.py"),"--root",this.workspacePath],{
      cwd:this.workspacePath,windowsHide:true,detached:process.platform !== "win32",stdio:["ignore","pipe","pipe"],
      env:chemEnvironment({PYTHONPATH:join(this.workspacePath,"src"),PYTHONDONTWRITEBYTECODE:"1",PYTHONUTF8:"1",CHEM_PSI4_PREFIX:this.options.psi4Prefix ?? process.env.CHEM_PSI4_PREFIX ?? join(sourceRoot,".chem-backends/psi4"),CHEM_MODEL_KEY:process.env.CHEM_MODEL_KEY}),
    });
    let stderr = "";
    child.stderr?.on("data", chunk => {stderr = (stderr + chunk.toString()).slice(-12000);});
    this.upstreamOrigin = await new Promise<string>((resolveStart,reject) => {
      let output = "", done = false;
      const finish = (error?: Error, origin?: string) => {if(done)return;done=true;clearTimeout(timer);error ? reject(error) : resolveStart(origin!);};
      const timer = setTimeout(() => finish(new Error(`Chem backend startup timed out. ${stderr}`)),30000);
      child.once("error", error => finish(error));
      child.once("exit", code => finish(new Error(`Chem backend stopped (${code}). ${stderr}`)));
      child.stdout?.on("data", chunk => {
        output=(output+chunk.toString()).slice(-4000);
        const match=output.match(/Chem Workbench: (http:\/\/127\.0\.0\.1:\d+)/);
        if(match)finish(undefined,match[1]);
      });
    });
    this.bridge = createServer((req,res) => {void this.handle(req,res).catch(error => {if(!res.headersSent)this.json(res,500,{error:error instanceof Error?error.message:"Chem bridge failed."});else res.destroy();});});
    await new Promise<void>((resolveListen,reject) => {this.bridge!.once("error",reject);this.bridge!.listen(0,"127.0.0.1",resolveListen);});
    const address=this.bridge.address();if(!address || typeof address === "string")throw new Error("Chem bridge address unavailable.");
    this.bridgeOrigin=`http://127.0.0.1:${address.port}`;
    child.once("exit", () => {this.lastStatus={available:false,error:"The Chem backend stopped. Reopen Chem CLI to restart it.",workspacePath:this.workspacePath};});
    return this.lastStatus={available:true,url:this.bridgeOrigin+this.prefix,sourceManifestHash:manifest.sourceManifestHash,workspacePath:this.workspacePath,migrated};
  }
  private headers(res: ServerResponse, mime: string): void {
    res.setHeader("Content-Type",mime);res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("Content-Security-Policy",`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${this.parentOrigin};`);
  }
  private json(res: ServerResponse, status: number, value: unknown): void {this.headers(res,"application/json; charset=utf-8");res.statusCode=status;res.end(JSON.stringify(value));}
  private async handle(req: IncomingMessage,res: ServerResponse): Promise<void> {
    if (req.headers.host !== new URL(this.bridgeOrigin).host || !req.url?.startsWith(this.prefix) || req.url.includes("?")) {this.json(res,404,{error:"Unknown Chem bridge route."});return;}
    const path = "/"+req.url.slice(this.prefix.length), method=req.method ?? "";
    const origin=req.headers.origin;
    if (origin && origin !== this.bridgeOrigin || req.headers["sec-fetch-site"] === "cross-site" && path !== "/") {this.json(res,403,{error:"Chem bridge same-origin access required."});return;}
    if (method === "GET" && path === "/bridge.js") {this.headers(res,"text/javascript; charset=utf-8");res.end(this.bootstrap());return;}
    if (method === "GET" && path.startsWith("/chem-ui/")) {await this.uiAsset(path,res);return;}
    if (!admittedChemRoute(method,path)) {this.json(res,404,{error:"Chem route is not registered."});return;}
    if (method === "POST" && (origin !== this.bridgeOrigin || req.headers["content-type"] !== "application/json")) {this.json(res,403,{error:"Same-origin JSON request required."});return;}
    const chunks: Buffer[]=[];let length=0;
    for await (const chunk of req) {length+=chunk.length;if(length>chemRouteLimit(path)){this.json(res,413,{error:"Chem request exceeds the original workflow limit."});return;}chunks.push(chunk);}
    if(path.startsWith("/api/xdl/")){const value=await this.xdl(path.endsWith("/status") ? Buffer.from('{"action":"status"}') : Buffer.concat(chunks));this.json(res,value.ok===false?400:200,value);return;}
    if (method === "GET" && STATIC.has(path)) {
      const target=join(this.workspacePath,"src/chem_workbench/web_assets",path === "/" ? "index.html" : path.slice(1));
      let bytes=await readFile(target);
      if(path === "/")bytes=Buffer.from(this.embeddedHtml(bytes.toString("utf8")));
      this.headers(res,path === "/" ? "text/html; charset=utf-8" : path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");res.end(bytes);return;
    }
    const upstream=new URL(this.upstreamOrigin);
    await new Promise<void>((resolveProxy,reject) => {
      const outgoing=httpRequest({hostname:"127.0.0.1",port:upstream.port,path,method,headers:{Host:upstream.host,Origin:upstream.origin,...(method==="POST"?{"Content-Type":"application/json","Content-Length":length}:{})}},incoming => {
        this.headers(res,String(incoming.headers["content-type"] ?? "application/json; charset=utf-8"));res.statusCode=incoming.statusCode ?? 502;
        incoming.pipe(res);incoming.on("end",resolveProxy);incoming.on("error",reject);
      });
      outgoing.setTimeout(15*60*1000,()=>outgoing.destroy(new Error("Chem workflow response timed out.")));
      outgoing.on("error",reject);res.once("close",()=>outgoing.destroy());outgoing.end(Buffer.concat(chunks));
    });
  }
  private embeddedHtml(html: string): string {
    const rewritten=html.replace(/\b(src|href)="\/(?!\/)([^"]*)"/g,(_whole,attribute,value)=>`${attribute}="${this.prefix}${value}"`);
    return rewritten.replace("<head>",`<head><script src="${this.prefix}bridge.js"></script>`).replace("</head>",`<link rel="stylesheet" href="${this.prefix}chem-ui/fonts.css"><link rel="stylesheet" href="${this.prefix}chem-ui/paper-chem.css"><link rel="stylesheet" href="${this.prefix}chem-ui/xdl-panel.css"><script src="${this.prefix}chem-ui/xdl-panel.js" defer></script><script src="${this.prefix}chem-ui/paper-chem.js" defer></script></head>`);
  }
  private bootstrap(): string {
    return `"use strict";window.__CHEM_BASE_PATH__=${JSON.stringify(this.prefix)};window.__CHEM_PARENT_ORIGIN__=${JSON.stringify(this.parentOrigin === "file:" ? "null" : this.parentOrigin)};const originalFetch=window.fetch.bind(window);window.fetch=(input,init)=>{if(typeof input==='string'&&input.startsWith('/')&&!input.startsWith('//')&&!input.startsWith(window.__CHEM_BASE_PATH__))input=window.__CHEM_BASE_PATH__+input.slice(1);return originalFetch(input,init).then(async response=>{if(typeof input==='string'&&input.endsWith('/api/export/png')&&response.ok){const value=await response.json();if(typeof value.url==='string'&&value.url.startsWith('/exports/'))value.url=window.__CHEM_BASE_PATH__+value.url.slice(1);return new Response(JSON.stringify(value),{status:response.status,headers:response.headers});}return response;});};`;
  }
  private async uiAsset(path: string,res: ServerResponse): Promise<void> {
    let name:string;try{name=decodeURIComponent(path.slice("/chem-ui/".length));}catch{this.json(res,404,{error:"Unknown font."});return;}
    if(!UI_ASSETS.has(name) && !/^fonts\/[A-Za-z0-9 ._-]+\.otf$/.test(name)){this.json(res,404,{error:"Unknown Chem UI resource."});return;}
    let target=join(this.uiRoot,name);
    // Source previews use editable overlays and the same original font files.
    if(!await exists(target) && this.uiRoot.endsWith(join("src","chem-ui"))){
      if(name.startsWith("fonts/"))target=join(dirname(this.uiRoot),"renderer/assets/fonts/anthropic",basename(name));
      else if(name==="fonts.css")target=join(dirname(this.uiRoot),"renderer/fonts.css");
    }
    let bytes=await readFile(target);
    if(name==="fonts.css")bytes=Buffer.from(bytes.toString("utf8").replaceAll("./assets/fonts/anthropic/","./fonts/"));
    this.headers(res,name.endsWith(".otf")?"font/otf":name.endsWith(".css")?"text/css; charset=utf-8":"text/javascript; charset=utf-8");res.end(bytes);
  }
  private async xdl(payload: Buffer): Promise<Record<string,unknown>> {
    const manifest=JSON.parse(await readFile(join(this.runtimeRoot,"snapshot-manifest.json"),"utf8")) as Snapshot;
    const source=this.options.sourceRoot ?? manifest.sourceRoot;
    const python=this.options.xdlPython ?? process.env.PROTO_CHEM_XDL_PYTHON ?? join(source,".chem-backends/xdl/Scripts/python.exe");
    if(!await exists(python))return {ok:false,available:false,error:{type:"RuntimeUnavailable",message:"The installed standalone XDL environment is unavailable."},compiled:false,executed:false};
    return new Promise((resolveXdl,reject)=>{
      const child=spawn(python,["-B","-X","utf8",join(this.integrationRoot,"xdl-inspect.py")],{cwd:this.workspacePath,windowsHide:true,stdio:["pipe","pipe","pipe"],env:chemEnvironment({PYTHONUTF8:"1",PYTHONDONTWRITEBYTECODE:"1"})});this.auxiliary.add(child);
      let stdout=Buffer.alloc(0),stderr="",exceeded=false,timeout=false;
      const timer=setTimeout(()=>{timeout=true;void terminateOwnedProcessTree(child);},30000);
      child.stdout.on("data",chunk=>{if(stdout.length+chunk.length>2*1024*1024){exceeded=true;void terminateOwnedProcessTree(child);}else stdout=Buffer.concat([stdout,chunk]);});
      child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-2000);});
      child.once("error",error=>{clearTimeout(timer);this.auxiliary.delete(child);reject(error);});
      child.once("close",code=>{clearTimeout(timer);this.auxiliary.delete(child);if(exceeded||timeout){reject(new Error(timeout?"XDL inspection timed out.":"XDL inspection output limit exceeded."));return;}try{resolveXdl(JSON.parse(stdout.toString("utf8")));}catch{reject(new Error(`XDL inspection failed (${code}): ${stderr}`));}});
      child.stdin.end(payload);
    });
  }
  private async stopOwned(): Promise<void> {
    if(this.bridge){this.bridge.closeAllConnections();await new Promise<void>(resolveClose=>this.bridge!.close(()=>resolveClose()));this.bridge=undefined;}
    for(const child of [...this.auxiliary])await terminateOwnedProcessTree(child);
    if(this.child){await terminateOwnedProcessTree(this.child);this.child=undefined;}
  }
  async close(): Promise<void> {this.closing=true;if(this.starting)await this.starting;await this.stopOwned();}
}
