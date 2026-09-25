import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ResearchChatResponse, ResearchChatSession, ResearchDocument, ResearchChatRecoveryIssue } from "../../shared/research-chat.ts";
import { decodeResearchSession, encodeResearchSession, updateResearchState, ResearchSessionStateError, type VersionedResearchChatSession } from "../../shared/research-session-state.ts";
import type { ModelService } from "./model-service.ts";
import { retainChatContext } from "./chat-context.ts";
import { BLOCKED_SCHEMA, PLAN_SCHEMA, RESEARCH_TOOLS, WORKFLOW_GUIDANCE, cacheableResearchCall, planReceipt, repeatedResearchCall, researchSignature, type ResearchToolBridge } from "./research-tools.ts";
import type { ResearchActivity } from "../../shared/research-chat.ts";
import { DOCUMENT_BASE64_LIMIT, importResearchDocument, isResearchDocument, readResearchDocument } from "./research-documents.ts";
import {RESEARCH_BASELINE} from "../../shared/research-baseline.ts";
import { isResearchFactCandidate, reopenResearchEvidence, unreviewedResearchEvidence } from "./research-evidence.ts";
import { RESEARCH_CLAIM_LIMITS } from "../../shared/research-claims.ts";
import { ResearchClaimsService, type ClaimVerificationContext } from "./research-claims.ts";
import { ResearchChatRepository, ResearchSessionCache, ResearchStorageError, type ResearchStorageLimits } from "./research-chat-repository.ts";

import { TURN_LIMITS, turnBudget, completionGate, executionActivity, toolResultFailed, projectToolResult } from "./turn-engine.ts";
import type { PolicyGrant } from "../../shared/tool-policy.ts";
import { issueHostPolicyGrant } from "./permissions.ts";
import { resolveToolContract } from "../../shared/tool-contracts.ts";

const ID = z.string().uuid();
const text = z.string().max(128_000);
const sourcedStateText = z.object({text:z.string().min(1).max(32_000),sourceMessageId:z.string().min(1).max(128),sourceRole:z.enum(["user","assistant"])}).strict();
const researchStateSchema = z.object({
  question:sourcedStateText.nullable(), nextStep:sourcedStateText.nullable(),
  confirmedConstraints:z.array(sourcedStateText.extend({id:z.string().min(1).max(128),sourceRole:z.literal("user")})).max(128),
  openQuestions:z.array(sourcedStateText).max(128),
}).strict();
const claimRelation=z.enum(["supports","contradicts","context"]);
const claimEvidence=z.union([
  z.object({readId:ID,start:z.number().int().min(0).max(128_000),end:z.number().int().min(1).max(128_000),quote:z.string().min(1).max(RESEARCH_CLAIM_LIMITS.quoteCharacters),relation:claimRelation}).strict(),
  z.object({evidenceId:ID,relation:claimRelation}).strict(),
]);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["create", "models"]) }).strict(),
  z.object({ action:z.literal("list"),limit:z.number().int().min(1).max(50).default(30),cursor:z.string().min(1).max(2048).optional() }).strict(),
  z.object({ action: z.literal("open_link"), url:z.string().url().max(4096) }).strict(),
  z.object({ action: z.enum(["get", "cancel"]), sessionId: ID }).strict(),
  z.object({ action:z.literal("messages"),sessionId:ID,cursor:z.string().min(1).max(2048).optional(),limit:z.number().int().min(1).max(100).default(40) }).strict(),
  z.object({ action:z.literal("recover"),sessionId:ID,expectedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),confirmUnowned:z.literal(true).optional() }).strict(),
  z.object({ action: z.literal("rename"), sessionId: ID, title: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.literal("research_state"), sessionId: ID, expectedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), state:researchStateSchema }).strict(),
  z.object({action:z.literal("claim_source"),sessionId:ID,documentId:ID,unitIndex:z.number().int().min(0).max(50_000).optional(),startOffset:z.number().int().min(0).max(128_000).optional()}).strict(),
  z.object({action:z.literal("claim_save"),sessionId:ID,expectedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),claimId:ID.optional(),text:z.string().min(1).max(RESEARCH_CLAIM_LIMITS.claimCharacters).refine(value=>value.trim().length>0),evidence:z.array(claimEvidence).max(RESEARCH_CLAIM_LIMITS.evidence)}).strict(),
  z.object({action:z.literal("claim_review"),sessionId:ID,expectedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),claimId:ID,state:z.enum(["unreviewed","reviewed"])}).strict(),
  z.object({ action: z.literal("connect"), modelId: z.string().min(1).max(1024), instanceId: z.string().min(1).max(1024).optional() }).strict(),
  z.object({ action: z.literal("send"), sessionId: ID, modelId: z.string().min(1).max(1024), content: z.string().trim().min(1).max(32_000), documentIds: z.array(ID).max(8), workflow:z.enum(["explore","literature","analysis","reproduce"]).default("explore"),toolsEnabled:z.boolean().default(true),networkEnabled:z.boolean().default(true),codeExecutionEnabled:z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("document"), sessionId: ID, name: z.string().trim().min(1).max(120), content: text, documentId: ID.optional(), expectedRevision: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal("read"), sessionId: ID, path: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal("import"), sessionId: ID, name: z.string().trim().min(1).max(120), base64: z.string().max(DOCUMENT_BASE64_LIMIT) }).strict(),
  z.object({ action: z.literal("document_read"), sessionId: ID, documentId: ID, startUnit: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(5) }).strict(),
  z.object({ action: z.literal("export"), sessionId: ID, documentId: ID, expectedRevision: z.number().int().min(1) }).strict(),
]);
type ChatRuntime = Pick<ModelService, "scan" | "load" | "getExecutionBinding" | "countExecutionTokens" | "chat">;
interface ChatServiceOptions {
  databasePath: string; workspace: string; runtime: ChatRuntime;
  readFile?: (path: string) => Promise<{ path: string; content: string; sha256: string }>;
  tools?: Pick<ResearchToolBridge,"execute"> & Partial<Pick<ResearchToolBridge,"settings"|"guidance"|"authorizeSend"|"finishSend"|"executionRecord">>;
  openLink?: (url:string)=>Promise<void>;
  storageLimits?: Partial<ResearchStorageLimits>;
}
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".csv", ".json", ".ipynb", ".py", ".r", ".ts", ".tsx", ".js", ".mjs", ".css", ".html", ".yaml", ".yml", ".tex"]);

