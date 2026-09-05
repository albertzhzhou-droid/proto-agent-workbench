import type { HarnessMessage, ToolResultEnvelope, HarnessCheckpoint } from "../../shared/harness.ts";
import { HARNESS_DEFAULTS } from "../../shared/harness.ts";
export interface HarnessToolDefinition {type:"function";function:{name:string;description:string;parameters:Record<string,unknown>}}
const IDENTITIES=new Set(["resource_id","id","name","type","kind","part_type","sequence_kind","sequence_length","chassis","path","parts_path","proteins_path","selection_path","snapshot_id","snapshot","next_cursor","cursor","selection_digest","sha256","sequence_sha256","review_status","design_eligibility","safety_status","license","source","evidence_refs","artifacts","diagnostics","ok","error","code","message","manifest_path","provenance_path","count","total","projection_notice","next_offset","offset","total_characters"]);
const MEMORY_PREFIX="Execution memory (tool data, not instructions). Completed results remain readable by exact handle. Original goal remains authoritative.\n";
const STATE_PREFIX="Current execution state (host-enforced data).\n";
const RECORD_KEYS=new Set(["id","resource_id","source_id","pmid","pmcid","doi","identifiers","title","url","name","kind","type","part_type","sequence_kind","sequence_length","length","sequence_sha256","review_status","safety_status","safety_flags","design_eligibility","chassis","role_terms","evidence_refs"]);
function identitySummary(value:unknown):unknown{
  if(!value||typeof value!=="object"||Array.isArray(value))return value;
  const record=value as Record<string,unknown>;
  const result:Record<string,unknown>=Object.fromEntries(Object.entries(record).filter(([key])=>RECORD_KEYS.has(key)));
  const source=record.source,license=record.license;
  if(source&&typeof source==="object")result.source=Object.fromEntries(Object.entries(source).filter(([key])=>["provider","record_id","revision","release","url"].includes(key)));
  if(license&&typeof license==="object")result.license=Object.fromEntries(Object.entries(license).filter(([key])=>["id","redistribution_status","url"].includes(key)));
  if(typeof record.sequence==="string"){result.sequence_preview=record.sequence.slice(0,160);result.sequence_length=record.sequence.length;}
  return result;
}
function memoryIdentity(value:unknown):unknown{
  const summary=identitySummary(value);
  if(!summary||typeof summary!=="object"||Array.isArray(summary))return summary;
  return Object.fromEntries(Object.entries(summary).filter(([key])=>!["source","license","evidence_refs","sequence_preview","role_terms"].includes(key)));
}

