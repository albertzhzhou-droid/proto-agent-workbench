import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath, guardDatabase } from "./compute-studies.ts";
import { ToolExecutionJournal, type ToolExecutionIdentity } from "./tool-execution-journal.ts";
import { applySchemaMigrations } from "./schema-migrations.ts";
import { validateReconciliationEvidence } from "./reconciliation-evidence.ts";

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(message:string):never=>{throw Object.assign(new Error(message),{code:'WORKSPACE_JOURNAL_UNAVAILABLE',effectState:'unknown'});};
const hasTable=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Select only identities bound by matching execution and attempt projections.
 * Unmatched historical identities remain blocked; they never become fresh intents. */
function historicalWorkflowOperations(root:string):Map<string,boolean> {
  const result=new Map<string,boolean>(),path=join(root,'build','compute-studies','studies.sqlite');
  if(!existsSync(path))return result;
  guardDatabase(root,path);const db=new DatabaseSync(path,{readOnly:true});
  try {
    if(!hasTable(db,'research_workflow_attempts'))return result;
    const count=(db.prepare('SELECT count(*) n FROM research_workflow_attempts').get() as {n:number}).n;
    if(count>20000)fail('Historical workflow operation migration exceeds its bounded scan; no historical tool was replayed.');
    const sizes=db.prepare(`SELECT max(length(CAST(a.payload AS BLOB))) attempt_max,max(length(CAST(e.payload AS BLOB))) execution_max,
      sum(length(CAST(a.payload AS BLOB))+coalesce(length(CAST(e.payload AS BLOB)),0)) total
      FROM research_workflow_attempts a LEFT JOIN research_workflow_executions e ON e.id=a.execution_id`).get() as {attempt_max:number;execution_max:number;total:number};
    if(sizes.attempt_max>2*1024*1024||sizes.execution_max>2*1024*1024||sizes.total>64*1024*1024)fail('Historical workflow evidence exceeds its bounded migration byte budget.');
    const rows=db.prepare(`SELECT a.id,a.execution_id,a.step_id,a.payload,length(CAST(a.payload AS BLOB)) bytes,
      e.payload execution_payload,e.id execution_id_checked,e.workflow_id,e.study_id,e.workflow_revision,
      length(CAST(e.payload AS BLOB)) execution_bytes
      FROM research_workflow_attempts a LEFT JOIN research_workflow_executions e ON e.id=a.execution_id`).all() as Array<Record<string,unknown>>;
    for(const row of rows){
      if(uuid(row.id))result.set(row.id,false);
      if(Number(row.bytes)>2*1024*1024||Number(row.execution_bytes)>2*1024*1024)fail('Historical workflow evidence exceeds its loading bound.');
      let attempt:Record<string,unknown>,execution:Record<string,unknown>;
      try{attempt=JSON.parse(String(row.payload));execution=JSON.parse(String(row.execution_payload));}catch{continue;}
      if(uuid(attempt.operationId))result.set(attempt.operationId,false);
      if(execution.id!==row.execution_id_checked||execution.id!==row.execution_id||execution.workflowId!==row.workflow_id||execution.studyId!==row.study_id||execution.workflowRevision!==row.workflow_revision||!Array.isArray(execution.steps))continue;
      const step=execution.steps.find((value:Record<string,unknown>)=>value.stepId===row.step_id);
      if(!step||JSON.stringify(step)!==JSON.stringify(attempt))continue;
      if(uuid(row.id))result.set(row.id,true);
      if(uuid(attempt.operationId))result.set(attempt.operationId,true);
    }
    return result;
  }finally{db.close();}
}

class WorkspaceToolExecutionJournal extends ToolExecutionJournal {
  private readonly beforeBegin:(identity:ToolExecutionIdentity)=>void;
  private readonly workspace:string;
  constructor(db:DatabaseSync,workspace:string,beforeBegin:(identity:ToolExecutionIdentity)=>void){super(db);this.workspace=workspace;this.beforeBegin=beforeBegin;}
  override begin(identity:ToolExecutionIdentity){this.beforeBegin(identity);return super.begin(identity);}
  override reconcile(operationId:string,verdict:"applied"|"not-applied",actor:string,evidenceRef:string){
    return super.reconcile(operationId,verdict,actor,validateReconciliationEvidence(this.workspace,evidenceRef));
  }
}

/** The journal and a binding marker travel with the workspace. Removing just the
 * database cannot reset operation identities. Legacy imports require workspace
 * evidence and retain their exact original row separately for review. */
