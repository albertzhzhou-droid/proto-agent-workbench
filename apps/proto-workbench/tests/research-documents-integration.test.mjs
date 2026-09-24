import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { ResearchToolBridge } from "../src/main/services/research-tools.ts";
import { ResearchChatService } from "../src/main/services/research-chat.ts";
import { chatMessageText } from "../src/main/services/chat-context.ts";
import { validateIpcArguments } from "../src/main/ipc-security.ts";
import { IPC } from "../src/shared/ipc.ts";
import { CHAT_REQUEST_LIMIT, CHAT_IMPORT_REQUEST_LIMIT, chatRequestLimit } from "../src/shared/research-request-limits.ts";
import { DOCUMENT_INPUT_LIMIT } from "../src/main/services/research-documents.ts";
import { researchChatPreview } from "../src/dev/research-chat-preview.ts";
import { docxFixture, pdfFixture, xlsxFixture } from "./helpers/research-document-fixtures.mjs";

const signal=()=>new AbortController().signal;
async function workspace(){return mkdtemp(join(tmpdir(),"proto-doc-integration-"));}
function fakeRuntime(chat=async()=>{}){return{scan:async()=>[],load:async()=>({}),getExecutionBinding:async()=>({contextLength:32768,instanceId:"test-instance"}),countExecutionTokens:async()=>({tokens:2000,method:"test"}),chat};}

test("model document import/read use real parser, source locators and session membership",async()=>{
  const root=await workspace();await writeFile(join(root,"data.xlsx"),xlsxFixture());
  const bridge=new ResearchToolBridge({}, {canonicalRootPath:async()=>root});
  const session={id:randomUUID(),documents:[]};
  const result=await bridge.execute("document_import",{path:"data.xlsx"},session,signal());
  assert.equal(session.documents.length,1);assert.equal(result.documentId,session.documents[0].id);assert.match(result.note,/excerpt/);
  const page=await bridge.execute("document_read",{documentId:result.documentId,limit:1},session,signal());
  assert.equal(page.units[0].sheet,"Results");assert.equal(page.units[0].cells[2].address,"C1");assert.equal(page.units[0].cells[2].value,"10");assert.equal(page.nextUnit,1);
  const next=await bridge.execute("document_read",{documentId:result.documentId,startUnit:page.nextUnit,limit:1},session,signal());
  assert.equal(next.units[0].sheet,"Metadata");assert.equal(next.nextUnit,null);
  await assert.rejects(bridge.execute("document_read",{documentId:result.documentId},{id:randomUUID(),documents:[]},signal()),/not attached/);
  await assert.rejects(bridge.execute("document_import",{path:"../external.pdf"},session,signal()),/inside/);
  assert.deepEqual(await readFile(join(root,result.extraction.sourcePath)),xlsxFixture());
});

test("selected extraction context carries document identity, hash, complete-artifact paths and excerpt warning",async()=>{
  const root=await workspace();await writeFile(join(root,"paper.pdf"),pdfFixture());
  const bridge=new ResearchToolBridge({}, {canonicalRootPath:async()=>root});const session={id:randomUUID(),documents:[]};
  await bridge.execute("document_import",{path:"paper.pdf"},session,signal());
  const document=session.documents[0];
  const projected=chatMessageText({role:"user",content:"Read page two",documents:[document]});
  assert.ok(projected.includes(document.id));assert.ok(projected.includes(document.sourceSha256));assert.ok(projected.includes(document.extraction.extractionPath));assert.match(projected,/initial excerpt/);assert.match(projected,/document_read/);assert.match(projected,/"unitCount":2/);
});

