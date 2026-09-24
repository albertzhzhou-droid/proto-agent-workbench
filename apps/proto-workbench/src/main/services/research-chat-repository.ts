import { applySchemaMigrations, type SchemaMigrationReport } from "./schema-migrations.ts";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { ResearchChatRecoveryIssue, ResearchChatSession, ResearchChatSummary, ResearchExecutionState, ResearchMessage, ResearchMessagePage } from "../../shared/research-chat.ts";
import { decodeResearchSession, ResearchSessionStateError, type VersionedResearchChatSession } from "../../shared/research-session-state.ts";

export const RESEARCH_STORAGE_LIMITS = {
  payloadBytes: 8 * 1024 * 1024, indexBatch: 30, indexBytes: 8 * 1024 * 1024,
  cacheEntries: 12, cacheBytes: 32 * 1024 * 1024, pinnedEntries: 16, pinnedBytes: 64 * 1024 * 1024,
} as const;
export const RESEARCH_MESSAGE_PAGE_SIZE = 40;
export type ResearchStorageLimits = { [K in keyof typeof RESEARCH_STORAGE_LIMITS]: number };
const processNonce = randomUUID();
const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
type Header = { id: string; updated_at: string; bytes: number };
export type LoadedResearchSession = { session: VersionedResearchChatSession; raw: string; migrated: boolean };
type Owner = { owner_id: string; pid: number; host: string; process_nonce: string; state: string;finished:number };
function unfinished(session: ResearchChatSession): boolean {
  return session.status === "generating" || session.messages.some(message => message.state === "streaming" || message.activity?.some(activity => activity.status === "running"));
}
export class ResearchStorageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Canonical JSON is retained. This index contains only bounded navigation metadata. */
export class ResearchChatRepository {
  readonly db: DatabaseSync;
  readonly migrationReport: SchemaMigrationReport;
  readonly ownerId = randomUUID();
  readonly limits: ResearchStorageLimits;
  private workspace: string;
  private streamBases = new Map<string,{raw:string;sha:string;revision:number}>();
  constructor(path: string, workspace: string, limits: Partial<ResearchStorageLimits> = {}) {
    this.workspace = workspace; this.limits = { ...RESEARCH_STORAGE_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Research storage limits must be positive integers.");
    if(this.limits.indexBytes<this.limits.payloadBytes)throw new Error("The indexing byte budget must admit one permitted complete session.");
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path);
    try {
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.migrationReport=applySchemaMigrations(this.db,"research-chat",[{version:1,sql:`
      CREATE TABLE IF NOT EXISTS research_chats(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS research_chats_workspace_order ON research_chats(workspace,updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS research_chat_messages(
        session_id TEXT NOT NULL,workspace TEXT NOT NULL,ordinal INTEGER NOT NULL,message_id TEXT NOT NULL,
        payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL,PRIMARY KEY(session_id,ordinal));
      CREATE INDEX IF NOT EXISTS research_chat_messages_identity ON research_chat_messages(session_id,message_id);
      CREATE TABLE IF NOT EXISTS research_chat_transcripts(
        session_id TEXT PRIMARY KEY,workspace TEXT NOT NULL,revision INTEGER NOT NULL,total_messages INTEGER NOT NULL,transcript_sha256 TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS research_chat_generations(workspace TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS research_chat_summaries(
        id TEXT PRIMARY KEY,workspace TEXT NOT NULL,updated_at TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 1,
        valid INTEGER NOT NULL DEFAULT 0,index_version INTEGER NOT NULL DEFAULT 1,title TEXT,status TEXT,model_id TEXT,
        claim_total INTEGER NOT NULL DEFAULT 0,claim_reviewed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS research_chat_summary_order ON research_chat_summaries(workspace,dirty,valid,updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS research_chat_recovery_issues(
        workspace TEXT NOT NULL,session_id TEXT NOT NULL,code TEXT NOT NULL,message TEXT NOT NULL,disposition TEXT NOT NULL,
        PRIMARY KEY(workspace,session_id,code));
      CREATE TABLE IF NOT EXISTS research_chat_owners(
        owner_id TEXT PRIMARY KEY,pid INTEGER NOT NULL,host TEXT NOT NULL,process_nonce TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_chat_runs(session_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,acquired_at TEXT NOT NULL,finished INTEGER NOT NULL DEFAULT 0);
      CREATE TRIGGER IF NOT EXISTS research_chat_insert_index AFTER INSERT ON research_chats BEGIN
        INSERT INTO research_chat_summaries(id,workspace,updated_at) VALUES(NEW.id,NEW.workspace,NEW.updated_at)
          ON CONFLICT(id) DO UPDATE SET workspace=NEW.workspace,updated_at=NEW.updated_at,dirty=1,valid=0;
        INSERT INTO research_chat_generations VALUES(NEW.workspace,1) ON CONFLICT(workspace) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS research_chat_update_index AFTER UPDATE OF payload,workspace,updated_at,id ON research_chats BEGIN
        DELETE FROM research_chat_summaries WHERE id=OLD.id;
        INSERT INTO research_chat_summaries(id,workspace,updated_at) VALUES(NEW.id,NEW.workspace,NEW.updated_at);
        INSERT INTO research_chat_generations VALUES(OLD.workspace,1) ON CONFLICT(workspace) DO UPDATE SET generation=generation+1;
        INSERT INTO research_chat_generations VALUES(NEW.workspace,1) ON CONFLICT(workspace) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS research_chat_transcript_dirty AFTER UPDATE OF payload,workspace ON research_chats BEGIN
        UPDATE research_chat_transcripts SET dirty=1 WHERE session_id=NEW.id AND workspace=NEW.workspace;
      END;
      CREATE TRIGGER IF NOT EXISTS research_chat_delete_index AFTER DELETE ON research_chats BEGIN
        DELETE FROM research_chat_summaries WHERE id=OLD.id;
        DELETE FROM research_chat_messages WHERE session_id=OLD.id AND workspace=OLD.workspace;
        DELETE FROM research_chat_transcripts WHERE session_id=OLD.id AND workspace=OLD.workspace;
        DELETE FROM research_chat_runs WHERE session_id=OLD.id;
        DELETE FROM research_chat_recovery_issues WHERE workspace=OLD.workspace AND session_id=OLD.id;
        INSERT INTO research_chat_generations VALUES(OLD.workspace,1) ON CONFLICT(workspace) DO UPDATE SET generation=generation+1;
      END;`,columns:[
      {table:"research_chat_runs",name:"finished",definition:"INTEGER NOT NULL DEFAULT 0"},
      {table:"research_chat_transcripts",name:"dirty",definition:"INTEGER NOT NULL DEFAULT 1"},
    ]},{version:2,sql:`CREATE TABLE IF NOT EXISTS research_chat_stream_buffer(
      session_id TEXT PRIMARY KEY,workspace TEXT NOT NULL,owner_id TEXT NOT NULL,message_id TEXT NOT NULL,
      base_sha256 TEXT NOT NULL,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS research_chat_delete_stream_buffer AFTER DELETE ON research_chats BEGIN
        DELETE FROM research_chat_stream_buffer WHERE session_id=OLD.id AND workspace=OLD.workspace;
      END;`}]);
    this.db.prepare("INSERT OR IGNORE INTO research_chat_generations VALUES(?,0)").run(workspace);
    this.db.prepare("INSERT INTO research_chat_owners VALUES(?,?,?,?,?,?)").run(this.ownerId, process.pid, hostname(), processNonce, "active", new Date().toISOString());
    }catch(error){this.db.close();throw error;}
  }
  issue(sessionId: string, code: string, message: string, disposition: ResearchChatRecoveryIssue["disposition"]): void {
    this.db.prepare("INSERT INTO research_chat_recovery_issues VALUES(?,?,?,?,?) ON CONFLICT(workspace,session_id,code) DO UPDATE SET message=excluded.message,disposition=excluded.disposition")
      .run(this.workspace, sessionId, code, message, disposition);
  }
  issues() {
    return {
      recoveryIssues: this.db.prepare("SELECT session_id AS sessionId,code,message,disposition FROM research_chat_recovery_issues WHERE workspace=? ORDER BY session_id,code LIMIT 50").all(this.workspace) as unknown as ResearchChatRecoveryIssue[],
      recoveryIssueCount: (this.db.prepare("SELECT COUNT(*) AS count FROM research_chat_recovery_issues WHERE workspace=?").get(this.workspace) as {count:number}).count,
    };
  }
  private header(id: string): Header | undefined {
    return this.db.prepare("SELECT id,updated_at,length(CAST(payload AS BLOB)) AS bytes FROM research_chats WHERE id=? AND workspace=?").get(id, this.workspace) as Header | undefined;
  }
  private digestTranscript(rows: Array<{ ordinal:number; message_id:string; payload_sha256:string }>): string {
    const hash=createHash("sha256");
    for(const row of rows)hash.update(`${row.ordinal}\0${row.message_id}\0${row.payload_sha256}\n`);
    return hash.digest("hex");
  }
  private transcriptRows(sessionId:string):Array<{ordinal:number;message_id:string;payload_sha256:string}> {
    return this.db.prepare("SELECT ordinal,message_id,payload_sha256 FROM research_chat_messages WHERE session_id=? AND workspace=? ORDER BY ordinal").all(sessionId,this.workspace) as Array<{ordinal:number;message_id:string;payload_sha256:string}>;
  }
  private syncTranscript(session:VersionedResearchChatSession):void {
    const previous=new Map(this.transcriptRows(session.id).map(row=>[row.ordinal,row]));
    const upsert=this.db.prepare(`INSERT INTO research_chat_messages(session_id,workspace,ordinal,message_id,payload,payload_sha256)
      VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,ordinal) DO UPDATE SET workspace=excluded.workspace,message_id=excluded.message_id,payload=excluded.payload,payload_sha256=excluded.payload_sha256`);
    const rows:Array<{ordinal:number;message_id:string;payload_sha256:string}>=[];
    for(let ordinal=0;ordinal<session.messages.length;ordinal++) {
      const message=session.messages[ordinal],payload=JSON.stringify(message),payloadSha256=createHash("sha256").update(payload,"utf8").digest("hex");
      const prior=previous.get(ordinal);
      if(!prior||prior.message_id!==message.id||prior.payload_sha256!==payloadSha256)upsert.run(session.id,this.workspace,ordinal,message.id,payload,payloadSha256);
      rows.push({ordinal,message_id:message.id,payload_sha256:payloadSha256});
    }
    this.db.prepare("DELETE FROM research_chat_messages WHERE session_id=? AND workspace=? AND ordinal>=?").run(session.id,this.workspace,session.messages.length);
    this.db.prepare(`INSERT INTO research_chat_transcripts(session_id,workspace,revision,total_messages,transcript_sha256,dirty) VALUES(?,?,?,?,?,0)
      ON CONFLICT(session_id) DO UPDATE SET workspace=excluded.workspace,revision=excluded.revision,total_messages=excluded.total_messages,transcript_sha256=excluded.transcript_sha256,dirty=0`)
      .run(session.id,this.workspace,session.revision,session.messages.length,this.digestTranscript(rows));
  }
  /** Durable partial output is separate from the authoritative transcript until a
   * normal session save or explicit recovery folds it into the canonical payload. */
  bufferStream(sessionId:string,message:ResearchMessage,expectedRaw:string):void {
    const payload=JSON.stringify(message);
    if(Buffer.byteLength(payload)>this.limits.payloadBytes)throw new ResearchStorageError("PAYLOAD_TOO_LARGE","Streaming message exceeds the storage bound; the last checkpoint was retained.");
    let base=this.streamBases.get(sessionId);
    if(!base||base.raw!==expectedRaw){
      const decoded=decodeResearchSession(expectedRaw);
      if(!decoded.ok||decoded.session.id!==sessionId)throw new ResearchStorageError("INVALID_STREAM_BASE","Stream checkpoint requires a valid canonical base.");
      base={raw:expectedRaw,sha:createHash("sha256").update(expectedRaw).digest("hex"),revision:decoded.session.revision};
      if(this.streamBases.size>=this.limits.pinnedEntries)this.streamBases.delete(this.streamBases.keys().next().value!);
      this.streamBases.set(sessionId,base);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner=this.owner(sessionId);
      if(!owner||owner.owner_id!==this.ownerId||owner.finished)throw new ResearchStorageError("EXECUTION_OWNERSHIP","Only the active execution owner can persist streaming output.");
      const transcript=this.db.prepare("SELECT revision,dirty FROM research_chat_transcripts WHERE session_id=? AND workspace=?").get(sessionId,this.workspace) as {revision:number;dirty:number}|undefined;
      if(!transcript||transcript.dirty||transcript.revision!==base.revision)throw new ResearchSessionStateError("REVISION_CONFLICT","Canonical transcript changed before streaming output was saved.");
      const original=this.db.prepare("SELECT payload FROM research_chat_messages WHERE session_id=? AND workspace=? AND message_id=? AND length(CAST(payload AS BLOB))<=?").get(sessionId,this.workspace,message.id,this.limits.payloadBytes) as {payload:string}|undefined;
      const identity=original?JSON.parse(original.payload) as ResearchMessage:undefined;
      if(!identity||identity.role!=="assistant"||message.role!=="assistant"||message.state!=="streaming"||message.createdAt!==identity.createdAt)throw new ResearchStorageError("INVALID_STREAM_MESSAGE","Streaming checkpoint does not match an existing assistant message.");
      this.db.prepare(`INSERT INTO research_chat_stream_buffer VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        workspace=excluded.workspace,owner_id=excluded.owner_id,message_id=excluded.message_id,base_sha256=excluded.base_sha256,
        payload=excluded.payload,payload_sha256=excluded.payload_sha256,updated_at=excluded.updated_at`)
        .run(sessionId,this.workspace,this.ownerId,message.id,base.sha,payload,createHash("sha256").update(payload).digest("hex"),new Date().toISOString());
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  readStreamBuffer(sessionId:string,expectedRaw:string):ResearchMessage|undefined {
    const header=this.db.prepare("SELECT length(CAST(payload AS BLOB)) bytes FROM research_chat_stream_buffer WHERE session_id=? AND workspace=?").get(sessionId,this.workspace) as {bytes:number}|undefined;
    if(!header)return undefined;
    if(header.bytes>this.limits.payloadBytes)throw new ResearchStorageError("STREAM_BUFFER_MISMATCH","Streaming checkpoint exceeds its loading bound; original evidence was retained.");
    const row=this.db.prepare("SELECT message_id,base_sha256,payload,payload_sha256 FROM research_chat_stream_buffer WHERE session_id=? AND workspace=? AND length(CAST(payload AS BLOB))<=?").get(sessionId,this.workspace,this.limits.payloadBytes) as {message_id:string;base_sha256:string;payload:string;payload_sha256:string}|undefined;
    if(!row)return undefined;
    if(row.base_sha256!==createHash("sha256").update(expectedRaw).digest("hex")||row.payload_sha256!==createHash("sha256").update(row.payload).digest("hex"))throw new ResearchStorageError("STREAM_BUFFER_MISMATCH","Streaming checkpoint does not match its canonical base or digest; original evidence was retained.");
    const base=decodeResearchSession(expectedRaw);
    if(!base.ok||base.session.id!==sessionId)throw new ResearchStorageError("INVALID_STREAM_BASE","Canonical stream base is unavailable.");
    let message:ResearchMessage;try{message=JSON.parse(row.payload);}catch{throw new ResearchStorageError("STREAM_BUFFER_MISMATCH","Streaming checkpoint is malformed; original evidence was retained.");}
    const index=base.session.messages.findIndex(item=>item.id===row.message_id);
    if(index<0||message.id!==row.message_id||message.role!=="assistant"||message.state!=="streaming"||base.session.messages[index].createdAt!==message.createdAt)throw new ResearchStorageError("STREAM_BUFFER_MISMATCH","Streaming checkpoint message identity does not match its canonical source.");
    base.session.messages[index]=message;
    if(!decodeResearchSession(JSON.stringify(base.session)).ok)throw new ResearchStorageError("STREAM_BUFFER_MISMATCH","Streaming checkpoint fails session validation; original evidence was retained.");
    return message;
  }
  messagePage(sessionId:string,cursor?:string,limit=RESEARCH_MESSAGE_PAGE_SIZE):ResearchMessagePage {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ResearchStorageError("INVALID_PAGE_SIZE","Transcript page size must be between 1 and 100 messages.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if(!this.header(sessionId))throw new ResearchStorageError("SESSION_UNAVAILABLE","Conversation does not belong to the current workspace.");
      let manifest=this.db.prepare("SELECT revision,total_messages AS totalMessages,transcript_sha256 AS transcriptSha256,dirty FROM research_chat_transcripts WHERE session_id=? AND workspace=?").get(sessionId,this.workspace) as {revision:number;totalMessages:number;transcriptSha256:string;dirty:number}|undefined;
      // Existing versioned payloads are the migration source. Materialize only
      // after the complete payload passes the same decoder used by normal reads.
      if(!manifest||manifest.dirty) {
        const loaded=this.read(sessionId);
        if(!loaded) {
          const issue=this.db.prepare("SELECT code,message FROM research_chat_recovery_issues WHERE workspace=? AND session_id=? ORDER BY code LIMIT 1").get(this.workspace,sessionId) as {code:string;message:string}|undefined;
          throw new ResearchStorageError(issue?.code??"SESSION_UNAVAILABLE",issue?.message??"The retained conversation cannot be safely paged. Its original row remains available for review.");
        }
        this.syncTranscript(loaded.session);
        manifest=this.db.prepare("SELECT revision,total_messages AS totalMessages,transcript_sha256 AS transcriptSha256,dirty FROM research_chat_transcripts WHERE session_id=? AND workspace=?").get(sessionId,this.workspace) as typeof manifest;
      }
      if(!manifest||manifest.dirty)throw new ResearchStorageError("TRANSCRIPT_INDEX_MISMATCH","Transcript projection could not be materialized; the original conversation was retained.");
      const identityRows=this.transcriptRows(sessionId);
      const sequential=identityRows.every((row,index)=>row.ordinal===index);
      const digest=this.digestTranscript(identityRows);
      if(!sequential||identityRows.length!==manifest.totalMessages||digest!==manifest.transcriptSha256) {
        this.issue(sessionId,"TRANSCRIPT_INDEX_MISMATCH","Normalized transcript rows do not match their atomic manifest. Original conversation payload and projection were retained.","retained-unopened");
        throw new ResearchStorageError("TRANSCRIPT_INDEX_MISMATCH","Transcript paging stopped because its integrity manifest does not match the stored rows. The original conversation was retained.");
      }
      let before=manifest.totalMessages;
      if(cursor) {
        let after:unknown;
        try {if(cursor.length>2048)throw new Error();after=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));}catch {throw new ResearchStorageError("INVALID_CURSOR","Transcript cursor is invalid. Refresh the conversation.");}
        const value=after as {workspace?:unknown;sessionId?:unknown;before?:unknown;limit?:unknown;prefixSha256?:unknown;order?:unknown};
        const workspaceHash=createHash("sha256").update(this.workspace).digest("hex");
        if(!value||value.workspace!==workspaceHash||value.sessionId!==sessionId||value.limit!==limit||value.order!=="ordinal-asc-before"
            ||!Number.isSafeInteger(value.before)||Number(value.before)<0||Number(value.before)>manifest.totalMessages
            ||typeof value.prefixSha256!=="string"||!/^[0-9a-f]{64}$/.test(value.prefixSha256))
          throw new ResearchStorageError("INVALID_CURSOR","Transcript cursor does not belong to this workspace, conversation, page size or ordering.");
        before=Number(value.before);
        if(this.digestTranscript(identityRows.slice(0,before))!==value.prefixSha256) {
          const latest=this.readMessagePage(sessionId,manifest,identityRows,manifest.totalMessages,limit,true);
          this.db.exec("COMMIT");return latest;
        }
      }
      const page=this.readMessagePage(sessionId,manifest,identityRows,before,limit,false);
      this.db.exec("COMMIT");return page;
    } catch(error) {
      this.db.exec("ROLLBACK");
      if(error instanceof ResearchStorageError&&(error.code.startsWith("TRANSCRIPT_")||["MALFORMED_JSON","INVALID_SESSION","UNSUPPORTED_SCHEMA","INVALID_REVISION","INVALID_RESEARCH_STATE","INVALID_STATE_SOURCE","PAYLOAD_TOO_LARGE","SESSION_ID_MISMATCH"].includes(error.code)))this.issue(sessionId,error.code,error.message,"retained-unopened");
      throw error;
    }
  }
  private readMessagePage(
    sessionId:string,manifest:{revision:number;totalMessages:number;transcriptSha256:string},
    identityRows:Array<{ordinal:number;message_id:string;payload_sha256:string}>,before:number,limit:number,resetRequired:boolean,
  ):ResearchMessagePage {
    const end=resetRequired?manifest.totalMessages:before,start=Math.max(0,end-limit);
    const rows=this.db.prepare(`SELECT ordinal,message_id,payload,payload_sha256 FROM research_chat_messages
      WHERE session_id=? AND workspace=? AND ordinal>=? AND ordinal<? ORDER BY ordinal`).all(sessionId,this.workspace,start,end) as Array<{ordinal:number;message_id:string;payload:string;payload_sha256:string}>;
    const messages:ResearchMessage[]=[];
    for(let offset=0;offset<rows.length;offset++) {
      const row=rows[offset];
      if(row.ordinal!==start+offset||createHash("sha256").update(row.payload,"utf8").digest("hex")!==row.payload_sha256) {
        this.issue(sessionId,"TRANSCRIPT_MESSAGE_HASH_MISMATCH","A paged transcript message failed its stored digest. Original conversation payload and message projection were retained.","retained-unopened");
        throw new ResearchStorageError("TRANSCRIPT_MESSAGE_HASH_MISMATCH","Transcript page contains a message that failed its stored digest. The original conversation was retained.");
      }
      let value:unknown;try{value=JSON.parse(row.payload);}catch {value=undefined;}
      if(!value||typeof value!=="object"||(value as {id?:unknown}).id!==row.message_id) {
        this.issue(sessionId,"TRANSCRIPT_MESSAGE_INVALID","A paged transcript message is invalid. Original conversation payload and message projection were retained.","retained-unopened");
        throw new ResearchStorageError("TRANSCRIPT_MESSAGE_INVALID","Transcript page contains an invalid message. The original conversation was retained.");
      }
      messages.push(value as ResearchMessage);
    }
    const nextBefore=start;
    const nextCursor=nextBefore>0?Buffer.from(JSON.stringify({workspace:createHash("sha256").update(this.workspace).digest("hex"),sessionId,before:nextBefore,limit,prefixSha256:this.digestTranscript(identityRows.slice(0,nextBefore)),order:"ordinal-asc-before"})).toString("base64url"):null;
    return {sessionId,revision:manifest.revision,totalMessages:manifest.totalMessages,startIndex:start,transcriptSha256:manifest.transcriptSha256,nextCursor,messages,...(resetRequired?{resetRequired:true}:{})};
  }
  private rejectRow(row: Header, code: string, message: string): undefined {
    this.issue(row.id, code, message, "retained-unopened"); return undefined;
  }
  read(id: string): LoadedResearchSession | undefined {
    const row = this.header(id); if (!row) return undefined;
    if (!uuid(id)) return this.rejectRow(row, "INVALID_SESSION_ID", "Stored conversation ID is not an addressable UUID. Original payload retained.");
    if (row.bytes > this.limits.payloadBytes) return this.rejectRow(row, "PAYLOAD_TOO_LARGE", `Session exceeds the ${this.limits.payloadBytes}-byte loading bound. Original payload retained without decoding or truncation.`);
    const value = this.db.prepare("SELECT payload FROM research_chats WHERE id=? AND workspace=? AND length(CAST(payload AS BLOB))<=?").get(id, this.workspace, this.limits.payloadBytes) as {payload:string}|undefined;
    if (!value) return undefined;
    const decoded = decodeResearchSession(value.payload);
    if (!decoded.ok || decoded.session.id !== id) return this.rejectRow(row, decoded.ok ? "SESSION_ID_MISMATCH" : decoded.code, decoded.ok ? "Stored row identity differs from its session payload. Original payload retained." : decoded.diagnostic);
    // Source and execution projections are disposable, never persisted authority.
    delete decoded.session.execution;
    return { session: decoded.session, raw: value.payload, migrated: decoded.migrated };
  }
  matches(id:string,raw:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM research_chats WHERE id=? AND workspace=? AND payload=?").get(id,this.workspace,raw);
  }
  private index(session: VersionedResearchChatSession): void {
    const claims = session.claims ?? [], reviewed = claims.filter(claim => claim.review.state === "reviewed").length;
    this.db.prepare(`INSERT INTO research_chat_summaries(id,workspace,updated_at,dirty,valid,index_version,title,status,model_id,claim_total,claim_reviewed)
      VALUES(?,?,?,0,1,1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,updated_at=excluded.updated_at,
      dirty=0,valid=1,index_version=1,title=excluded.title,status=excluded.status,model_id=excluded.model_id,claim_total=excluded.claim_total,claim_reviewed=excluded.claim_reviewed`)
      .run(session.id, this.workspace, new Date(session.updatedAt).toISOString(), session.title.slice(0, 120), session.status, session.modelId?.slice(0, 1024) ?? null, claims.length, reviewed);
  }
  indexBatch(): number {
    const rows = this.db.prepare(`SELECT c.id,c.updated_at,length(CAST(c.payload AS BLOB)) AS bytes FROM research_chats c
      LEFT JOIN research_chat_summaries i ON i.id=c.id WHERE c.workspace=? AND (i.id IS NULL OR i.dirty=1 OR i.index_version<>1)
      ORDER BY c.updated_at DESC,c.id DESC LIMIT ?`).all(this.workspace, this.limits.indexBatch) as Header[];
    let bytes = 0, processed = 0;
    for (const row of rows) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Recheck bytes inside the transaction: an older writer may have grown
        // this row since the bounded candidate query. Never decode by old size.
        const fresh=this.header(row.id);
        if(!fresh){this.db.exec("COMMIT");continue;}
        if(fresh.bytes<=this.limits.payloadBytes&&bytes+fresh.bytes>this.limits.indexBytes){this.db.exec("COMMIT");break;}
        const loaded = this.read(row.id);
        if (loaded) this.index(loaded.session);
        else this.db.prepare(`INSERT INTO research_chat_summaries(id,workspace,updated_at,dirty,valid) VALUES(?,?,?,0,0)
          ON CONFLICT(id) DO UPDATE SET dirty=0,valid=0,index_version=1`).run(row.id, this.workspace, row.updated_at);
        this.db.prepare("UPDATE research_chat_generations SET generation=generation+1 WHERE workspace=?").run(this.workspace);
        this.db.exec("COMMIT");
        if(fresh.bytes<=this.limits.payloadBytes)bytes+=fresh.bytes;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      processed++;
    }
    return processed;
  }
  list(limit = 30, cursor?: string) {
    this.indexBatch();
    this.db.exec("BEGIN");
    try {
    const generation = String((this.db.prepare("SELECT generation FROM research_chat_generations WHERE workspace=?").get(this.workspace) as {generation:number}).generation);
    const indexingPending = (this.db.prepare(`SELECT COUNT(*) AS count FROM research_chats c LEFT JOIN research_chat_summaries i ON i.id=c.id
      WHERE c.workspace=? AND (i.id IS NULL OR i.dirty=1 OR i.index_version<>1)`).get(this.workspace) as {count:number}).count;
    let after: { workspace:string;generation:string;updatedAt:string;id:string;limit:number;order:string } | undefined;
    if (cursor) {
      try { after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new ResearchStorageError("INVALID_CURSOR", "Conversation cursor is invalid. Refresh the list."); }
      const workspace = createHash("sha256").update(this.workspace).digest("hex");
      if (!after || after.workspace !== workspace || typeof after.generation !== "string" || typeof after.updatedAt !== "string" || !uuid(after.id) || after.limit!==limit || after.order!=="updated-desc-id-desc") throw new ResearchStorageError("INVALID_CURSOR", "Conversation cursor does not belong to this workspace, page size or ordering, or is malformed.");
      if (after.generation !== generation) return { sessions: [], sessionPage: { nextCursor: null, generation, indexingPending, resetRequired: true }, ...this.issues() };
    }
    const columns = "id,title,updated_at AS updatedAt,status,model_id AS modelId,claim_total,claim_reviewed";
    const base = `SELECT ${columns} FROM research_chat_summaries WHERE workspace=? AND dirty=0 AND valid=1 AND index_version=1`;
    const rows = (after ? this.db.prepare(`${base} AND (updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT ?`).all(this.workspace, after.updatedAt, after.updatedAt, after.id, limit + 1)
      : this.db.prepare(`${base} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(this.workspace, limit + 1)) as {id:string;title:string;updatedAt:string;status:"idle"|"generating";modelId:string|null;claim_total:number;claim_reviewed:number}[];
    const more = rows.length > limit; const selected = rows.slice(0, limit), last = selected.at(-1);
    const sessions: ResearchChatSummary[] = selected.map(({ claim_total, claim_reviewed, modelId, ...summary }) => ({ ...summary, ...(modelId ? {modelId} : {}),
      ...(claim_total ? { claimReviewSummary: { total: claim_total, reviewed: claim_reviewed, unreviewed: claim_total - claim_reviewed, sourceChecks: "pending" as const } } : {}) }));
    const nextCursor = more && last ? Buffer.from(JSON.stringify({ workspace: createHash("sha256").update(this.workspace).digest("hex"), generation, updatedAt:last.updatedAt, id:last.id,limit,order:"updated-desc-id-desc" })).toString("base64url") : null;
    return { sessions, sessionPage: { nextCursor, generation, indexingPending }, ...this.issues() };
    } finally { this.db.exec("COMMIT"); }
  }
  private owner(sessionId: string): Owner | undefined {
    return this.db.prepare("SELECT r.owner_id,o.pid,o.host,o.process_nonce,o.state,r.finished FROM research_chat_runs r LEFT JOIN research_chat_owners o ON o.owner_id=r.owner_id WHERE r.session_id=?").get(sessionId) as Owner | undefined;
  }
  ownedRunId(sessionId:string):string {
    const row=this.db.prepare("SELECT run_id FROM research_chat_runs WHERE session_id=? AND owner_id=? AND finished=0").get(sessionId,this.ownerId) as {run_id:string}|undefined;
    if(!row)throw new ResearchStorageError("EXECUTION_OWNERSHIP","Execution ownership was lost before startup.");return row.run_id;
  }
  finishOwnRun(sessionId:string,runId:string):void {
    this.db.prepare("UPDATE research_chat_runs SET finished=1 WHERE session_id=? AND owner_id=? AND run_id=?").run(sessionId,this.ownerId,runId);
  }
  execution(session: ResearchChatSession): ResearchExecutionState {
    const owner = this.owner(session.id);
    if (!owner && !unfinished(session)) return { status:"none", canCancel:false, canRecover:false, reason:"No unfinished execution is recorded." };
    if (!owner) return { status:"owner-unknown", canCancel:false, canRecover:true, reason:"This legacy unfinished record has no execution owner. Recovery requires explicit confirmation that no other process is executing it; no tool is replayed." };
    if(!["active","closed"].includes(owner.state)||!Number.isSafeInteger(owner.pid)||owner.pid<=0)return {status:"owner-unknown",canCancel:false,canRecover:false,reason:"Recorded execution ownership is incomplete. No owner death or safe recovery can be established."};
    if(owner.finished)return {status:"recoverable",canCancel:false,canRecover:true,reason:"The recorded execution has stopped, but its final session update did not complete. Explicit recovery may preserve it as interrupted without replaying tools."};
    if (owner.owner_id === this.ownerId) return { status:"owned", canCancel:true, canRecover:false, reason:"This service owns the recorded execution." };
    if (owner.state === "closed") return { status:"recoverable", canCancel:false, canRecover:true, reason:"The recorded owner closed. Explicit recovery may mark unfinished work interrupted without replaying tools." };
    if (owner.host !== hostname()) return { status:"owner-unknown", canCancel:false, canRecover:false, reason:"The recorded owner is on another host; its absence cannot be proved here." };
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { status:"recoverable", canCancel:false, canRecover:true, reason:"The recorded owner process no longer exists. Explicit recovery does not replay tools." };
      return { status:"owner-unknown", canCancel:false, canRecover:false, reason:"The owner's process status is unknown; recovery is disabled." };
    }
    return { status:"live-elsewhere", canCancel:false, canRecover:false, reason:"Another service's recorded owner process is still live. Only that owner can cancel it." };
  }
  write(session: VersionedResearchChatSession, raw: string, expected?: string, mode: "normal"|"acquire"|"release"|"recover" = "normal", confirmUnowned = false): void {
    if (Buffer.byteLength(raw) > this.limits.payloadBytes) throw new ResearchStorageError("PAYLOAD_TOO_LARGE", "This update exceeds the complete-session byte bound. The previously saved transcript was retained; nothing was truncated.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.owner(session.id);
      if (mode === "recover") {
        const current = this.read(session.id); if (!current) throw new ResearchStorageError("SESSION_UNAVAILABLE", "The original session cannot be safely reopened.");
        const state = this.execution(current.session);
        if (!state.canRecover || (state.status === "owner-unknown" && !confirmUnowned)) throw new ResearchStorageError("EXECUTION_OWNERSHIP", state.reason);
      } else if (owner && (mode === "acquire" || owner.owner_id !== this.ownerId)) throw new ResearchStorageError("EXECUTION_OWNERSHIP", "Another recorded execution owns this conversation. Its state was not changed.");
      if (expected === undefined) this.db.prepare("INSERT INTO research_chats VALUES(?,?,?,?)").run(session.id,this.workspace,session.updatedAt,raw);
      else if (this.db.prepare("UPDATE research_chats SET updated_at=?,payload=? WHERE id=? AND workspace=? AND payload=?").run(session.updatedAt,raw,session.id,this.workspace,expected).changes !== 1)
        throw new ResearchSessionStateError("REVISION_CONFLICT", "Research session changed in another instance. Latest saved state was reloaded; retry after reviewing it.");
      if (mode === "acquire") this.db.prepare("INSERT INTO research_chat_runs(session_id,owner_id,run_id,acquired_at) VALUES(?,?,?,?)").run(session.id,this.ownerId,randomUUID(),new Date().toISOString());
      if (mode === "release" || mode === "recover") this.db.prepare("DELETE FROM research_chat_runs WHERE session_id=?").run(session.id);
      this.syncTranscript(session);
      this.index(session);
      this.db.prepare("DELETE FROM research_chat_stream_buffer WHERE session_id=? AND workspace=?").run(session.id,this.workspace);
      this.db.exec("COMMIT");
      this.streamBases.delete(session.id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void {
    this.db.prepare("UPDATE research_chat_owners SET state='closed' WHERE owner_id=?").run(this.ownerId);
    this.db.close();
  }
}

/** Raw and decoded forms share one eviction entry. Pinned work is never detached. */
export class ResearchSessionCache {
  private entries = new Map<string, { value: LoadedResearchSession; bytes:number; pins:number }>();
  private limits: ResearchStorageLimits;
  constructor(limits: ResearchStorageLimits) { this.limits = limits; }
  private size(value: LoadedResearchSession): number { return Buffer.byteLength(value.raw) + Buffer.byteLength(JSON.stringify(value.session)); }
  get(id: string): LoadedResearchSession | undefined {
    const entry = this.entries.get(id); if (!entry) return undefined;
    this.entries.delete(id); this.entries.set(id,entry); return entry.value;
  }
  set(id: string, value: LoadedResearchSession): void {
    this.checkAdmission(id,value);
    const previous = this.entries.get(id), bytes = this.size(value);
    if(previous){previous.value=value;previous.bytes=bytes;this.entries.delete(id);this.entries.set(id,previous);}
    else this.entries.set(id,{value,bytes,pins:0});
  }
  checkAdmission(id:string,value:LoadedResearchSession):void {
    const previous = this.entries.get(id), bytes = this.size(value);
    const pinnedBytes = [...this.entries.entries()].reduce((sum,[key,entry]) => sum + (entry.pins && key !== id ? entry.bytes : 0), 0);
    if (previous?.pins && pinnedBytes + bytes > this.limits.pinnedBytes) throw new ResearchStorageError("CACHE_ADMISSION", "Pinned conversations exceed the memory admission budget. Finish other work before retrying.");
  }
  isPinned(id:string):boolean {return !!this.entries.get(id)?.pins;}
  delete(id: string): void { this.entries.delete(id); }
  pin(id: string): ()=>void {
    const entry = this.entries.get(id); if (!entry) throw new Error("Cannot pin an unloaded session.");
    if (!entry.pins) {
      const pinned = [...this.entries.values()].filter(item=>item.pins);
      if (pinned.length >= this.limits.pinnedEntries || pinned.reduce((sum,item)=>sum+item.bytes,0)+entry.bytes>this.limits.pinnedBytes)
        throw new ResearchStorageError("CACHE_ADMISSION", "Too many conversations are active. Finish existing work before opening more.");
    }
    entry.pins++;
    return ()=> { const current=this.entries.get(id); if(current===entry)current.pins=Math.max(0,current.pins-1); this.trim(); };
  }
  trim(): void {
    let bytes = [...this.entries.values()].reduce((sum,item)=>sum+item.bytes,0);
    for (const [id,entry] of this.entries) {
      if(this.entries.size<=this.limits.cacheEntries&&bytes<=this.limits.cacheBytes)break;
      if(!entry.pins){this.entries.delete(id);bytes-=entry.bytes;}
    }
  }
  stats() { return {entries:this.entries.size,bytes:[...this.entries.values()].reduce((sum,item)=>sum+item.bytes,0),pinned:[...this.entries.values()].filter(item=>item.pins).length}; }
}