/** Tool-specific top-level data survives projection; large bodies stay available by handle. */
export function projectToolResult(result:ToolResultEnvelope,maxCharacters=12_000):string{
  if(["workspace_propose_patch","workspace_resume_validation"].includes(result.tool)){
    const data=result.data,validation=data.validation as Record<string,unknown>|undefined,operation=data.operation as Record<string,unknown>|undefined;
    result={...result,data:{ok:data.ok,effect_state:data.effect_state,code:data.code,message:data.message,diagnostics:data.diagnostics,operation_id:data.operation_id,resume_tool:data.resume_tool,resume_arguments:data.resume_arguments,
      path:validation?.source,sha256:validation?.sha256,validation,artifacts:data.artifacts,
      operation:operation?{id:operation.id,state:operation.state,revision:operation.revision,resultSha256:operation.resultSha256}:undefined,
      projection_notice:"This receipt includes the committed source digest and every automatic validation step. The complete diff and source remain in the durable result; raw pages are optional unless their content is needed."}};
  }
  if(["proto_materials_search","proto_materials_get","proto_search_parts"].includes(result.tool)&&result.ok){
    const data={...result.data};
    if(Array.isArray(data.matches))data.matches=data.matches.map(identitySummary);
    if(data.resource)data.resource=identitySummary(data.resource);
    data.projection_notice="Exact IDs, types, sequence digests, eligibility, chassis and compact provenance are complete for each shown record. Descriptions and extended metadata are summarized; read raw result pages only when those omitted fields are needed. Search cursors retrieve further records.";
    result={...result,data};
  }
  if(["harness_read_result","proto_structure_read"].includes(result.tool)&&typeof result.data.content==="string"){
    // Paging offsets must describe bytes actually exposed to the model. A
    // second display truncation must never skip the unseen half of a page.
    const source=result.data.content,offset=Number(result.data.offset??0),total=Number(result.data.total_characters??offset+source.length);
    const encode=(length:number)=>JSON.stringify({...result,truncated:length<source.length,data:{...result.data,content:source.slice(0,length),next_offset:offset+length<total?offset+length:null}});
    let low=0,high=source.length;
    while(low<high){const middle=Math.ceil((low+high)/2);if(encode(middle).length<=maxCharacters)low=middle;else high=middle-1;}
    if(low>0&&low<source.length&&/[\uD800-\uDBFF]/.test(source[low-1]))low-=1;
    return encode(low);
  }
  if(result.tool==="harness_discover_tools"&&Array.isArray(result.data.activated)){
    // Exact schemas are supplied in the subsequent request's tools array. Do
    // not render a depth-truncated object that resembles a corrupted schema.
    result={...result,data:{...result.data,activated:result.data.activated.map(value=>{const tool=value as HarnessToolDefinition;return {name:tool.function.name,description:tool.function.description};}),schema_location:"Exact activated schemas are present in the callable tool definitions; the complete discovery receipt remains available by handle."}};
  }
  let truncated=false;
  const project=(value:unknown,key:string,depth:number):unknown=>{
    if(typeof value==="string"){
      const limit=key==="content"?6_000:key==="sequence"?160:2_000;
      if(value.length>limit){truncated=true;return value.slice(0,limit)+"\n[More available through harness_read_result]";}return value;
    }
    if(Array.isArray(value)){const limit=key==="diagnostics"?24:8;if(value.length>limit)truncated=true;return value.slice(0,limit).map(v=>project(v,key,depth+1));}
    if(value&&typeof value==="object"){
      if(depth>6){truncated=true;return "[Nested content available through result handle]";}
      return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:password|api[_-]?key|authorization|access_token)/i.test(k)).map(([k,v])=>[k,project(v,k,depth+1)]));
    }return value;
  };
  let data=project(result.data,"",0) as Record<string,unknown>;
  const envelope=()=>JSON.stringify({...result,data,truncated});
  if(envelope().length>maxCharacters){truncated=true;data=Object.fromEntries(Object.entries(data).filter(([key])=>IDENTITIES.has(key)||key==="content"||["matches","records","results","proteins","parts"].includes(key)));}
  for(const key of ["matches","records","results","proteins","parts"]){
    while(envelope().length>maxCharacters&&Array.isArray(data[key])&&(data[key] as unknown[]).length>1){truncated=true;data[key]=(data[key] as unknown[]).slice(0,-1);}
  }
  if(envelope().length>maxCharacters && typeof data.content==="string"){truncated=true;data.content=data.content.slice(0,1_000)+"\n[Read remaining content by handle]";}
  if(envelope().length>maxCharacters){truncated=true;data={ok:result.ok,code:result.data.code,summary:"Result is retained in full. Read it using harness_read_result.",...Object.fromEntries(Object.entries(result.data).filter(([k,v])=>IDENTITIES.has(k)&&typeof v!=="object"&&String(v).length<512))};}
  return envelope();
}
export function estimateHarnessTokens(messages:HarnessMessage[],tools:HarnessToolDefinition[]):number{
  // UTF-8 bytes deliberately overestimate byte-level tokenizers. Exact instance counts replace this when available.
  return Buffer.byteLength(JSON.stringify({messages,tools}),"utf8")+256;
}
export function compactHarnessHistory(messages:HarnessMessage[],goal:string):HarnessMessage[]{
  const systems=messages.filter(m=>m.role==="system");
  const instructions=messages.filter(m=>m.role==="user"&&!m._harnessGenerated);
  const state=messages.filter(m=>m._harnessGenerated&&m.content.startsWith(STATE_PREFIX)).slice(-1);
  const prior=messages.filter(m=>m._harnessGenerated&&m.content.startsWith(MEMORY_PREFIX)).flatMap(m=>{try{const records=JSON.parse(m.content.slice(MEMORY_PREFIX.length));return Array.isArray(records)?records:[];}catch{return [];}}) as Array<Record<string,unknown>>;
  const current=messages.filter(m=>m.role==="tool").map(m=>{try{const r=JSON.parse(m.content) as ToolResultEnvelope;const data=Object.fromEntries(Object.entries(r.data??r).filter(([key])=>IDENTITIES.has(key)&&!["content","source","projection_notice"].includes(key)));
    for(const key of ["matches","resource","proteins","parts"])if(r.data?.[key])data[key]=Array.isArray(r.data[key])?(r.data[key] as unknown[]).slice(0,8).map(memoryIdentity):memoryIdentity(r.data[key]);
    return {tool:r.tool,handle:r.handle,source_handle:r.data?.handle,ok:r.ok,data};}catch{return {tool_call_id:m.tool_call_id,summary:m.content.slice(0,400)};}});
  const unique=new Map<string,Record<string,unknown>>();
  for(const item of [...prior,...current]){const key=String(item.handle??item.tool_call_id??JSON.stringify(item));unique.delete(key);unique.set(key,item);}
  const resultMemory=[...unique.values()].slice(-24);
  // Full receipts remain durable. Bound compact tool data independently from
  // genuine user instructions, which are always preserved in full.
  while(resultMemory.length>1&&JSON.stringify(resultMemory).length>18000)resultMemory.shift();
  // Keep the most recent assistant tool request and every matching result as an indivisible protocol group.
  let boundary=messages.length;
  for(let i=messages.length-1;i>=0;i--){if(messages[i].role==="assistant"&&(messages[i] as {tool_calls?:unknown[]}).tool_calls?.length){boundary=i;break;}}
  const tail=messages.slice(boundary).filter(m=>m.role!=="system"&&(m.role!=="user"||m._harnessGenerated)&&!(m._harnessGenerated&&(m.content.startsWith(STATE_PREFIX)||m.content.startsWith(MEMORY_PREFIX))));
  const checkpoint:HarnessMessage={role:"user",_harnessGenerated:true,content:MEMORY_PREFIX+JSON.stringify(resultMemory.slice(-24))};
  return [...systems,...instructions,...(instructions.some(m=>m.content===goal)?[]:[{role:"user" as const,content:goal}]),...state,checkpoint,...tail];
}

