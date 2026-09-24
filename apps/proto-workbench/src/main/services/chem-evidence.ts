import {createHash} from "node:crypto";
import type {ChemScienceRun} from "../../shared/chem-science-api.ts";
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");

/** The same pointer/value-index shape as compute.v1, without inferring units. */
export function chemistryValueIndex(worker:Record<string,unknown>) {
  const entries:Array<Record<string,unknown>>=[];let valueCount=0,indexBytes=0;
  const visit=(value:unknown,pointer:string,depth:number)=>{
    if(depth>64)throw new Error("CHEM_RESULT_DEPTH_EXCEEDED");
    if(typeof value==="number") {
      if(!Number.isFinite(value))throw new Error("CHEM_RESULT_NONFINITE");
      valueCount++;
      const entry={pointer,json_type:Number.isInteger(value)?"integer":"number",value,value_sha256:sha(JSON.stringify(value)),quantity:null};
      const bytes=Buffer.byteLength(JSON.stringify(entry));
      if(entries.length<10_000&&pointer.length<=2048&&indexBytes+bytes<=2*1024*1024){entries.push(entry);indexBytes+=bytes;}
    } else if(Array.isArray(value))value.forEach((item,index)=>visit(item,`${pointer}/${index}`,depth+1));
    else if(value&&typeof value==="object")for(const [key,item] of Object.entries(value))visit(item,`${pointer}/${key.replaceAll("~","~0").replaceAll("/","~1")}`,depth+1);
  };
  visit(worker.result,"/result",0);
  return {schema_version:"proto.compute-value-index.v1",status:entries.length===valueCount?"complete":"partial",value_count:valueCount,indexed_count:entries.length,omitted_count:valueCount-entries.length,index_bytes:indexBytes,entries};
}

export function chemistryComputeManifest(run:ChemScienceRun,worker:Record<string,unknown>) {
  return {schema_version:"proto-agent.compute.v1",backend:"chemistry",ok:run.status==="completed",run_id:run.runId,tool:`chemistry.${run.operator}`,created_at:run.createdAt,
    implementation:"chem-integration",implementation_version:1,
    maturity:{schema_version:"proto.compute-maturity.v1",method_stage:run.maturity?.method_stage??"not-established",scientific_validation:"not-established",domain_validation:"not-established",applicability:["Fixed local chemistry software calculation"],known_limitations:["Numeric pointers do not assign units or scientific meaning; supplied units remain in the complete input and result."],evidence:[],assessment_basis:"Method metadata only; this run does not establish scientific validity.",availability_is_separate:true,automatic_promotion:false},
    evidenceStanding:run.evidenceStanding,result_value_index:chemistryValueIndex(worker),
    inputs:{request:{path:run.artifacts.input,sha256:run.hashes?.input}},artifacts:[run.artifacts.result],result_sha256:run.hashes?.result,
    runtime:worker.provenance??{},review_status:"human_review_required",scope:"Software-only chemistry evidence; method and domain validity are not established."};
}