test("a streamed document_write cannot overwrite an imported source by reusing its filename",async t=>{
  const root=await workspace();const source=pdfFixture();await writeFile(join(root,"paper.pdf"),source);
  const bridge=new ResearchToolBridge({}, {canonicalRootPath:async()=>root});let step=0;let imported;
  const runtime=fakeRuntime(async(_model,payload,chunk)=>{
    step++;
    if(step===1)chunk({choices:[{delta:{tool_calls:[{index:0,id:"import",function:{name:"document_import",arguments:JSON.stringify({path:"paper.pdf"})}}]}}]});
    else if(step===2){const receipt=payload.messages.find(item=>item.role==="tool");const data=JSON.parse(receipt.content.slice(receipt.content.indexOf("\n")+1));imported=data;chunk({choices:[{delta:{tool_calls:[{index:0,id:"overwrite",function:{name:"document_write",arguments:JSON.stringify({name:"paper.pdf",content:"changed source"})}}]}}]});}
    else{const receipt=payload.messages.filter(item=>item.role==="tool").at(-1);assert.match(receipt.content,/text or source-code filename/);chunk({choices:[{delta:{content:"The original source remains unchanged."}}]});}
  });
  const service=new ResearchChatService({workspace:root,databasePath:join(root,"chat.sqlite"),runtime,tools:bridge});t.after(()=>service.close());
  const{session}=await service.request({action:"create"});await service.request({action:"send",sessionId:session.id,modelId:"model",content:"Import paper.pdf and attempt to revise it",documentIds:[]});
  let completed;for(let n=0;n<150;n++){completed=(await service.request({action:"get",sessionId:session.id})).session;if(completed.status==="idle")break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(completed.status,"idle");assert.equal(completed.error,undefined);assert.equal(completed.documents.length,1);assert.equal(completed.messages[1].activity[1].status,"error");
  assert.deepEqual(await readFile(join(root,"paper.pdf")),source);assert.deepEqual(await readFile(join(root,imported.extraction.sourcePath)),source);
  const artifact=JSON.parse(await readFile(join(root,imported.extraction.extractionPath),"utf8"));assert.match(artifact.units[1].text,/Mean = 6/);
});

test("IPC expands only the binary-import transport budget and parser rejects even one excess byte",async t=>{
  const root=await workspace();const service=new ResearchChatService({workspace:root,databasePath:join(root,"chat.sqlite"),runtime:fakeRuntime()});t.after(()=>service.close());const{session}=await service.request({action:"create"});
  const request={action:"import",sessionId:session.id,name:"large.docx",base64:docxFixture("Evidence ".repeat(80000)).toString("base64")};
  assert.ok(Buffer.byteLength(JSON.stringify(request))>CHAT_REQUEST_LIMIT);assert.equal(chatRequestLimit(request),CHAT_IMPORT_REQUEST_LIMIT);assert.doesNotThrow(()=>validateIpcArguments(IPC.researchChat,[request]));
  assert.throws(()=>validateIpcArguments(IPC.researchChat,[{...request,action:"document"}]),/Invalid arguments/);
  const result=await service.request(request);assert.ok(result.session.documents[0].extraction.totalCharacters>512000);
  const overByOne=Buffer.alloc(DOCUMENT_INPUT_LIMIT+1).toString("base64");
  await assert.rejects(service.request({action:"import",sessionId:session.id,name:"too-large.pdf",base64:overByOne}),/between 1 byte and 20 MiB/);
  assert.throws(()=>validateIpcArguments(IPC.researchChat,[{...request,base64:"a".repeat(CHAT_IMPORT_REQUEST_LIMIT)}]),/Invalid arguments/);
});

test("same-origin preview accepts real large uploads while non-import and foreign-origin requests fail",async t=>{
  const root=await workspace();const application=join(root,"apps","proto-workbench");await mkdir(application,{recursive:true});
  const http=createServer();const plugin=researchChatPreview();
  plugin.configureServer({config:{root:application},httpServer:http,middlewares:{use:handler=>http.on("request",(request,response)=>handler(request,response,()=>{response.statusCode=404;response.end();}))}});
  await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const base=`http://127.0.0.1:${http.address().port}`;
  const post=(request,origin=base)=>fetch(`${base}/__proto/chat`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({request,modules:{profile:"core-only",enabledOptional:[]}})});
  const created=await(await post({action:"create"})).json();const sessionId=created.session.id;
  const imported=await post({action:"import",sessionId,name:"large.docx",base64:docxFixture("Verified content ".repeat(40000)).toString("base64")});assert.equal(imported.status,200);assert.equal((await imported.json()).session.documents.length,1);
  const rejected=await post({action:"document",sessionId,name:"large.md",content:"x".repeat(CHAT_REQUEST_LIMIT)});assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/too large/);
  const foreign=await post({action:"list"},"https://untrusted.example");assert.equal(foreign.status,403);
});

test("PDF uploads work after Vite's config runner has closed",{timeout:30000},async t=>{
  const root=await workspace();const application=join(root,"apps","proto-workbench");await mkdir(application,{recursive:true});
  const vite=await createViteServer({configFile:fileURLToPath(new URL("../vite.config.mjs",import.meta.url)),configLoader:"runner",root:application,logLevel:"silent",optimizeDeps:{include:[],noDiscovery:true},server:{host:"127.0.0.1",port:0,strictPort:false,warmup:{clientFiles:[]},watch:null}});
  t.after(()=>vite.close());await vite.listen();
  const base=`http://127.0.0.1:${vite.httpServer.address().port}`;
  const post=request=>fetch(`${base}/__proto/chat`,{method:"POST",headers:{Origin:base,"Content-Type":"application/json"},body:JSON.stringify({request,modules:{profile:"core-only",enabledOptional:[]}})});
  const created=await(await post({action:"create"})).json();const sessionId=created.session.id;
  const response=await post({action:"import",sessionId,name:"research.pdf",base64:pdfFixture().toString("base64")});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.session.documents[0].extraction.unitCount,2);
  const read=await(await post({action:"document_read",sessionId,documentId:result.session.documents[0].id,startUnit:1,limit:1})).json();assert.equal(read.documentPage.units[0].page,2);assert.match(read.documentPage.units[0].text,/Mean = 6/);
});
