import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {isDeepStrictEqual} from "node:util";
import Ajv from "ajv";
import {AppDatabase} from "../src/main/services/database.ts";
import {HarnessController, HARNESS_TOOLS, createHarnessCheckpoint} from "../src/main/services/harness-controller.ts";
import {HarnessStore} from "../src/main/services/harness-store.ts";
import {HarnessWorkspace, harnessToolEffect} from "../src/main/services/harness-workspace.ts";
import {WorkspaceFiles} from "../src/main/services/workspace-files.ts";
import {McpClient} from "../src/main/services/mcp-client.ts";
import {ToolExecutionJournal} from "../src/main/services/tool-execution-journal.ts";
import {completionGate} from "../src/main/services/turn-engine.ts";

export const PACK_PATH = fileURLToPath(new URL("../evaluation/software-tasks.v1.json", import.meta.url));
export const PACK_DIGEST_PATH = fileURLToPath(new URL("../evaluation/software-tasks.v1.sha256", import.meta.url));
export const sha256 = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const SCORER = "software-fixture-exact-v1";
const ARMS = ["direct", "harness"];
const CLASSES = ["repairable", "dependency-missing", "unsupported", "stale", "conflicting"];
const SYSTEM = "You are evaluating synthetic software fixtures only. Read every required input with workspace_read. Save the requested output with workspace_propose_patch under build/. Do not invent source facts. Finish by calling harness_finish with a brief summary. If available evidence or tools cannot satisfy the request, call harness_report_blocked with the reason and unmet requirements. Do not execute programs, access networks, or generate biological designs. Hidden fixture scoring is independent of your summary.";
const definition = (name, description, properties, required) => ({type:"function",function:{name,description,parameters:{type:"object",properties,required,additionalProperties:false}}});
export const EVALUATION_TOOLS = [
  definition("workspace_read", "Read one text file inside the selected fixture workspace.", {path:{type:"string"}}, ["path"]),
  definition("workspace_propose_patch", "Create and atomically apply complete text content under build/ with a durable source receipt.", {path:{type:"string"},content:{type:"string"},rationale:{type:"string"}}, ["path","content","rationale"]),
];
const directTools = [...EVALUATION_TOOLS, ...HARNESS_TOOLS.filter(t=>["harness_finish","harness_report_blocked"].includes(t.function.name))];
const ajv = new Ajv({allErrors:true,strict:false});
const validators = new Map(directTools.map(t=>[t.function.name,ajv.compile(t.function.parameters)]));
const immutableJson = (path,value)=>writeFile(path,JSON.stringify(value,null,2)+"\n",{flag:"wx"});
const countBy = values => values.reduce((counts,value)=>(counts[value]=(counts[value]??0)+1,counts),{});
const failureCode = error => String(error?.code ?? error?.name ?? "EVALUATION_ERROR").slice(0,128);

