import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {artifactReaders,artifactReaderCatalog} from '../src/shared/artifact-readers.ts';
import {openWorkspaceExecutionJournal} from '../src/main/services/workspace-execution-journal.ts';
import {validateReconciliationEvidence} from '../src/main/services/reconciliation-evidence.ts';
import {WorkspaceFiles} from '../src/main/services/workspace-files.ts';
import {AppDatabase} from '../src/main/services/database.ts';
import {verifyScientificArtifact} from '../src/main/services/harness-artifact-verification.ts';
import {IPC} from '../src/shared/ipc.ts';
import {validateChannelResult,IPC_ARGUMENT_SCHEMAS} from '../src/shared/ipc-channel-contracts.ts';
import {acquirePreviewExecutionJournal} from '../src/dev/preview-execution-journal.ts';

const root=resolve('../..'),fixtures=join(root,'build/architecture-followup-tests');mkdirSync(fixtures,{recursive:true});
const workspace=()=>mkdtempSync(join(fixtures,'fixture-'));
const sha=value=>createHash('sha256').update(value).digest('hex');

test('preview surfaces share live leases and an older owner cannot close a newer owner',()=>{
  const directory=workspace(),chat=acquirePreviewExecutionJournal(directory),chem=acquirePreviewExecutionJournal(directory);
  assert.equal(chat.journal,chem.journal);
  const identity={operationId:randomUUID(),scope:{surface:'chemistry',scopeId:'fixture-live-operation'},tool:'chemistry.formula_properties',effect:'write',arguments:{formula:'H2O'}};
  const lease=chem.journal.begin(identity);chem.journal.markDispatched(identity,lease.leaseId);
  assert.equal(chat.journal.listPage({}).records[0].state,'dispatched');assert.equal(chat.journal.recoverySummary().unknownEffects,0);
  chat.close();chat.close();
  chem.journal.complete(identity,lease.leaseId,{ok:true});assert.equal(chem.journal.get(identity.operationId).outcome,'ok');chem.close();
});

test('every first-party production schema literal has an explicit registered reader version',()=>{
  const roots=['src/proto_agent','apps/proto-workbench/src/shared','apps/proto-workbench/src/main/services'];
  const declared=new Set(artifactReaderCatalog.families.flatMap(row=>[...row.current,...row.legacy]));
  const observed=new Map();
  const scan=directory=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())scan(path);else if(/\.(py|ts)$/.test(path))for(const match of readFileSync(path,'utf8').matchAll(/["'](proto(?:-agent|-workbench)?\.[A-Za-z0-9_.-]+\.v\d+)["']/g))observed.set(match[1],path);}};
  for(const path of roots)scan(join(root,path));
  const missing=[...observed].filter(([version])=>!declared.has(version));
  assert.deepEqual(missing,[],'New persisted or inline schemas require explicit current/legacy registration. Vendor/runtime mirrors and synthetic test versions are excluded.');
  assert.ok(observed.size>=105);
  assert.equal(artifactReaders.select('ir',{schema_version:'proto-agent.ir.v1'}).status,'current','IR v1 is still emitted by protein and non-placement DNA compilers');
  assert.equal(artifactReaders.select('protein-selection',{schema_version:'proto-agent.protein-selection.v1'}).status,'legacy-readonly');
});

test('future run artifact reopens as unsupported with original bytes preserved and linking rejected',async()=>{
  const directory=workspace(),db=new AppDatabase(join(directory,'profile.sqlite')),files=new WorkspaceFiles(directory,db);
  const content=JSON.stringify({schema_version:'proto-agent.run.v2',run_id:'future-run',ok:true});mkdirSync(join(directory,'build'));writeFileSync(join(directory,'build/manifest.json'),content);
  try{
    const reopened=await files.read('build/manifest.json');
    assert.equal(reopened.artifactReader.code,'UNSUPPORTED_VERSION');assert.equal(reopened.artifactReader.readOnly,true);assert.equal(reopened.content,content);
    const diagnostics=await verifyScientificArtifact(files,{path:'build/manifest.json',sha256:sha(content)},[]);
    assert.match(diagnostics.map(diagnostic => diagnostic.message).join('\n'),/UNSUPPORTED_VERSION/);assert.equal(readFileSync(join(directory,'build/manifest.json'),'utf8'),content);
  }finally{db.close();}
});

test('workspace recovery pages all surfaces, rejects invented evidence, and preserves a portable checked verdict',()=>{
  const directory=workspace();let ledger=openWorkspaceExecutionJournal(directory);
  const identity={operationId:randomUUID(),scope:{surface:'compute',scopeId:'synthetic-recovery-fixture'},tool:'proto_compute_run',effect:'write',arguments:{path:'build/synthetic-input.json'}};
  const start=ledger.journal.begin(identity);ledger.journal.markDispatched(identity,start.leaseId);ledger.close();
  ledger=openWorkspaceExecutionJournal(directory);
  const page=ledger.journal.listPage({state:'effect-unknown'});
  assert.equal(page.unknownEffects,1);assert.equal(page.total,1);assert.equal(page.records[0].scope.surface,'compute');assert.equal(page.records[0].receipt,undefined);
  assert.equal(page.records[0].capabilityId,'compute.run');
  validateChannelResult(IPC.journalList,page);assert.throws(()=>IPC_ARGUMENT_SCHEMAS[IPC.journalList].parse([{limit:201}]));
  for(const evidence of ['I checked the result','build/missing.json','../escape.txt','C:/outside.json'])assert.throws(()=>ledger.journal.reconcile(identity.operationId,'not-applied','fixture reviewer',evidence),/evidence|Evidence/);
  assert.equal(ledger.journal.get(identity.operationId).state,'effect-unknown');
  const evidence='build/effect-review.json',text=JSON.stringify({fixture:true,operationId:identity.operationId,verdict:'not-applied',reason:'Fault injection stopped before worker launch.'});writeFileSync(join(directory,evidence),text);
  assert.throws(()=>validateReconciliationEvidence(directory,`${evidence}#sha256=${'0'.repeat(64)}`),/SHA-256/);
  const record=ledger.journal.reconcile(identity.operationId,'not-applied','fixture reviewer',evidence);
  assert.equal(record.state,'reconciled-not-applied');assert.equal(ledger.journal.recoverySummary().unknownEffects,0);
  assert.throws(()=>ledger.journal.begin(identity),{code:'TOOL_OPERATION_RECONCILED'});
  const saved=ledger.journal.reconciliationHistory(identity.operationId)[0];assert.equal(saved.evidenceRef,`${evidence}#sha256=${sha(text)}`);ledger.close();
  const profileTwo=workspace();cpSync(join(directory,'build'),join(profileTwo,'build'),{recursive:true});ledger=openWorkspaceExecutionJournal(profileTwo);
  try{assert.equal(ledger.journal.get(identity.operationId).state,'reconciled-not-applied');assert.equal(validateReconciliationEvidence(profileTwo,saved.evidenceRef),saved.evidenceRef);}finally{ledger.close();}
});
