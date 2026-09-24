// Explicit fixture seeder for browser acceptance; no inference server is used.
// Stop the preview first so its in-memory session list will reload these records.
import {readFile, writeFile} from "node:fs/promises";
import {resolve, join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {ResearchChatService} from "../src/main/services/research-chat.ts";

if(process.argv[2]!=="--seed-preview" || !process.argv[3]) throw Error("Usage: node --experimental-strip-types tests/seed-research-evidence-preview.mjs --seed-preview <workspace>");
const workspace=resolve(process.argv[3]),databasePath=join(workspace,"build/chat-preview/conversations.sqlite");
const retained=JSON.parse(await readFile(new URL("./fixtures/research-evidence/acid-base-retained.json",import.meta.url),"utf8"));
const runtime={scan:async()=>[],load:async()=>({}),getExecutionBinding:async()=>({contextLength:32768,instanceId:"fixture-no-live-model"}),countExecutionTokens:async()=>({tokens:1500,method:"fixture-not-tokenizer"}),chat:async(_id,request,chunk)=>{
  if(request.messages.some(item=>item.role==="tool")) chunk({choices:[{delta:{content:`Retained regression fixture. This copied model label was not supported by the original tool receipt.\n\n${retained.observed_text}`}}]});
  else chunk({choices:[{delta:{tool_calls:[{index:0,id:"fixture-acid-base",function:{name:"science_run",arguments:JSON.stringify(retained.requested)}}]}}]});
}};
const service=new ResearchChatService({workspace,databasePath,runtime,tools:{execute:async()=>structuredClone(retained.receipt)}});
const records=[];
try {
  for(const scenario of ["receipt-bound facts","tampered receipt","legacy without digest"]) {
    const {session}=await service.request({action:"create"});
    await service.request({action:"send",sessionId:session.id,modelId:"fixture-no-live-model",content:`UI acceptance fixture: ${scenario}. No live model or scientific calculation was run.`,documentIds:[]});
    let current;
    for(let i=0;i<100;i++) {
      current=(await service.request({action:"get",sessionId:session.id})).session;
      if(current.status==="idle") break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    if(current.status!=="idle" || current.error) throw Error(current.error??"Fixture did not settle");
    await service.request({action:"rename",sessionId:session.id,title:`Fixture · ${scenario}`});
    records.push({scenario,id:session.id,artifactPath:current.messages[1].activity[0].artifactPath});
  }
} finally {await service.close();}
await writeFile(join(workspace,records[1].artifactPath),JSON.stringify({fixture:"Intentionally changed after the host recorded its digest"}));
const db=new DatabaseSync(databasePath);
try {
  const row=db.prepare("SELECT payload FROM research_chats WHERE id=?").get(records[2].id),session=JSON.parse(row.payload);
  delete session.messages[1].activity[0].artifactSha256;
  db.prepare("UPDATE research_chats SET payload=? WHERE id=?").run(JSON.stringify(session),records[2].id);
} finally {db.close();}
console.log(JSON.stringify({scope:"explicit UI fixtures; no live model; original retained trace unchanged",records},null,2));