export async function loadFrozenPack(path=PACK_PATH, digestPath=PACK_DIGEST_PATH) {
  const bytes=await readFile(path), expected=(await readFile(digestPath,"utf8")).trim().split(/\s+/)[0];
  if(sha256(bytes)!==expected)throw new Error("EVALUATION_PACK_DIGEST_MISMATCH");
  const pack=JSON.parse(bytes);
  if(pack.schema!=="proto-workbench.software-task-pack.v1"||pack.tasks.length!==30||new Set(pack.tasks.map(t=>t.id)).size!==30)throw new Error("EVALUATION_PACK_INVALID");
  for(const task of pack.tasks){
    if(!/^[a-z]+-\d{2}$/.test(task.id)||!Array.isArray(task.requiredReads)||!task.prompt||!task.expected||typeof task.possible!=="boolean")throw new Error("EVALUATION_TASK_INVALID");
    for(const path of [...Object.keys(task.files),...task.requiredReads,task.outputPath])if(isAbsolute(path)||path.includes("\\")||path.split("/").some(p=>p===".."||!p)||! /^(fixtures|build)\//.test(path))throw new Error("EVALUATION_TASK_PATH_INVALID");
  }
  return {pack,sha256:expected};
}

/** No model text can override this scorer or make an impossible task pass. */
export async function scoreFixture(task,workspace) {
  if(!task.possible)return {pass:false,diagnostics:[{code:task.expected.code,blockingClass:task.expected.blockingClass,subject:task.outputPath,message:task.expected.reason}]};
  try{
    const file=await workspace.read(task.outputPath);
    const actual=task.expected.format==="json"?JSON.parse(file.content):file.content;
    return isDeepStrictEqual(actual,task.expected.value)?{pass:true,diagnostics:[]}:{pass:false,diagnostics:[{code:"FIXTURE_OUTPUT_MISMATCH",blockingClass:"repairable",subject:task.outputPath,message:"Saved fixture output does not match the independently frozen software reference."}]};
  }catch{return {pass:false,diagnostics:[{code:"FIXTURE_OUTPUT_UNREADABLE",blockingClass:"repairable",subject:task.outputPath,message:"Requested fixture output is missing, unreadable, or malformed."}]};}
}

export function summarizeEvaluation(pack,records) {
  const seen=new Set();
  for(const record of records){const key=`${record.arm}:${record.caseId}`;if(seen.has(key)||!ARMS.includes(record.arm)||!pack.tasks.some(t=>t.id===record.caseId))throw new Error("EVALUATION_DUPLICATE_OR_UNKNOWN_SLOT");seen.add(key);}
  const arms=Object.fromEntries(ARMS.map(arm=>{
    const rows=records.filter(r=>r.arm===arm), possible=pack.tasks.filter(t=>t.possible).length, impossible=pack.tasks.length-possible;
    const total = key => rows.reduce((sum,row)=>sum+(row[key]??0),0);
    const tokenValues=rows.map(r=>r.tokens).filter(v=>v!==null&&v!==undefined);
    const unknownMeasurements=Object.fromEntries(["toolCalls","externalToolCalls","wallTimeMs","duplicateEffects","duplicateWriteEffects"].map(key=>[key,rows.filter(r=>r[key]===null||r[key]===undefined).length]));
    const counters={};for(const row of rows)for(const [key,value]of Object.entries(row.recovery??{}))counters[key]=(counters[key]??0)+value;
    const diagnostics=Object.fromEntries(CLASSES.map(c=>[c,0]));for(const row of rows)for(const [key,value]of Object.entries(row.diagnosticClasses??{}))diagnostics[key]=(diagnostics[key]??0)+value;
    const completed=rows.filter(r=>r.state==="completed").length, validated=rows.filter(r=>r.validationPassed).length;
    const abstained=rows.filter(r=>["abstained","needs-human"].includes(r.state));
    const correct=abstained.filter(r=>!pack.tasks.find(t=>t.id===r.caseId).possible).length,falseCount=abstained.length-correct;
    return [arm,{planned:pack.tasks.length,attempted:rows.length,notStarted:pack.tasks.length-rows.length,statuses:countBy(rows.map(r=>r.status)),states:countBy(rows.map(r=>r.state)),
      taskCompletion:{count:completed,denominator:pack.tasks.length,rate:completed/pack.tasks.length},validation:{count:validated,denominator:pack.tasks.length,rate:validated/pack.tasks.length},
      correctAbstention:{count:correct,denominator:impossible,rate:correct/impossible},falseAbstention:{count:falseCount,denominator:possible,rate:falseCount/possible},
      toolCalls:total("toolCalls"),externalToolCalls:total("externalToolCalls"),tokens:{observedTotal:tokenValues.reduce((a,b)=>a+b,0),observedAttempts:tokenValues.length,unknownAttempts:rows.length-tokenValues.length},wallTimeMs:total("wallTimeMs"),duplicateEffects:total("duplicateEffects"),duplicateWriteEffects:total("duplicateWriteEffects"),unknownMeasurements,recovery:counters,diagnosticClasses:diagnostics}];
  }));
  return {schema:"proto-workbench.software-evaluation-report.v1",softwareOnly:true,scorerVersion:SCORER,planned:pack.tasks.length*2,attempted:records.length,arms,
    notes:["Completion, validation, abstention, resource usage and recovery are separate dimensions; no composite score.","Denominators include every frozen task slot. Not-started slots are disclosed; failures, refusals, timeouts, cancellations and interruptions are retained.","Unknown token usage is not zero. Duplicate effects counts repeat journal argument digests within a run; duplicateWriteEffects restricts that descriptive counter to writes.","Synthetic software acceptance is not scientific correctness or model-category safety evidence."]};
}

function assertBinding(expected,actual){if(actual.instanceId!==expected.instanceId||actual.modelId!==expected.modelId||actual.contextLength!==expected.contextLength)throw Object.assign(new Error("Exact model instance or context changed; campaign stopped."),{code:"EVALUATION_INSTANCE_CHANGED"});}
function collectUsage(target,chunk){if(chunk.usage){target.last=chunk.usage;}}
async function directLoop(c,host,store,signal,usage){
  const messages=c.messages;
  for(;c.round<c.contract.budgets.maxRounds;){
    signal.throwIfAborted();c.round++;let content="",calls=[];
    await host.chat({messages,tools:directTools,tool_choice:"auto",temperature:0,max_tokens:Math.min(2048,c.contract.budgets.maxGeneratedTokens-(usage.generated??0))},chunk=>{
      for(const choice of chunk.choices??[]){content+=choice.delta?.content??"";for(const part of choice.delta?.tool_calls??[]){const call=calls[part.index]??={id:randomUUID(),type:"function",function:{name:"",arguments:""}};call.function.name+=part.function?.name??"";call.function.arguments+=part.function?.arguments??"";}}
    },signal);
    c.messages.push({role:"assistant",content,...(calls.length?{tool_calls:calls}: {})});
    if(!calls.length){c.fullContent=content;c.state="incomplete";break;}
    for(const call of calls.filter(Boolean)){
      let args,result;
      try{args=JSON.parse(call.function.arguments);if(!validators.get(call.function.name)?.(args))throw new Error("INVALID_TOOL_ARGUMENTS");}catch{result={ok:false,code:"INVALID_TOOL_ARGUMENTS",effect_state:"none"};}
      if(!result&&call.function.name==="harness_report_blocked"){c.state="abstained";c.abstention={reason:args.reason,unmetRequirements:args.unmet_requirements,declaredAt:new Date().toISOString()};store.save(c);return;}
      if(!result&&call.function.name==="harness_finish"){const verification=await host.verify(c,args.summary);c.state=verification.ok?"completed":"incomplete";c.fullContent=args.summary;store.save(c);return;}
      if(!result&&host.effect(call.function.name)==="write"&&(c.round>=c.contract.budgets.maxRounds||usage.generated>=c.contract.budgets.maxGeneratedTokens))result={ok:false,code:"TASK_BUDGET_EXHAUSTED",effect_state:"none"};
      if(!result){try{result=await host.execute(call.function.name,args,call.id,c,signal);}catch(error){if(signal.aborted)throw error;result={ok:false,code:failureCode(error),effect_state:"none"};}}
      const envelope=store.record(c.contract.runId,call.id,call.function.name,result);c.resultHandles.push(envelope.handle);c.completedCalls.push(call.id);c.messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(result)});store.save(c);
    }
    if((usage.generated??0)>=c.contract.budgets.maxGeneratedTokens){c.state="incomplete";c.error={code:"TASK_BUDGET_EXHAUSTED",message:"Generated token budget exhausted.",stage:"generating",retryable:false,effectState:"none"};break;}
  }
  if(!["completed","incomplete","abstained"].includes(c.state)){c.state="incomplete";c.error={code:"TASK_BUDGET_EXHAUSTED",message:"Round budget exhausted.",stage:"generating",retryable:false,effectState:"none"};}store.save(c);
}