export class ResearchChatService {
  private repository: ResearchChatRepository;
  private cache: ResearchSessionCache;
  private requests = new Set<Promise<ResearchChatResponse>>();
  private claims: ResearchClaimsService;
  private claimOperations = new Set<Promise<unknown>>();
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private documentImports = new Set<Promise<ResearchDocument>>();
  private closed = false;
  private closing?:Promise<void>;
  private options: ChatServiceOptions;
  constructor(options: ChatServiceOptions) {
    this.options = options;
    this.claims = new ResearchClaimsService(options.workspace);
    this.repository=new ResearchChatRepository(options.databasePath,options.workspace,options.storageLimits);
    this.cache=new ResearchSessionCache(this.repository.limits);
  }
  get migrationReport(){return this.repository.migrationReport;}
  private issue(sessionId:string, code:string, message:string, disposition:ResearchChatRecoveryIssue["disposition"]):void {
    this.repository.issue(sessionId,code,message,disposition);
  }
  private restoreAfterFailedSave(session:VersionedResearchChatSession,error:unknown):void {
    if(this.cache.get(session.id)?.session!==session)return;
    this.running.get(session.id)?.controller.abort();
    let restored=false;
    try {
      const loaded=this.repository.read(session.id);
      if(loaded){this.cache.set(session.id,loaded);restored=true;}
      else this.cache.delete(session.id);
    } catch { /* Never leave a dirty session active when a reload also fails. */ }
    if(!restored)this.cache.delete(session.id);
    const code=error instanceof ResearchSessionStateError||error instanceof ResearchStorageError?error.code:"PERSISTENCE_ERROR";
    this.issue(session.id,code,error instanceof Error?error.message:String(error),restored?"reloaded-latest":"retained-unopened");
  }
  private save(session: VersionedResearchChatSession, mode:"mutation"|"state"|"migration"="mutation",execution:"normal"|"acquire"|"release"|"recover"="normal",confirmUnowned=false): void {
    // Detached references held by an aborted generation must never save a second
    // time after the first conflict restored the map to another writer's state.
    if(this.cache.get(session.id)?.session!==session)throw new ResearchSessionStateError("REVISION_CONFLICT","Research session changed in another writer; this operation was stopped.");
    try {
      const expected=this.cache.get(session.id)?.raw;
      const previous=expected===undefined?undefined:decodeResearchSession(expected);
      if(!previous?.ok)throw new ResearchSessionStateError("REVISION_CONFLICT","The saved research session is no longer available. Reopen it before continuing.");
      const revision=previous.session.revision+(mode==="migration"?0:1);
      if(!Number.isSafeInteger(revision))throw new ResearchSessionStateError("INVALID_REVISION","Session revision is exhausted.");
      if(session.revision!==(mode==="state"?revision:previous.session.revision))throw new ResearchSessionStateError("REVISION_CONFLICT","Research session revision changed. Reopen it before saving.");
      const updatedAt=mode==="migration"?session.updatedAt:new Date().toISOString();
      const payload=encodeResearchSession({...session,execution:undefined,revision,updatedAt});
      const next={session:{...session,revision,updatedAt},raw:payload,migrated:false};
      this.cache.checkAdmission(session.id,next);
      this.repository.write(next.session,payload,expected!,execution,confirmUnowned);
      session.revision=revision;session.updatedAt=updatedAt;this.cache.set(session.id,{...next,session});
    } catch(error) {this.restoreAfterFailedSave(session,error);throw error;}
  }
  private get(id: string, refresh=false): VersionedResearchChatSession {
    let loaded=this.cache.get(id);
    if(!loaded||(refresh&&!this.cache.isPinned(id)&&!this.repository.matches(id,loaded.raw))) {
      loaded=this.repository.read(id);
      if(!loaded){this.cache.delete(id);throw new Error("Conversation does not belong to the current workspace or its retained payload cannot be safely loaded.");}
      this.cache.set(id,loaded);
    }
    return loaded.session;
  }
  private claimOperation<T>(operation:()=>Promise<T>):Promise<T> {
    const pending=operation();this.claimOperations.add(pending);
    return pending.finally(()=>this.claimOperations.delete(pending));
  }
  private async projectClaims(session:VersionedResearchChatSession,context?:ClaimVerificationContext,priorityClaimId?:string) {
    const before=structuredClone(session),revision=session.revision;
    if(session.status==="generating")return {...this.claims.deferred(before,"Source checks are pending while this response is generating. They resume when the conversation is idle."),snapshotSession:before};
    const owner=this.repository.execution(session);
    if(owner.status!=="none"&&owner.status!=="owned")return {...this.claims.deferred(before,"Source checks are pending until the unfinished execution is safely recovered."),snapshotSession:before};
    const projected=await this.claims.project(before,context,priorityClaimId);
    let latest=this.get(session.id),changed=latest!==session||latest.revision!==revision;
    // Merge only observations about the same immutable citation. Never replace
    // the live session with a clone captured before streaming or another writer.
    for(let attempt=0;attempt<2&&projected.invalidations.length;attempt++) {
      let added=false;
      for(const change of projected.invalidations) {
        const original=before.claims?.find(claim=>claim.id===change.claimId)?.evidence.find(entry=>entry.id===change.evidenceId);
        const evidence=latest.claims?.find(claim=>claim.id===change.claimId)?.evidence.find(entry=>entry.id===change.evidenceId);
        if(evidence&&!evidence.invalidated&&JSON.stringify(evidence.source)===JSON.stringify(original?.source)){evidence.invalidated=change.invalidation;added=true;}
      }
      if(!added)break;
      try {this.save(latest);break;}
      catch(error) {
        if(!(error instanceof ResearchSessionStateError)||error.code!=="REVISION_CONFLICT")throw error;
        latest=this.get(session.id);changed=true;
      }
    }
    const snapshotSession=structuredClone(latest);
    return {...(changed?this.claims.deferred(snapshotSession,"The conversation changed during its source check. Source verification is pending; the latest conversation is shown."):projected),snapshotSession};
  }
  private assertClaimMutation(session:VersionedResearchChatSession,expectedRevision:number):void {
    if(this.closed||session.status!=="idle"||this.running.has(session.id))throw new Error("Claims can only be changed while this conversation is idle.");
    if(this.cache.get(session.id)?.session!==session||session.revision!==expectedRevision)throw new ResearchSessionStateError("REVISION_CONFLICT","Research session revision changed. Reopen it before changing a claim.");
  }
  private async snapshot(session: ResearchChatSession,priorityClaimId?:string): Promise<ResearchChatResponse> {
    const live=this.cache.get(session.id);
    let projectedClaims;
    if(session.claims?.length)projectedClaims=await this.claimOperation(()=>this.projectClaims(session as VersionedResearchChatSession,undefined,priorityClaimId));
    const copy = projectedClaims?.snapshotSession??structuredClone(session);
    copy.execution=this.repository.execution(copy);
    if(copy.execution.status==="owned")copy.execution.canCancel=this.running.has(copy.id);
    if(projectedClaims)copy.claims=projectedClaims.claims;
    const messagePage=this.repository.messagePage(copy.id);
    if(live?.session===session&&session.status==="generating") {
      const current=session.messages.at(-1);
      if(current?.state==="streaming") {
        const index=messagePage.messages.findIndex(message=>message.id===current.id);
        if(index>=0){messagePage.messages[index]=structuredClone(current);messagePage.liveStream={messageId:current.id,baseRevision:messagePage.revision,sha256:createHash("sha256").update(JSON.stringify(current)).digest("hex")};}
      }
    }
    copy.messages=messagePage.messages;
    let remaining = 8;
    // Projections are disposable views, never authority restored from SQLite.
    // Bound disk work per poll; older receipts remain explicitly unreviewed.
    for (const message of [...copy.messages].reverse()) {
      for (const activity of [...(message.activity ?? [])].reverse()) {
      const contract=resolveToolContract(activity.tool==="science_run"?String(activity.input.name):activity.tool);
      activity.capabilityId=contract?.capabilityId;activity.backendTool=contract?.name;
      if(activity.execution){const record=this.options.tools?.executionRecord?.(activity.execution.operationId);if(record){const durable=executionActivity(activity.execution.operationId,activity.status,record,activity.blocked);activity.execution={...durable.execution!,decisionId:record.decisionId};activity.status=durable.status==="effect-unknown"?"error":durable.status as ResearchActivity["status"];}}
      delete activity.evidence;
      if (!isResearchFactCandidate(activity)) continue;
      activity.evidence = remaining-- > 0
        ? await reopenResearchEvidence(this.options.workspace, copy.id, activity)
        : unreviewedResearchEvidence("SNAPSHOT_PROJECTION_LIMIT");
      }
      if(message.state==="complete"||message.state==="incomplete-evidence")message.state=completionGate(message.activity??[]);
    }
    return {session: copy,messagePage};
  }
  request(input: unknown): Promise<ResearchChatResponse> {
    if(this.closed)return Promise.reject(new Error("Chat workspace is closing. Refresh after the workspace change."));
    if(this.requests.size>=64)return Promise.reject(new ResearchStorageError("CACHE_ADMISSION","Too many conversation operations are active. Wait for existing work to finish."));
    const pending=this.performRequest(input);this.requests.add(pending);
    return pending.finally(()=>this.requests.delete(pending));
  }
  private async performRequest(input: unknown): Promise<ResearchChatResponse> {
    if (this.closed) throw new Error("Chat workspace is closing. Refresh after the workspace change.");
    const request = schema.parse(input);
    let release:(()=>void)|undefined;
    try {
    if(request.action==="messages")return {messagePage:this.repository.messagePage(request.sessionId,request.cursor,request.limit)};
    if("sessionId" in request){this.get(request.sessionId,true);release=this.cache.pin(request.sessionId);}
    if(request.action==="open_link") {
      const url=new URL(request.url);
      if(url.protocol!=="https:" || url.username || url.password || !this.options.openLink) throw new Error("Only HTTPS links without embedded credentials can be opened in the browser.");
      await this.options.openLink(url.href);return {};
    }
    if (request.action === "models") return { models: await this.options.runtime.scan("http://127.0.0.1:1234") };
    if (request.action === "connect") {
      const models = await this.options.runtime.scan("http://127.0.0.1:1234");
      const model = models.find(item => item.id === request.modelId);
      if (!model) throw new Error("LM Studio no longer reports this model. Refresh the model list.");
      await this.options.runtime.load(request.modelId, request.instanceId ? { instanceId: request.instanceId } : { contextLength: Math.min(32_768, model.contextLength || 32_768) });
      return { models: await this.options.runtime.scan("http://127.0.0.1:1234") };
    }
    if (request.action === "list") return this.repository.list(request.limit,request.cursor);
    if (request.action === "create") {
      const now = new Date().toISOString();
      const payload=encodeResearchSession({id: randomUUID(), title: "New conversation", createdAt: now, updatedAt: now, messages: [], documents: [], status: "idle"});
      const decoded=decodeResearchSession(payload);
      if(!decoded.ok)throw new Error(decoded.diagnostic);
      const session=decoded.session;
      this.repository.write(session,payload);
      this.cache.set(session.id,{session,raw:payload,migrated:false});release=this.cache.pin(session.id);
      return await this.snapshot(session);
    }
    if (!("sessionId" in request)) throw new Error("Conversation ID is required.");
    const session = this.get(request.sessionId);
    if (request.action === "get") return await this.snapshot(session);
    if(request.action==="recover") {
      if(session.revision!==request.expectedRevision)throw new ResearchSessionStateError("REVISION_CONFLICT","Session changed. Reopen it before recovery.");
      if(this.running.has(session.id))throw new ResearchStorageError("EXECUTION_OWNERSHIP","Cancel the owned execution and wait for it to stop before recovery.");
      const state=this.repository.execution(session);
      if(!state.canRecover||(state.status==="owner-unknown"&&!request.confirmUnowned))throw new ResearchStorageError("EXECUTION_OWNERSHIP",state.reason);
      const stream=this.repository.readStreamBuffer(session.id,this.cache.get(session.id)!.raw);
      if(stream){const index=session.messages.findIndex(message=>message.id===stream.id);if(index>=0)session.messages[index]=stream;}
      for(const message of session.messages){
        if(message.state==="streaming")message.state="stopped";
        for(const activity of message.activity??[])if(activity.status==="running"){
          const recordedAt=new Date().toISOString();
          const record=this.options.tools?.executionRecord?.(activity.execution?.operationId??activity.id);
          const durable=executionActivity(activity.execution?.operationId??activity.id,"error",record,activity.blocked);
          if(record)activity.execution={...durable.execution!,decisionId:record.decisionId};
          activity.status=durable.status==="complete"?"complete":"error";activity.finishedAt??=recordedAt;
          activity.interruption={source:"explicit-recovery",message:"Recovered unfinished execution; completion was not confirmed and no tool was replayed.",recordedAt};
        }
      }
      session.status="idle";session.error="Unfinished execution was explicitly recovered. Prior completion is unconfirmed; no tool was replayed.";
      this.save(session,"mutation","recover",request.confirmUnowned);
      return await this.snapshot(session);
    }
    const execution=this.repository.execution(session);
    if(!["claim_source","document_read","export","cancel"].includes(request.action)&&execution.status!=="none"&&execution.status!=="owned")
      throw new ResearchStorageError("EXECUTION_OWNERSHIP",execution.reason);
    if(request.action==="claim_source")return await this.claimOperation(async()=>({claimSource:await this.claims.readSource(session,request)}));
    if(request.action==="claim_save"||request.action==="claim_review")return await this.claimOperation(async()=>{
      this.assertClaimMutation(session,request.expectedRevision);
      if(session.claims?.length)await this.projectClaims(session,undefined,request.claimId);
      this.assertClaimMutation(session,request.expectedRevision);
      const claims=request.action==="claim_save"?await this.claims.saveClaim(structuredClone(session),request):await this.claims.reviewClaim(structuredClone(session),request);
      this.assertClaimMutation(session,request.expectedRevision);
      session.claims=claims;this.save(session);return await this.snapshot(session,request.claimId??claims.at(-1)?.id);
    });
    if (request.action === "cancel") {
      const running = this.running.get(session.id);
      running?.controller.abort(); await running?.done;
      if(!running&&execution.status!=="none")throw new ResearchStorageError("EXECUTION_OWNERSHIP",execution.reason);
      return await this.snapshot(this.get(session.id));
    }
    if (request.action === "rename") { session.title = request.title; this.save(session); return await this.snapshot(session); }
    if (request.action === "research_state") {
      if(session.status!=="idle"||this.running.has(session.id))throw new Error("Research state can only be confirmed while this conversation is idle.");
      const next=updateResearchState(session,request.state,request.expectedRevision,new Date().toISOString());
      Object.assign(session,next);this.save(session,"state");return await this.snapshot(session);
    }
    if (request.action === "document_read") {
      const document = session.documents.find(item => item.id === request.documentId);
      if (!document) throw new Error("Document does not belong to this conversation.");
      return { documentPage: await readResearchDocument(this.options.workspace, document, request.startUnit, request.limit) };
    }
    if (request.action === "document" || request.action === "read" || request.action === "import") {
      let document: ResearchDocument;
      if (request.action === "import" || (request.action === "read" && isResearchDocument(request.path))) {
        if (session.documents.length >= 24) throw new Error("This conversation already has 24 documents. Start a new conversation for more files.");
        const pending = importResearchDocument({ workspace: this.options.workspace, sessionId: session.id, ...(request.action === "read" ? {path: request.path} : {name: request.name, base64: request.base64}) });
        this.documentImports.add(pending);
        try { document = await pending; } finally { this.documentImports.delete(pending); }
        if (this.closed) throw new Error("Workspace closed while the document was being parsed. Its source and extraction were preserved in the previous workspace.");
      } else if (request.action === "read") {
        if (!this.options.readFile || !TEXT_EXTENSIONS.has(extname(request.path).toLowerCase())) throw new Error("Choose a text, Markdown, data or source-code file in this workspace.");
        const source = await this.options.readFile(request.path);
        if (Buffer.byteLength(source.content) > 128_000) throw new Error("Choose a text document smaller than 128 KB.");
        document = { id: randomUUID(), name: request.path.replaceAll("\\", "/").split("/").at(-1)!, content: source.content, revision: 1, source: source.path, sourceSha256: source.sha256 };
      } else {
        if (!TEXT_EXTENSIONS.has(extname(request.name).toLowerCase()) || /[\\/\x00-\x1f]/.test(request.name)) throw new Error("Use a text or source-code filename, such as notes.md or analysis.py.");
        if (Buffer.byteLength(request.content) > 128_000 || request.content.includes("\0")) throw new Error("Document must be UTF-8 text, at most 128 KB.");
        const previous = request.documentId ? session.documents.find(item => item.id === request.documentId) : undefined;
        if (request.documentId && (!previous || previous.revision !== request.expectedRevision)) throw new Error("Document revision changed. Reopen it before saving.");
        if (previous?.extraction) throw new Error("Parsed source documents are preserved. Create an editable text copy to revise their contents.");
        document = { ...previous, id: previous?.id ?? randomUUID(), name: request.name, content: request.content, revision: (previous?.revision ?? 0) + 1 };
      }
      const position = session.documents.findIndex(item => item.id === document.id);
      if (position < 0) {
        if (session.documents.length >= 24) throw new Error("This conversation already has 24 documents. Start a new conversation for more files.");
        session.documents.push(document);
      } else session.documents[position] = document;
      session.updatedAt = new Date().toISOString(); this.save(session); return await this.snapshot(session);
    }
    if (request.action === "export") {
      const document = session.documents.find(item => item.id === request.documentId);
      if (!document || document.revision !== request.expectedRevision) throw new Error("Document revision changed. Reopen it before exporting.");
      if (document.extraction) return { exportPath: resolve(this.options.workspace, document.extraction.textPath) };
      const root = await realpath(this.options.workspace);
      let directory = root;
      for (const part of ["build", "chat", session.id]) {
        directory = join(directory, part);
        await mkdir(directory).catch(error => { if (error.code !== "EEXIST") throw error; });
        const metadata = await lstat(directory);
        const rel = relative(root, await realpath(directory));
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Export directory is not a regular workspace directory.");
      }
      const name = document.name.replace(/[^\p{L}\p{N}._-]/gu, "_");
      const exportPath = resolve(directory, `${randomUUID().slice(0,8)}-r${document.revision}-${name}`);
      await writeFile(exportPath, document.content, { flag: "wx", encoding: "utf8" });
      return { exportPath };
    }
    if (request.action === "send") {
      const moduleSettings=this.options.tools?.settings?.();
      if (session.status === "generating") throw new Error("A response is already running in this conversation.");
      if (session.messages.length >= 2000) throw new Error("Start a new conversation to continue; this transcript is preserved.");
      const documents = request.documentIds.map(id => {
        const document = session.documents.find(item => item.id === id);
        if (!document) throw new Error("A selected document is no longer available.");
        return structuredClone(document);
      });
      // Reconcile the selected binding before accepting a user message.
      await this.options.runtime.getExecutionBinding(request.modelId);
      if (this.running.has(session.id) || this.closed) throw new Error("Conversation state changed before sending. Try again.");
      const now = new Date().toISOString();
      session.modelId = request.modelId; session.status = "generating"; session.error = undefined; session.updatedAt = now;
      session.workflow = request.workflow;
      session.moduleSettings=moduleSettings;
      if (!session.messages.length) session.title = request.content.replace(/\s+/g, " ").slice(0,70);
      session.messages.push({id: randomUUID(), role: "user", content: request.content, documents, createdAt: now});
      const history = structuredClone(session.messages);
      const assistantId=randomUUID();
      const policyGrant:PolicyGrant=issueHostPolicyGrant({id:randomUUID(),source:"session-send",actor:"local-user",surface:"chat",scopeId:assistantId,risks:[...(request.toolsEnabled&&request.networkEnabled?["network" as const]:[]),...(request.toolsEnabled&&request.codeExecutionEnabled?["code-execution" as const]:[])],grantedAt:now,expiresAt:new Date(Date.now()+TURN_LIMITS.durationMs).toISOString()});
      const assistant = {id: assistantId, role: "assistant" as const, content: "", createdAt: now, state: "streaming" as const,policyGrant};
      session.messages.push(assistant); this.save(session,"mutation","acquire");
      this.options.tools?.authorizeSend?.(policyGrant);
      const controller = new AbortController();
      const releaseGeneration=this.cache.pin(session.id),runId=this.repository.ownedRunId(session.id);
      const done = this.generate(session, history, controller, request.toolsEnabled).finally(() => {
        this.options.tools?.finishSend?.(assistantId);this.repository.finishOwnRun(session.id,runId);this.running.delete(session.id);releaseGeneration();
      });
      this.running.set(session.id, { controller, done });
      return await this.snapshot(session);
    }
    throw new Error("Unsupported chat request.");
    } finally {release?.();this.cache.trim();}
  }
  private async generate(session: VersionedResearchChatSession, history: ResearchChatSession["messages"], controller: AbortController, toolsEnabled:boolean): Promise<void> {
    const assistant = session.messages.at(-1)!;
    try {
      const binding = await this.options.runtime.getExecutionBinding(session.modelId!, controller.signal);
      const {replyTokens,inputBudget}=turnBudget(binding.contextLength);
      assistant.modelBinding={instanceId:binding.instanceId,modelFingerprint:binding.modelFingerprint??null,contextLength:binding.contextLength};
      assistant.budget={steps:0,outputTokens:0,outputTokenMethod:"conservative-estimate",limit:TURN_LIMITS.outputTokens};
      const tools=toolsEnabled&&this.options.tools?RESEARCH_TOOLS:[];
      const guidance=WORKFLOW_GUIDANCE[session.workflow??"explore"] + `\nThe configured development baseline is ${RESEARCH_BASELINE.displayName} via LM Studio. The actual bound model for this session is ${session.modelId}; configured preferences do not establish model availability.` + (tools.length ? "\nOne canonical tool registry combines OpenScience research procedures, Biomni computations, Chem chemistry operators and DSH session/context handling. Both editions use the same registry and saved chemistry artifacts. Discover capabilities with science_catalog; do not create duplicate tools. For chemistry discover chemistry.catalog and chemistry.guidance, then use exact operator schemas. Report successful calculations only from actual tool receipts. When missing inputs, unavailable prerequisites or unresolved evidence prevent the requested work, call research_report_blocked with the reason and concrete unmet requirements. Distinguish concentration-based reaction visualization from measured or atomistic trajectories. Existing quantum calculation approvals remain in Chem Design; tools cannot grant them." : "\nThis turn has tools disabled. Answer from the conversation and selected references; do not claim live searches or executions.");
      const skillGuidance=session.moduleSettings?this.options.tools?.guidance?.(session.moduleSettings)??"":"";
      const retained = retainChatContext(history, inputBudget-Buffer.byteLength(JSON.stringify(tools))-Buffer.byteLength(guidance)-Buffer.byteLength(skillGuidance)-512, session);
      const messages:Record<string,unknown>[]=retained.messages;
      messages[0].content += `\n${guidance}\n${skillGuidance}`;
      const deadline=Date.now()+TURN_LIMITS.durationMs;
      const cache=new Map<string,{output:string;artifactPath?:string;artifactSha256?:string}>();
      assistant.activity=[];
      let lastSave = Date.now();
      let finished=false;
      for(let step=0;step<TURN_LIMITS.steps;step++) {
        assistant.budget.steps=step+1;
        controller.signal.throwIfAborted();
        if(Date.now()>deadline) throw new Error("Research turn reached its time budget. Results are saved; send a follow-up to continue.");
        // Keep call/result pairing intact while moving older large observations
        // out of the active context. Full outputs remain on disk and in the trace.
        const size=()=>Buffer.byteLength(JSON.stringify({messages,tools}))+512;
        for(const message of messages) {
          if(size()<=inputBudget) break;
          if(message.role==="tool"&&typeof message.content==="string"&&message.content.length>700) message.content=message.content.slice(0,500)+"\n[Earlier result shortened; read the full output artifact from its receipt.]";
        }
        const counted=await this.options.runtime.countExecutionTokens(session.modelId!,messages,tools,controller.signal);
        if(counted.tokens>inputBudget) throw new Error("The active research context is full. Results are saved; continue in a new message or use fewer attached documents.");
        session.context={omittedMessages:retained.omittedMessages,inputTokens:counted.tokens,contextLength:binding.contextLength,method:counted.method,retention:retained.retention};
        const calls=new Map<number,{id:string;type:"function";function:{name:string;arguments:string}}>();
        let content="";
        let finishReason:string|undefined;
        await this.options.runtime.chat(session.modelId!,{messages,...(tools.length?{tools,tool_choice:"auto"}:{}),max_tokens:replyTokens,temperature:0.4,deadline},chunk=>{
          controller.signal.throwIfAborted();
          const choice=chunk.choices?.[0];
          if(choice?.finish_reason) finishReason=choice.finish_reason;
          const delta=choice?.delta;
          if(delta?.content) {content+=delta.content;assistant.content+=delta.content;assistant.budget!.outputTokens+=Buffer.byteLength(delta.content);if(assistant.budget!.outputTokens>TURN_LIMITS.outputTokens)throw new Error("Research turn reached its output token budget (conservative byte estimate). Partial evidence is saved.");}
          for(const part of delta?.tool_calls??[]) {
            const call=calls.get(part.index)??{id:"",type:"function",function:{name:"",arguments:""}};
            if(part.id) call.id=part.id;
            if(part.function?.name) call.function.name+=part.function.name;
            if(part.function?.arguments){call.function.arguments+=part.function.arguments;assistant.budget!.outputTokens+=Buffer.byteLength(part.function.arguments);if(assistant.budget!.outputTokens>TURN_LIMITS.outputTokens)throw new Error("Research turn reached its output token budget while generating tool arguments. Partial evidence is saved.");}
            if(call.function.arguments.length>128_000||(!calls.has(part.index)&&calls.size>=8)) throw new Error("Model tool-call payload exceeds the supported request size.");
            calls.set(part.index,call);
          }
          if(Date.now()-lastSave>1500){this.repository.bufferStream(session.id,assistant,this.cache.get(session.id)!.raw);lastSave=Date.now();}
        },controller.signal);
        if(finishReason==="length") throw new Error("The model reached its response limit. Partial output is saved; send a follow-up to continue.");
        if(!calls.size){finished=true;break;}
        if(!tools.length) throw new Error("The model requested a tool while tools were disabled.");
        const pending=[...calls.values()].map(call=>({...call,id:call.id||randomUUID()}));
        if(pending.some(call=>!RESEARCH_TOOLS.some(tool=>tool.function.name===call.function.name))) throw new Error("Model requested a tool outside the unified registry.");
        messages.push({role:"assistant",content:content||null,tool_calls:pending});
        if(content) assistant.content+="\n\n";
        for(const call of pending) {
          controller.signal.throwIfAborted();
          const args=z.record(z.string(),z.unknown()).parse(JSON.parse(call.function.arguments||"{}"));
          if(repeatedResearchCall(assistant.activity,call.function.name,args)) throw new Error("Repeated identical tool calls stopped. Review the saved results before continuing.");
          const operationId=`chat:${assistant.id}:${createHash("sha256").update(call.id).digest("hex").slice(0,24)}`;
          const contract=resolveToolContract(call.function.name==="science_run"?String(args.name):call.function.name);
          const activity:ResearchActivity={id:call.id,execution:{operationId,state:"intent"},tool:call.function.name,capabilityId:contract?.capabilityId,backendTool:contract?.name,input:args,status:"running",startedAt:new Date().toISOString()};
          assistant.activity.push(activity);this.save(session);
          try {
            const signature=researchSignature(call.function.name,args);
            const cacheable=cacheableResearchCall(call.function.name,args);
            const cached=cacheable?cache.get(signature):undefined;
            if(cached) {activity.output=cached.output;activity.artifactPath=cached.artifactPath;activity.artifactSha256=cached.artifactSha256;activity.cached=true;}
            else {
              let result:unknown;
              if(call.function.name==="research_report_blocked") {
                const blocked={...BLOCKED_SCHEMA.parse(args),declaredAt:new Date().toISOString()};
                assistant.blocked=blocked;activity.blocked=true;
                result={ok:true,code:"RESEARCH_REPORTED_BLOCKED",blocked:true,...blocked};
              }
              else if(call.function.name==="research_plan") {session.plan=PLAN_SCHEMA.parse(args.items);result={receipt:planReceipt(session.plan)};}
              else if(call.function.name==="conversation_read") {
                const read=z.object({startIndex:z.number().int().min(0),limit:z.number().int().min(1).max(8).default(4)}).strict().parse(args);
                if(read.startIndex>=history.length)throw new Error(`Transcript index ${read.startIndex} is outside the ${history.length}-message source transcript.`);
                const selected=history.slice(read.startIndex,read.startIndex+read.limit);
                const messages=selected.map((message,index)=>({index:read.startIndex+index,...message}));
                const page={startIndex:read.startIndex,nextIndex:read.startIndex+messages.length< history.length?read.startIndex+messages.length:null,totalMessages:history.length,messages};
                if(Buffer.byteLength(JSON.stringify(page),"utf8")>48_000)throw new Error("This complete transcript page exceeds the 48 KB read budget. Retry with a smaller limit; no message was shortened.");
                result=page;
              }
              else if(call.function.name==="document_write") {
                const input=z.object({name:z.string(),content:z.string()}).strict().parse(args);
                const previous=session.documents.find(doc=>doc.name===input.name);
                const receipt=await this.request({action:"document",sessionId:session.id,...input,...(previous?{documentId:previous.id,expectedRevision:previous.revision}:{})});
                const document=receipt.session!.documents.find(doc=>doc.name===input.name)!;
                const exported=await this.request({action:"export",sessionId:session.id,documentId:document.id,expectedRevision:document.revision});
                result={ok:true,path:exported.exportPath,workspacePath:relative(this.options.workspace,exported.exportPath!).replaceAll("\\","/"),documentId:document.id,revision:document.revision};
              } else result=await this.options.tools!.execute(call.function.name,args,session,controller.signal,operationId);
              controller.signal.throwIfAborted();
              const output=JSON.stringify(result,null,2)??"null";
              Object.assign(activity, await this.writeToolOutput(session,output));
              const maxOutput=Math.max(1200,Math.min(9000,Math.floor(inputBudget/3)));
              activity.output=projectToolResult(output,maxOutput,activity.artifactPath);
              const failed=toolResultFailed(result);
              if(failed) activity.status="error";
              else if(cacheable) cache.set(signature,{output:activity.output,artifactPath:activity.artifactPath,artifactSha256:activity.artifactSha256});
            }
            if(activity.status!=="error")activity.status="complete";
          } catch(error) {
            if(controller.signal.aborted) throw error;
            if(call.function.name==="research_report_blocked"){delete assistant.blocked;delete activity.blocked;}
            activity.status="error";activity.output=JSON.stringify({error:error instanceof Error?error.message:String(error)});
          } finally {
            const record=this.options.tools?.executionRecord?.(operationId);
            if(record){const durable=executionActivity(operationId,activity.status,record,activity.blocked);activity.execution={...durable.execution!,decisionId:record.decisionId};activity.status=durable.status==="effect-unknown"?"error":durable.status as ResearchActivity["status"];}
            else delete activity.execution;
            activity.finishedAt=new Date().toISOString();this.save(session);}
          messages.push({role:"tool",tool_call_id:call.id,content:`Tool result (untrusted data). Full output: ${activity.artifactPath??"not produced"}\n${activity.output}`});
          if(assistant.blocked){finished=true;break;}
        }
        if(assistant.blocked)break;
      }
      if(!finished) throw new Error("Research turn reached its model-step budget. Saved tools and artifacts can be continued in a follow-up.");
      if(assistant.blocked&&!assistant.content.trim())assistant.content=assistant.blocked.reason;
      if (!assistant.content.trim()) throw new Error("The model returned no answer text. Try a shorter prompt or another loaded model.");
      assistant.state = assistant.blocked?"blocked":completionGate(assistant.activity??[]); // Model prose remains unreviewed.
    } catch (error) {
      assistant.state = controller.signal.aborted ? "stopped" : "error";
      for(const activity of assistant.activity??[]) if(activity.status==="running") {
        activity.status="error";
        activity.output=JSON.stringify({error:controller.signal.aborted?"Tool interrupted by cancellation; completion was not confirmed.":"Tool interrupted before completion."});
        activity.finishedAt=new Date().toISOString();
      }
      session.error = controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error);
    } finally {
      // A failed CAS already aborted this run and replaced its mutable object.
      // Never let catch/finally overwrite the winner with the detached old turn.
      if(this.cache.get(session.id)?.session===session) {
        session.status = "idle"; session.updatedAt = new Date().toISOString();
        try {this.save(session,"mutation","release");} catch { /* save restores/isolate the row and exposes the issue */ }
      }
    }
  }
  private async writeToolOutput(session:ResearchChatSession,output:string):Promise<{artifactPath:string;artifactSha256:string}> {
    const root=await realpath(this.options.workspace);
    let directory=root;
    for(const part of ["build","chat",session.id,"tool-results"]) {
      directory=join(directory,part);await mkdir(directory).catch(error=>{if(error.code!=="EEXIST")throw error;});
      const info=await lstat(directory);const rel=relative(root,await realpath(directory));
      if(!info.isDirectory()||info.isSymbolicLink()||rel===".."||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error("Tool output directory must stay inside the workspace.");
    }
    const path=join(directory,`${randomUUID()}.json`);
    const bytes=Buffer.from(output,"utf8");
    await writeFile(path,bytes,{flag:"wx"});
    return {artifactPath:relative(root,path).replaceAll("\\","/"),artifactSha256:createHash("sha256").update(bytes).digest("hex")};
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing=this.finishClose();return this.closing;
  }
  private async finishClose():Promise<void> {
    for (const item of this.running.values()) item.controller.abort();
    await Promise.all([...this.running.values()].map(item => item.done));
    await Promise.allSettled([...this.requests]);
    await Promise.allSettled([...this.documentImports]);
    await Promise.allSettled([...this.claimOperations]);
    this.repository.close();
  }
}