export function openWorkspaceExecutionJournal(workspace:string,options:{legacyDb?:DatabaseSync}={}) {
  const root=realpathSync(workspace),path=join(root,'build','.proto','execution.sqlite'),marker=join(root,'build','.proto','execution-journal-binding.json');
  const existed=existsSync(path);
  if(!existed&&existsSync(marker))fail('The workspace journal database is missing but its binding remains. Restore the matching journal before executing tools.');
  databasePath(root,'build/.proto/execution.sqlite');
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    const migrationReport=applySchemaMigrations(db,'workspace-journal',[{version:1,sql:`
      CREATE TABLE IF NOT EXISTS workspace_journal_binding(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_journal_legacy_operations(operation_id TEXT PRIMARY KEY,status TEXT NOT NULL,original_row TEXT,reason TEXT NOT NULL);`}]);
    const initial=lstatSync(path);
    let binding=db.prepare('SELECT id FROM workspace_journal_binding').get() as {id:string}|undefined;
    if(binding&&!existsSync(marker))fail('The workspace journal binding marker is missing; restore its matching marker before executing tools.');
    if(existsSync(marker)){
      const stat=lstatSync(marker);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>2048||realpathSync(marker)!==marker)fail('Workspace journal marker is not a bounded regular file.');
      let saved:{journalId?:unknown};try{saved=JSON.parse(readFileSync(marker,'utf8'));}catch{return fail('Workspace journal marker is malformed.');}
      if(!binding||saved.journalId!==binding.id)fail('Workspace journal identity differs from its retained binding. Restore the matching journal; no operation was replayed.');
    }
    const journal=new WorkspaceToolExecutionJournal(db,root,identity=>{
      guardDatabase(root,path);const current=lstatSync(path);
      if(current.dev!==initial.dev||current.ino!==initial.ino)fail('Workspace journal file identity changed during execution.');
      const retained=db.prepare('SELECT status,reason FROM workspace_journal_legacy_operations WHERE operation_id=?').get(identity.operationId) as {status:string;reason:string}|undefined;
      if(retained?.status==='blocked')fail(retained.reason);
    });
    if(!binding){
      const operations=historicalWorkflowOperations(root);
      const legacy=options.legacyDb;
      const legacyColumns=legacy&&hasTable(legacy,'tool_execution_journal')?(legacy.prepare('PRAGMA table_info(tool_execution_journal)').all() as Array<{name:string}>).map(row=>row.name):[];
      db.exec('BEGIN IMMEDIATE');
      try {
        for(const [operationId,verified] of operations){
          const row=legacyColumns.length?legacy!.prepare('SELECT * FROM tool_execution_journal WHERE operation_id=?').get(operationId) as Record<string,unknown>|undefined:undefined;
          const expectedArgs=sha(JSON.stringify({path:`build/compute-inputs/${operationId}.json`}));
          const eligible=verified&&row&&row.tool==='proto_compute_run'&&row.effect==='write'&&row.arguments_sha256===expectedArgs&&row.run_id===operationId;
          if(eligible){
            const columns=(db.prepare('PRAGMA table_info(tool_execution_journal)').all() as Array<{name:string}>).map(item=>item.name);
            const copied={...row,scope_surface:'workflow',parent_operation_id:null};
            db.prepare(`INSERT INTO tool_execution_journal(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(name=>(copied as Record<string,unknown>)[name]??null) as Parameters<ReturnType<DatabaseSync['prepare']>['run']>);
            if(hasTable(legacy!,'tool_execution_reconciliations')){
              const audits=legacy!.prepare('SELECT * FROM tool_execution_reconciliations WHERE operation_id=?').all(operationId) as Array<Record<string,string>>;
              for(const audit of audits)db.prepare('INSERT INTO tool_execution_reconciliations(id,operation_id,verdict,actor,evidence_ref,reconciled_at) VALUES(?,?,?,?,?,?)').run(audit.id,audit.operation_id,audit.verdict,audit.actor,audit.evidence_ref,audit.reconciled_at);
            }
          }
          db.prepare('INSERT INTO workspace_journal_legacy_operations VALUES(?,?,?,?)').run(operationId,eligible?'imported':'blocked',row?JSON.stringify(row):null,eligible?'Workspace-bound legacy journal row retained and imported.':'Historical workspace operation has no matching verifiable journal row. Its effect is unknown; automatic redispatch is blocked.');
        }
        binding={id:randomUUID()};db.prepare('INSERT INTO workspace_journal_binding VALUES(?,?)').run(binding.id,new Date().toISOString());
        writeFileSync(marker,JSON.stringify({schemaVersion:'proto-workbench.workspace-journal-binding.v1',journalId:binding.id},null,2),{flag:'wx',mode:0o600,flush:true});
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    return {journal,db,path,migrationReport,migrationReports:[migrationReport,journal.migrationReport],close:()=>db.close()};
  }catch(error){db.close();throw error;}
}