/** Both arms use the same production workspace CAS, journal and exact instance. */
export async function runFrozenEvaluation({out,provider,model,instanceId,iteration="slice-b",attemptMs=60000,maxRounds=6,maxTokens=8192,signal=new AbortController().signal,onProgress=()=>{},packPath=PACK_PATH,digestPath=PACK_DIGEST_PATH}){
  if(!["baseline","slice-a","slice-b","slice-b-and-plan"].includes(iteration))throw new Error("EVALUATION_ITERATION_INVALID");
  for(const [value,min,max]of [[attemptMs,1000,300000],[maxRounds,1,16],[maxTokens,256,32768]])if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error("EVALUATION_BUDGET_INVALID");
  const frozen=await loadFrozenPack(packPath,digestPath),initial=await provider.getExecutionBinding(model.id,signal);
  if(initial.instanceId!==instanceId)throw new Error("EVALUATION_EXACT_INSTANCE_REQUIRED");
  const campaignId=randomUUID(),root=resolve(out);await mkdir(root,{recursive:false});await mkdir(join(root,"attempts"));
  const modelFingerprint=sha256({id:model.id,providerModelId:model.providerModelId,sizeBytes:model.sizeBytes,quantization:model.quantization});
  const identity={provider:"lmstudio",providerModelId:model.providerModelId,modelId:model.id,modelFingerprint,instanceId,runtimeFingerprint:sha256({node:process.version,platform:process.platform,arch:process.arch,contextLength:initial.contextLength,provider:model.provider,providerModelId:model.providerModelId})};
  const toolSchemaSha256=sha256(EVALUATION_TOOLS),promptTemplateSha256=sha256(SYSTEM);
  const sourceNames=["harness-controller.ts","harness-workspace.ts","harness-context.ts","harness-iteration.ts","harness-diagnostics.ts","harness-material-evidence.ts","harness-artifact-verification.ts","harness-store.ts","mission-evidence.ts","mission-source-field.ts","lm-studio-provider.ts","workspace-files.ts","mcp-client.ts","tool-execution-journal.ts","turn-engine.ts"];
  const sourceHashes=Object.fromEntries(await Promise.all(sourceNames.map(async name=>[name,sha256(await readFile(new URL(`../src/main/services/${name}`,import.meta.url)))])));
  for(const path of ["../src/shared/harness.ts","../src/shared/tool-contracts.ts","./harness-evaluation-core.mjs","./run-harness-evaluation.mjs","../pnpm-lock.yaml"])sourceHashes[path]=sha256(await readFile(new URL(path,import.meta.url)));
  const manifest={schema:"proto-workbench.software-evaluation-campaign.v1",campaignId,createdAt:new Date().toISOString(),iteration,taskPackSha256:frozen.sha256,identity,budgets:{attemptMs,maxRounds,maxTokens},sampling:{temperature:0.2,maxOutputTokensPerCall:2048},toolSchemaSha256,promptTemplateSha256,sourceHashes,arms:ARMS,planned:60,armDifference:"Direct arm has a bounded ordinary tool loop and one final verification. Harness arm uses the current production controller, its discovery, durable repair and completion gates. Both share workspace tools, scorer, fixture inputs, instance, sampling and limits. The iteration label does not enable or disable mechanisms; source hashes identify the implementation actually measured."};
  const campaignSha256=sha256(JSON.stringify(manifest,null,2)+"\n");
  await immutableJson(join(root,"campaign.json"),manifest);await writeFile(join(root,"task-pack.json"),await readFile(packPath),{flag:"wx"});
  const database=new AppDatabase(join(root,"evaluation.sqlite")),journal=new ToolExecutionJournal(database.db),store=new HarnessStore(database.db,journal),records=[];
  let stop=false;
  try{
    for(const [index,task]of frozen.pack.tasks.entries()){
      // Alternate arm order to avoid making warm-up/order identical for one arm.
      for(const arm of index%2?[...ARMS].reverse():ARMS){
        if(signal.aborted||stop)break;
        assertBinding(initial,await provider.getExecutionBinding(model.id,signal));
        const attemptId=randomUUID(),evaluationId=`${campaignId}:${arm}`,dir=join(root,"attempts",attemptId),workspaceRoot=join(dir,"workspace");await mkdir(workspaceRoot,{recursive:true});
        for(const [path,content]of Object.entries(task.files)){const target=join(workspaceRoot,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,content,{flag:"wx"});}
        await mkdir(join(workspaceRoot,"build"),{recursive:true});
        const startedAt=new Date().toISOString(),start=Date.now();
        const startRecord={attemptId,evaluationId,arm,caseId:task.id,caseSha256:sha256(task),startedAt,identity,taskPackSha256:frozen.sha256,campaignSha256};await immutableJson(join(dir,"started.json"),startRecord);
        const contract={schema:"proto-workbench.mission.v1",runId:attemptId,threadId:attemptId,workspacePath:workspaceRoot,goal:task.prompt,modelId:model.id,mode:"act",contextTokens:initial.contextLength,scope:{writeRoots:["build"],network:false,execution:false},requiredReads:task.requiredReads,evidenceRequirements:[],deliverables:[{path:task.outputPath,kind:"document"}],requiresArtifacts:true,budgets:{activeTimeMs:attemptMs,maxRounds,maxGeneratedTokens:maxTokens}};
        const checkpoint=createHarnessCheckpoint(contract,SYSTEM,[],EVALUATION_TOOLS);store.save(checkpoint);
        const files=new WorkspaceFiles(workspaceRoot,database),mcp=new McpClient({packaged:false,resourcesPath:"",repoRoot:resolve(fileURLToPath(new URL("../../..",import.meta.url))),workspacePath:workspaceRoot,workspaceCapability:randomUUID()},{journal});
        const workspace=new HarnessWorkspace(files,database,mcp,store,async()=>[],()=>{});
        const diagnosticEvents=[],usage={tokens:0,generated:0,known:true,toolCalls:0,externalToolCalls:0};let thrown,terminalVerification;
        const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(Object.assign(new Error("Evaluation wall-clock deadline reached."),{code:"EVALUATION_TIMEOUT"})),attemptMs);
        const attemptSignal=AbortSignal.any([signal,deadline.signal]);
        const host={tools:EVALUATION_TOOLS,binding:async s=>{const binding=await provider.getExecutionBinding(model.id,s);assertBinding(initial,binding);return binding;},
          count:async(messages,tools,s)=>{const count=await provider.countPromptTokens(model.id,{messages,tools},s);return {tokens:count.tokens,method:count.method==="tokenizer"?"exact":"conservative-estimate"};},
          chat:async(payload,onChunk,s)=>{if(usage.generated>=maxTokens)throw Object.assign(new Error("Generated token budget exhausted."),{code:"TASK_BUDGET_EXHAUSTED"});const observed={},callIndices=new Set();await provider.chat(model.id,{...payload,temperature:0.2,max_tokens:Math.min(2048,payload.max_tokens??2048,maxTokens-usage.generated)},chunk=>{collectUsage(observed,chunk);for(const choice of chunk.choices??[])for(const call of choice.delta?.tool_calls??[])callIndices.add(call.index);onChunk(chunk);},s).finally(()=>{usage.toolCalls+=callIndices.size;if(Number.isSafeInteger(observed.last?.total_tokens)){usage.tokens+=observed.last.total_tokens;}else usage.known=false;if(Number.isSafeInteger(observed.last?.completion_tokens))usage.generated+=observed.last.completion_tokens;else usage.generated+=Math.min(2048,maxTokens);});},
          effect:harnessToolEffect,executionRecord:id=>journal.get(id),execute:(...args)=>{usage.externalToolCalls++;return workspace.execute(...args);},reconcile:(...args)=>workspace.reconcile(...args),
          verify:async(c,summary)=>{const checked=await workspace.verify(c,summary),scored=await scoreFixture(task,files),gate=completionGate(store.executionActivities(c.contract.runId));const gateDiagnostics=gate==="complete"?[]:[{code:"EVALUATION_EXECUTION_INCOMPLETE",blockingClass:"repairable",subject:c.contract.runId,message:"Durable execution evidence remains incomplete under the shared completion gate."}];const combined={ok:checked.ok&&scored.pass&&gate==="complete",diagnostics:[...checked.diagnostics,...scored.diagnostics,...gateDiagnostics],artifacts:checked.artifacts};diagnosticEvents.push(...combined.diagnostics);terminalVerification=combined;return combined;},publish:()=>{},delta:()=>{}};
        try{if(arm==="harness")await new HarnessController(store,host).run(checkpoint,attemptSignal);else await directLoop(checkpoint,host,store,attemptSignal,usage);
          if(!attemptSignal.aborted)assertBinding(initial,await provider.getExecutionBinding(model.id,attemptSignal));
        }catch(error){thrown=error;checkpoint.state=attemptSignal.aborted?"cancelled":"failed";checkpoint.error={code:failureCode(error),message:String(error),stage:"evaluation",retryable:false,effectState:journal.list({surface:"harness",scopeId:attemptId}).some(r=>r.state==="effect-unknown")?"unknown":"none"};store.save(checkpoint);if(error?.code==="EVALUATION_INSTANCE_CHANGED")stop=true;}
        finally{clearTimeout(timer);await mcp.stop();}
        const finishedAt=new Date().toISOString(),entries=journal.list({surface:"harness",scopeId:attemptId}),digests=entries.map(r=>r.argumentsSha256),writeDigests=entries.filter(r=>r.effect==="write").map(r=>r.argumentsSha256);
        const status=deadline.signal.aborted?"timeout":signal.aborted?"cancelled":checkpoint.state==="completed"?"success":checkpoint.state==="abstained"?"refused":checkpoint.state==="needs-human"?"unsupported":checkpoint.state==="cancelled"?"cancelled":"error";
        const scalarScore=await scoreFixture(task,files);
        const result={schema:"proto-workbench.software-evaluation-result.v1",attemptId,arm,caseId:task.id,taskPackSha256:frozen.sha256,campaignSha256,state:checkpoint.state,status,validationPassed:Boolean(terminalVerification?.ok&&scalarScore.pass),toolCalls:usage.toolCalls,externalToolCalls:usage.externalToolCalls,tokens:usage.known?usage.tokens:null,generatedTokens:checkpoint.generatedTokens||usage.generated,wallTimeMs:Date.now()-start,duplicateEffects:digests.length-new Set(digests).size,duplicateWriteEffects:writeDigests.length-new Set(writeDigests).size,recovery:checkpoint.recoveryCounters??{},diagnosticClasses:countBy(diagnosticEvents.map(d=>d.blockingClass??"repairable")),diagnostics:diagnosticEvents,journal:entries.map(({operationId,tool,argumentsSha256,effect,state})=>({operationId,tool,argumentsSha256,effect,state})),failureMessage:checkpoint.error?.message?.slice(0,2000),failureCode:deadline.signal.aborted?"EVALUATION_TIMEOUT":checkpoint.error?.code??(thrown?failureCode(thrown):undefined),startedAt,finishedAt};
        const resultBytes=JSON.stringify(result,null,2)+"\n";await writeFile(join(dir,"result.json"),resultBytes,{flag:"wx"});
        database.appendModelEvaluationAttempt({schema:"proto-workbench.model-evaluation-attempt.v1",evaluationId,attemptId,caseId:task.id,caseRevision:"1",caseSha256:sha256(task),datasetSha256:frozen.sha256,referenceSha256:sha256(task.expected),scorerVersion:SCORER,...identity,toolSchemaSha256,promptTemplateSha256,startedAt,finishedAt,status,toolSelection:{result:"unscored"},execution:{result:result.validationPassed?"pass":"fail",effectState:entries.some(r=>r.state==="effect-unknown")?"effect-unknown":entries.some(r=>r.effect==="write"&&r.state==="completed")?"completed":"no-effect",recovery:checkpoint.recoveryCounters?.journalReconciliations?"reconciled":"not-needed",receiptSha256:sha256(resultBytes)},scientificAnswer:{result:"not-run"},...(result.failureCode?{failureCode:result.failureCode}:{})});
        records.push(result);onProgress({attempted:records.length,planned:60,arm,caseId:task.id,state:result.state,status});
      }
      if(signal.aborted||stop)break;
    }
    const report={...summarizeEvaluation(frozen.pack,records),campaignId,campaignSha256,taskPackSha256:frozen.sha256,identity,iteration,sourceHashes,budgets:manifest.budgets,sampling:manifest.sampling};await immutableJson(join(root,"report.json"),report);return report;
  }finally{database.close();}
}