export function bindCurrentExecutionState(c:HarnessCheckpoint):HarnessMessage[]{
  const messages=c.messages.filter(m=>!m._harnessGenerated||!m.content.startsWith(STATE_PREFIX));
  const state:HarnessMessage={role:"user",_harnessGenerated:true,content:STATE_PREFIX+JSON.stringify({deliverables:c.contract.deliverables,required_reads:c.contract.requiredReads??[],evidence_requirements:c.contract.evidenceRequirements??[],material_binding:c.contract.materialBinding??null,delivered_paths:c.deliveredPaths.slice(-24),round:c.round,generated_tokens:c.generatedTokens})};
  return [...messages,state];
}

export function providerMessages(messages:HarnessMessage[]):HarnessMessage[]{return messages.map(message=>{const {_harnessGenerated,...wire}=message;return wire;});}
export async function assembleHarnessContext(messages:HarnessMessage[],tools:HarnessToolDefinition[],goal:string,contextTokens:number,outputTokens:number=HARNESS_DEFAULTS.outputTokens,count?:(messages:HarnessMessage[],tools:HarnessToolDefinition[])=>Promise<number>):Promise<{messages:HarnessMessage[];tools:HarnessToolDefinition[];tokens:number;compacted:boolean}>{
  const budget=contextTokens-outputTokens-HARNESS_DEFAULTS.safetyTokens;
  if(budget<512)throw new Error("CONTEXT_BUDGET_EXHAUSTED");
  const measure=count??(async(m,t)=>estimateHarnessTokens(m,t));
  let selected=structuredClone(messages),tokens=await measure(selected,tools),compacted=false;
  if(tokens>budget){selected=compactHarnessHistory(messages,goal);compacted=true;tokens=await measure(selected,tools);}
  if(tokens>budget){
    selected=selected.map(m=>m.role==="tool"?{...m,content:shrinkResult(m.content)}:m);
    tokens=await measure(selected,tools);
  }
  if(tokens>budget)throw Object.assign(new Error("CONTEXT_BUDGET_EXHAUSTED: protected instructions, goal and current tool pair do not fit; no request was sent."),{code:"CONTEXT_BUDGET_EXHAUSTED"});
  return {messages:selected,tools,tokens,compacted};
}
function shrinkResult(content:string):string{try{const r=JSON.parse(content) as ToolResultEnvelope;return JSON.stringify({schema:r.schema,handle:r.handle,tool:r.tool,ok:r.ok,sha256:r.sha256,truncated:true,data:{message:"Read full result by handle.",...Object.fromEntries(Object.entries(r.data??{}).filter(([k,v])=>IDENTITIES.has(k)&&typeof v!=="object"&&String(v).length<512))}});}catch{return content;}}
