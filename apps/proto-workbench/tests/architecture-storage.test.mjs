import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { applySchemaMigrations } from '../src/main/services/schema-migrations.ts';
import { ArtifactReaderRegistry } from '../src/main/services/artifact-reader-registry.ts';
import { ResearchChatRepository } from '../src/main/services/research-chat-repository.ts';
import { encodeResearchSession, emptyResearchState } from '../src/shared/research-session-state.ts';
import { requestComputeStudies } from '../src/main/services/compute-studies.ts';
import { openWorkspaceExecutionJournal } from '../src/main/services/workspace-execution-journal.ts';
import { ToolExecutionJournal } from '../src/main/services/tool-execution-journal.ts';
import { AppDatabase } from '../src/main/services/database.ts';

const fixtures=resolve('../../build/architecture-storage-tests');mkdirSync(fixtures,{recursive:true});
const workspace=()=>mkdtempSync(join(fixtures,'fixture-'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const session=count=>({id:randomUUID(),title:'Synthetic storage benchmark',createdAt:'2026-09-23T12:00:00Z',updatedAt:'2026-09-23T12:00:00Z',
  messages:Array.from({length:count},(_,i)=>({id:randomUUID(),role:i%2?'assistant':'user',content:`Synthetic message ${i}`,createdAt:'2026-09-23T12:00:00Z',...(i%2?{state:'complete'}:{})})),
  documents:[],status:'idle',payloadSchema:'proto-workbench.research-session.v1',revision:1,researchState:emptyResearchState()});

test('legacy database migration report lists applied changes, verifies checksums and rolls back a changed migration',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE legacy(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO legacy VALUES(1,'original');");
  const plan=[{version:1,sql:'CREATE TABLE IF NOT EXISTS legacy(id INTEGER PRIMARY KEY,value TEXT);',columns:[{table:'legacy',name:'revision',definition:'INTEGER NOT NULL DEFAULT 1'}]},
    {version:2,sql:'CREATE INDEX legacy_revision ON legacy(revision);'}];
  const first=applySchemaMigrations(db,'fixture',plan);assert.deepEqual(first.entries.map(row=>row.status),['applied','applied']);
  const second=applySchemaMigrations(db,'fixture',plan);assert.deepEqual(second.entries.map(row=>row.status),['verified','verified']);
  assert.deepEqual(first.entries.map(row=>row.sha),second.entries.map(row=>row.sha));
  assert.throws(()=>applySchemaMigrations(db,'fixture',[{...plan[0],sql:'DROP TABLE legacy;'},plan[1]]),/checksum/);
  assert.equal(db.prepare('SELECT value FROM legacy').get().value,'original');db.close();
});

test('legacy workbench database opens with all three versioned schema reports and preserves retained settings',()=>{
  const path=join(workspace(),'legacy-workbench.sqlite'),legacy=new DatabaseSync(path);
  legacy.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO settings VALUES('retained','exact legacy bytes');CREATE TABLE run_state(run_id TEXT PRIMARY KEY,archived INTEGER NOT NULL DEFAULT 0);");legacy.close();
  let database=new AppDatabase(path);
  assert.deepEqual(database.migrationReports.map(report=>report.namespace),['workbench','run-history','run-checkpoints']);
  assert.ok(database.migrationReports.every(report=>report.entries.every(entry=>entry.status==='applied')));
  assert.equal(database.db.prepare("SELECT value FROM settings WHERE key='retained'").get().value,'exact legacy bytes');database.close();
  database=new AppDatabase(path);assert.ok(database.migrationReports.every(report=>report.entries.every(entry=>entry.status==='verified')));database.close();
});

test('500-message checkpoint changes one projection row and keeps the original transcript hash algorithm',()=>{
  const root=workspace(),repository=new ResearchChatRepository(join(root,'chat.sqlite'),root);
  try{
    const value=session(500);let raw=encodeResearchSession(value);repository.write(value,raw);
    repository.db.exec(`CREATE TABLE projection_writes(n INTEGER);INSERT INTO projection_writes VALUES(0);
      CREATE TEMP TRIGGER count_projection_update AFTER UPDATE ON research_chat_messages BEGIN UPDATE projection_writes SET n=n+1; END;
      CREATE TEMP TRIGGER count_projection_insert AFTER INSERT ON research_chat_messages BEGIN UPDATE projection_writes SET n=n+1; END;`);
    value.revision++;value.messages.at(-1).content+=' edited';const nextRaw=encodeResearchSession(value),started=performance.now();repository.write(value,nextRaw,raw);
    const elapsedMs=performance.now()-started,writes=repository.db.prepare('SELECT n FROM projection_writes').get().n;
    assert.equal(writes,1);assert.ok(writes<=2);
    const expected=createHash('sha256');value.messages.forEach((message,ordinal)=>expected.update(`${ordinal}\0${message.id}\0${sha(JSON.stringify(message))}\n`));
    assert.equal(repository.messagePage(value.id).transcriptSha256,expected.digest('hex'));
    writeFileSync(join(root,'500-message-benchmark.json'),JSON.stringify({scope:'synthetic storage benchmark only',messages:500,changedProjectionRows:writes,elapsedMs},null,2));
  }finally{repository.close();}
});

test('stream checkpoints write one buffer row, preserve canonical payload, recover by digest and fold on final save',()=>{
  const root=workspace(),repository=new ResearchChatRepository(join(root,'chat.sqlite'),root);
  const value=session(500);value.status='generating';value.messages.at(-1).state='streaming';let raw=encodeResearchSession(value);
  repository.write(value,raw,undefined,'acquire');const originalHash=repository.messagePage(value.id).transcriptSha256;
  const checkpoint=structuredClone(value.messages.at(-1));checkpoint.content+=' partial';
  repository.bufferStream(value.id,checkpoint,raw);
  assert.equal(repository.read(value.id).raw,raw);assert.equal(repository.messagePage(value.id).transcriptSha256,originalHash);
  assert.deepEqual(repository.readStreamBuffer(value.id,raw),checkpoint);
  assert.equal(repository.db.prepare('SELECT count(*) n FROM research_chat_stream_buffer').get().n,1);
  const other=new ResearchChatRepository(join(root,'chat.sqlite'),root);
  assert.throws(()=>other.bufferStream(value.id,checkpoint,raw),error=>error.code==='EXECUTION_OWNERSHIP');other.close();
  value.messages[value.messages.length-1]={...checkpoint,state:'complete'};value.status='idle';value.revision++;
  const final=encodeResearchSession(value);repository.write(value,final,raw,'release');assert.equal(repository.readStreamBuffer(value.id,final),undefined);
  assert.equal(repository.read(value.id).session.messages.at(-1).content,checkpoint.content);repository.close();
});

test('unknown v2 compute manifest stays visible as unsupported and cannot be linked or executed',async()=>{
  const root=workspace(),runId=randomUUID().replaceAll('-',''),directory=join(root,'build','compute',runId);mkdirSync(directory,{recursive:true});
  const raw=JSON.stringify({schema_version:'proto-agent.compute.v2',run_id:runId,tool:'synthetic_fixture',created_at:'2026-09-23T12:00:00Z'});writeFileSync(join(directory,'manifest.json'),raw);
  const listed=await requestComputeStudies(root,{action:'runs'});assert.equal(listed.runs[0].integrity.status,'unsupported-version');assert.ok(listed.migrationReport.entries.length);
  const opened=await requestComputeStudies(root,{action:'open-run',runId});assert.equal(opened.run.integrity.status,'unsupported-version');assert.equal(opened.run.receipt,undefined);assert.equal(opened.run.request,undefined);
  assert.equal(readFileSync(join(directory,'manifest.json'),'utf8'),raw);
  const registry=new ArtifactReaderRegistry().register('example','example.v2',['example.v1']);
  assert.equal(registry.select('example',{schema_version:'example.v1'}).status,'legacy-readonly');assert.equal(registry.select('example',{schema_version:'example.v1'}).readOnly,true);
});

function legacyWorkflow(root,operationId){
  const directory=join(root,'build','compute-studies');mkdirSync(directory,{recursive:true});const db=new DatabaseSync(join(directory,'studies.sqlite'));
  db.exec('CREATE TABLE research_workflow_attempts(id TEXT,execution_id TEXT,step_id TEXT,payload TEXT);CREATE TABLE research_workflow_executions(id TEXT,workflow_id TEXT,study_id TEXT,workflow_revision INTEGER,payload TEXT);');
  const executionId=randomUUID(),workflowId=randomUUID(),studyId=randomUUID(),step={stepId:'one',tool:'fixture',operationId,status:'interrupted'};
  db.prepare('INSERT INTO research_workflow_attempts VALUES(?,?,?,?)').run(operationId,executionId,step.stepId,JSON.stringify(step));
  db.prepare('INSERT INTO research_workflow_executions VALUES(?,?,?,?,?)').run(executionId,workflowId,studyId,1,JSON.stringify({id:executionId,workflowId,studyId,workflowRevision:1,steps:[step]}));db.close();
}
const identity=operationId=>({operationId,scope:{surface:'workflow',scopeId:operationId},tool:'proto_compute_run',effect:'write',arguments:{path:`build/compute-inputs/${operationId}.json`}});

test('workspace journal missing historical rows block dispatch and its binding survives reopen',()=>{
  const root=workspace(),operationId=randomUUID();legacyWorkflow(root,operationId);
  let store=openWorkspaceExecutionJournal(root);assert.throws(()=>store.journal.begin(identity(operationId)),error=>error.code==='WORKSPACE_JOURNAL_UNAVAILABLE');store.close();
  store=openWorkspaceExecutionJournal(root);assert.throws(()=>store.journal.begin(identity(operationId)),error=>error.code==='WORKSPACE_JOURNAL_UNAVAILABLE');const path=store.path;store.close();
  unlinkSync(path);assert.throws(()=>openWorkspaceExecutionJournal(root),/binding remains/);
});

test('workspace-bound legacy receipt is copied verbatim and replays without another dispatch',()=>{
  const root=workspace(),operationId=randomUUID();legacyWorkflow(root,operationId);const legacyDb=new DatabaseSync(':memory:'),journal=new ToolExecutionJournal(legacyDb);
  const call=identity(operationId),start=journal.begin(call);journal.markDispatched(call,start.leaseId);journal.complete(call,start.leaseId,{ok:true,run_id:'a'.repeat(32)});
  const store=openWorkspaceExecutionJournal(root,{legacyDb});assert.deepEqual(store.journal.begin(call),{kind:'receipt',receipt:{ok:true,run_id:'a'.repeat(32)}});
  assert.ok(store.db.prepare('SELECT original_row FROM workspace_journal_legacy_operations WHERE operation_id=?').get(operationId).original_row);
  store.close();legacyDb.close();
});