/** Reopening verifies the ledger plus exact sidecar bytes. Interrupted starts are retained explicitly. */
export async function readEvaluationReport(out){
  const root=resolve(out),manifestBytes=await readFile(join(root,"campaign.json")),manifest=JSON.parse(manifestBytes),campaignSha256=sha256(manifestBytes),bytes=await readFile(join(root,"task-pack.json"));
  if(sha256(bytes)!==manifest.taskPackSha256)throw new Error("EVALUATION_PACK_DIGEST_MISMATCH");
  const pack=JSON.parse(bytes),db=new AppDatabase(join(root,"evaluation.sqlite")),records=[];
  try{
    const ledger=ARMS.flatMap(arm=>db.listModelEvaluationAttempts(`${manifest.campaignId}:${arm}`,1000)),ids=new Set();
    for(const attempt of ledger){
      if(!/^[a-f0-9-]{36}$/.test(attempt.attemptId))throw new Error("EVALUATION_ATTEMPT_ID_INVALID");
      const path=join(root,"attempts",attempt.attemptId,"result.json"),bytes=await readFile(path);if(sha256(bytes)!==attempt.execution.receiptSha256)throw new Error("EVALUATION_RESULT_DIGEST_MISMATCH");
      const record=JSON.parse(bytes),task=pack.tasks.find(t=>t.id===attempt.caseId);
      if(!task||record.attemptId!==attempt.attemptId||record.caseId!==attempt.caseId||record.taskPackSha256!==manifest.taskPackSha256||record.campaignSha256!==campaignSha256||attempt.caseSha256!==sha256(task)||attempt.referenceSha256!==sha256(task.expected)||attempt.datasetSha256!==manifest.taskPackSha256||attempt.instanceId!==manifest.identity.instanceId||attempt.modelFingerprint!==manifest.identity.modelFingerprint||attempt.runtimeFingerprint!==manifest.identity.runtimeFingerprint||attempt.toolSchemaSha256!==manifest.toolSchemaSha256||attempt.promptTemplateSha256!==manifest.promptTemplateSha256||attempt.evaluationId!==`${manifest.campaignId}:${record.arm}`||record.status!==attempt.status)throw new Error("EVALUATION_RESULT_IDENTITY_MISMATCH");records.push(record);ids.add(attempt.attemptId);
    }
    const interruptedStarts=[];
    for(const name of await readdir(join(root,"attempts"))){if(ids.has(name))continue;if(!/^[a-f0-9-]{36}$/.test(name))throw new Error("EVALUATION_ATTEMPT_ID_INVALID");const start=JSON.parse(await readFile(join(root,"attempts",name,"started.json"),"utf8"));const task=pack.tasks.find(t=>t.id===start.caseId);if(!task||start.attemptId!==name||start.campaignSha256!==campaignSha256||start.caseSha256!==sha256(task)||start.taskPackSha256!==manifest.taskPackSha256||start.identity.instanceId!==manifest.identity.instanceId||!ARMS.includes(start.arm))throw new Error("EVALUATION_START_IDENTITY_MISMATCH");interruptedStarts.push(start);records.push({attemptId:start.attemptId,arm:start.arm,caseId:start.caseId,status:"interrupted",state:"interrupted",validationPassed:false,toolCalls:null,externalToolCalls:null,tokens:null,wallTimeMs:null,duplicateEffects:null,duplicateWriteEffects:null,recovery:{},diagnosticClasses:{}});}
    return {...summarizeEvaluation(pack,records),campaignId:manifest.campaignId,campaignSha256,taskPackSha256:manifest.taskPackSha256,identity:manifest.identity,iteration:manifest.iteration,sourceHashes:manifest.sourceHashes,budgets:manifest.budgets,sampling:manifest.sampling,interruptedStarts,notes:[...summarizeEvaluation(pack,records).notes,"Unfinished start markers are disclosed as interrupted attempts; no historical ledger row is rewritten and missing usage is unknown."]};
  }finally{db.close();}
}
