import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { IPC } from "../src/shared/ipc.ts";
import { IPC_API_CHANNELS, IPC_ARGUMENT_SCHEMAS, IPC_CHANNEL_CONTRACTS, validateChannelArguments, validateChannelResult } from "../src/shared/ipc-channel-contracts.ts";

test("every request channel has one schema and one native/mock method binding", () => {
  const expected = Object.values(IPC).filter(channel => ![IPC.modelsChanged,IPC.threadStream].includes(channel)).sort();
  assert.deepEqual(Object.keys(IPC_ARGUMENT_SCHEMAS).sort(),expected);
  assert.deepEqual(Object.keys(IPC_CHANNEL_CONTRACTS).sort(),expected);
  const bindings=Object.values(IPC_API_CHANNELS).flatMap(domain=>Object.values(domain));
  assert.equal(new Set(bindings).size,bindings.length);
  assert.deepEqual(bindings.sort(),expected);
  assert.throws(()=>validateChannelArguments(IPC.modelsChanged,[]),/No privileged IPC schema/);
});

test("module and reconciliation schemas enforce declared choices and evidence", () => {
  assert.deepEqual(validateChannelArguments(IPC.settingsUpdate,[{modules:{profile:"custom",enabledOptional:["analysis.chemistry"]}}]),[{modules:{profile:"custom",enabledOptional:["analysis.chemistry"]}}]);
  assert.throws(()=>validateChannelArguments(IPC.settingsUpdate,[{modules:{profile:"custom",enabledOptional:["core.workspace"]}}]),/Invalid arguments/);
  const evidence={operationId:"operation",verdict:"not-applied",actor:"user",evidenceRef:"build/review/evidence.json"};
  assert.deepEqual(validateChannelArguments(IPC.journalReconcile,[evidence]),[evidence]);
  assert.throws(()=>validateChannelArguments(IPC.journalReconcile,[{...evidence,evidenceRef:" "}]),/Invalid arguments/);
  assert.throws(()=>validateChannelArguments(IPC.journalReconcile,[{...evidence,verdict:"retry"}]),/Invalid arguments/);
  assert.throws(()=>validateChannelArguments(IPC.journalReconcile,[{...evidence,grant:true}]),/Invalid arguments/);
});

test("new journal result schemas reject malformed state instead of claiming generic field coverage", () => {
  assert.equal(IPC_CHANNEL_CONTRACTS[IPC.journalInspect].resultValidation,"fields");
  assert.equal(IPC_CHANNEL_CONTRACTS[IPC.modelsList].resultValidation,"domain-types-only");
  assert.deepEqual(validateChannelResult(IPC.journalInspect,{reconciliations:[]}),{reconciliations:[]});
  assert.throws(()=>validateChannelResult(IPC.journalReconcile,{state:"retrying"}));
});

test("handler, native bridge and mock consume the same inferred argument and result types", async () => {
  const app=resolve(dirname(fileURLToPath(import.meta.url)),"..");
  await mkdir(join(app,"build"),{recursive:true});
  const directory=await mkdtemp(join(app,"build","ipc-types-")), file=join(directory,"contract.ts");
  try {
    await writeFile(file,`
import {IPC} from "../../src/shared/ipc.ts";
import type {IpcWorkbenchApi,IpcHandler,InferChannelArgs,InferChannelResult} from "../../src/shared/ipc-channel-contracts.ts";
import type {JournalRecord} from "../../src/shared/execution-journal.ts";
declare const native:IpcWorkbenchApi;
declare const mock:IpcWorkbenchApi;
const valid:InferChannelArgs<typeof IPC.journalReconcile>=[{operationId:"op",verdict:"applied",actor:"user",evidenceRef:"build/proof"}];
const result:Promise<JournalRecord>=native.journal.reconcile(...valid);
const sameResult:Promise<InferChannelResult<typeof IPC.journalReconcile>>=mock.journal.reconcile(...valid);
const handler:IpcHandler<typeof IPC.modelsPin>=(id,pinned)=>({id,pinned});
// @ts-expect-error missing evidence is rejected in native bridge
native.journal.reconcile({operationId:"op",verdict:"applied",actor:"user"});
// @ts-expect-error missing evidence is rejected in mock bridge
mock.journal.reconcile({operationId:"op",verdict:"applied",actor:"user"});
// @ts-expect-error incompatible handler arguments are rejected
const wrongHandler:IpcHandler<typeof IPC.modelsPin>=(id:string,pinned:string)=>undefined;
// @ts-expect-error unknown transport field is rejected
native.models.pin("model", "true");
void result; void sameResult; void handler;
`);
    const program=ts.createProgram([file],{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,allowImportingTsExtensions:true,resolveJsonModule:true,esModuleInterop:true});
    const diagnostics=ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map(diagnostic=>ts.flattenDiagnosticMessageText(diagnostic.messageText,"\n")),[]);
  } finally {await rm(directory,{recursive:true,force:true});}
});
