import {z} from "zod";
import {sha256Text} from "./sha256.ts";

export const MAX_PREDICTION_RESIDUES=384;
const BF_TOLERANCE=0.0100001, PAE_MAX_TOLERANCE=0.0050001;
const finite=z.number().finite(), sha=z.string().regex(/^[a-f0-9]{64}$/);
const text=(max:number)=>z.string().max(max).refine(value=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const chain=z.string().regex(/^[A-Za-z0-9]?$/), sequence=z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]{1,384}$/);
const index=z.number().int().min(0).max(MAX_PREDICTION_RESIDUES);
const plddt=finite.min(0).max(100), paeValue=finite.min(0).max(1000);
const sourcePath=z.string().min(1).max(400).transform(value=>value.replaceAll("\\","/")).refine(value=>
  !/[\x00-\x1f\x7f:]/.test(value)&&!value.startsWith("/")&&value.split("/").every(part=>part!==""&&part!=="."&&part!==".."),"Use an unambiguous workspace-relative path.");
const source=z.object({path:sourcePath,sha256:sha,size_bytes:z.number().int().min(1)}).strict();
const residueIdentity=z.object({model:z.number().int().min(1).max(9999),chain,residue_number:z.number().int().min(1).max(9999),
  insertion_code:z.literal(""),alternate_location:z.literal(""),residue_name:z.string().regex(/^[A-Z]{3}$/),
  one_letter:z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]$/),occupancy:finite.gt(0).max(1)}).strict();
const scalar=z.discriminatedUnion("status",[
  z.object({status:z.literal("available"),value:finite.min(0).max(1),unit:z.literal("score-0-1"),source_field:z.enum(["/ptm","/iptm"])}).strict(),
  z.object({status:z.literal("unavailable"),value:z.null(),reason:text(1000)}).strict(),
]);
const pae=z.discriminatedUnion("status",[
  z.object({status:z.literal("available"),unit:z.literal("angstrom"),values:z.array(z.array(paeValue).min(1).max(MAX_PREDICTION_RESIDUES)).min(1).max(MAX_PREDICTION_RESIDUES),
    shape:z.tuple([index,index]),source_field:z.literal("/pae"),observed_matrix_max:paeValue,reported_max_pae:paeValue.nullable(),
    max_pae_rounding_tolerance:z.literal(PAE_MAX_TOLERANCE),axis_mapping:z.literal("Both axes index residues in the returned PDB order; producer row/column orientation is preserved without transposition or symmetrization.")}).strict(),
  z.object({status:z.literal("unavailable"),unit:z.literal("angstrom"),reason:text(1000),values:z.null()}).strict(),
]);
const resultSchema=z.object({
  schema_version:z.literal("proto-agent.structure-prediction-import.v1"),operation:z.literal("result-import"),prediction_execution:z.literal("not-performed"),
  scope:z.literal("local-result-import-only; predictor confidence is not experimental validation"),
  sources:z.object({structure_path:source,scores_path:source}).strict(),
  structure:z.object({format:z.literal("colabfold-pdb-import-profile"),coordinate_unit:z.literal("angstrom"),model:z.number().int().min(1).max(9999),
    residue_count:z.number().int().min(1).max(MAX_PREDICTION_RESIDUES),chain_count:z.number().int().min(1).max(63),
    chains:z.array(z.object({chain,model:z.number().int().min(1).max(9999),sequence,sequence_sha256:sha,start_index:index,stop_index:index,residue_count:z.number().int().min(1).max(MAX_PREDICTION_RESIDUES)}).strict()).min(1).max(63),
    residues:z.array(z.object({index,identity:residueIdentity,coordinates_angstrom:z.tuple([finite.min(-1e6).max(1e6),finite.min(-1e6).max(1e6),finite.min(-1e6).max(1e6)]),
      plddt,pdb_ca_bfactor_plddt:plddt,plddt_source_pointer:z.string().max(20)}).strict()).min(1).max(MAX_PREDICTION_RESIDUES)}).strict(),
  confidence:z.object({source:z.literal("scores_path"),interpretation:z.literal("predictor-confidence-not-experimental-validation"),
    plddt:z.object({status:z.literal("available"),unit:z.literal("score-0-100"),source_field:z.literal("/plddt"),values:z.array(plddt).min(1).max(MAX_PREDICTION_RESIDUES),mean:plddt,minimum:plddt,maximum:plddt}).strict(),
    pae,ptm:scalar,iptm:scalar}).strict(),
  mapping:z.object({index_base:z.literal(0),order:z.literal("PDB ATOM residue encounter order, grouped in contiguous chains; not author-residue-number indexing"),
    expected_sequence_status:z.enum(["exact-match-uppercase-normalized","not-supplied"]),bfactor_plddt_status:z.literal("consistent-within-rounding"),
    bfactor_plddt_tolerance:z.literal(BF_TOLERANCE),same_prediction_provenance:z.literal("unestablished")}).strict(),
  unimported_score_fields:z.array(text(128)).max(100),diagnostics:z.array(z.object({code:z.string().regex(/^[A-Z_]{1,100}$/),message:text(4000)}).strict()).max(100),
  limitations:z.array(text(4000)).min(1).max(100),
}).strict();
export type StructurePrediction=z.infer<typeof resultSchema>;
export type PredictionResidue=StructurePrediction["structure"]["residues"][number];
const AMINO_ACIDS:Record<string,string>=Object.fromEntries("ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL".split(" ").map((name,i)=>[name,"ARNDCQEGHILKMFPSTWYV"[i]]));
const requestSchema=z.object({structure_path:sourcePath,scores_path:sourcePath,
  expected_chains:z.array(z.object({chain,sequence:z.string().regex(/^[ACDEFGHIKLMNPQRSTVWYacdefghiklmnpqrstvwy]{1,384}$/)}).strict()).min(1).max(62).optional()}).strict();
const receiptSchema=z.object({ok:z.literal(true),tool:z.literal("import_colabfold_result"),run_id:z.string().regex(/^[a-f0-9]{32}$/),result_sha256:sha,
  preview:z.literal(false).optional(),inputs:z.record(z.string(),z.unknown())});
const previewReceiptSchema=z.object({ok:z.literal(true),tool:z.literal("import_colabfold_result"),preview:z.literal(true),result:z.record(z.string(),z.unknown())}).strict();
const fileClaim=z.object({path:sourcePath,sha256:sha});
const fail=(message:string):never=>{throw new Error(message);};

/** Call after readVerifiedComputeResult has reopened and hashed the full result.
 * This checks rendering contracts and receipt association, not prediction quality. */
export function validateStructurePrediction(value:unknown,requested:unknown,receipt:unknown):StructurePrediction {
  const preview=typeof receipt==="object"&&receipt!==null&&"preview" in receipt&&receipt.preview===true;
  const parsed=resultSchema.safeParse(value),request=requestSchema.safeParse(requested),run=receiptSchema.safeParse(receipt);
  if(!parsed.success||!request.success||(!preview&&!run.success)||(preview&&!previewReceiptSchema.safeParse(receipt).success))fail("The saved structure import, request or execution receipt has an unsupported or malformed contract.");
  const result=parsed.data!,args=request.data!;
  for(const field of ["structure_path","scores_path"] as const) {
    const source=result.sources[field];
    if(source.path!==args[field])fail("Structure import source paths do not match the requested files.");
    if(!preview) {
      const claim=fileClaim.safeParse(run.data!.inputs[`file:${field}`]);
      if(!claim.success||source.path!==claim.data.path||source.sha256!==claim.data.sha256)fail("Structure import source paths or SHA256 digests do not match the request and execution receipt.");
    }
    if(source.size_bytes>(field==="structure_path"?2:4)*1024*1024||!source.path.toLowerCase().endsWith(field==="structure_path"?".pdb":".json"))fail("Structure import source size or file type exceeds its bounded profile.");
  }
  const {structure,confidence,mapping}=result,n=structure.residue_count,values=confidence.plddt.values;
  if(structure.residues.length!==n||values.length!==n||structure.chains.length!==structure.chain_count||new Set(structure.chains.map(item=>item.chain)).size!==structure.chain_count)fail("Structure confidence dimensions or chain identities do not match.");
  let offset=0;
  for(const item of structure.chains) {
    if(item.model!==structure.model||item.start_index!==offset||item.stop_index!==offset+item.residue_count||item.sequence.length!==item.residue_count||item.sequence_sha256!==sha256Text(item.sequence))fail("Chain intervals, sequence or model identity do not match.");
    const residues=structure.residues.slice(item.start_index,item.stop_index);
    if(residues.length!==item.residue_count)fail("Chain interval exceeds the residue mapping.");
    for(const [local,residue] of residues.entries()) {
      const identity=residue.identity,position=offset+local;
      if(residue.index!==position||identity.model!==structure.model||identity.chain!==item.chain||identity.one_letter!==item.sequence[local]
        ||AMINO_ACIDS[identity.residue_name]!==identity.one_letter||identity.residue_number!==residues[0].identity.residue_number+local
        ||residue.plddt!==values[position]||residue.plddt_source_pointer!==`/plddt/${position}`
        ||Math.abs(residue.plddt-residue.pdb_ca_bfactor_plddt)>BF_TOLERANCE)fail("A residue identity, index or pLDDT value is inconsistent with its source mapping.");
    }
    offset=item.stop_index;
  }
  if(offset!==n)fail("Chain intervals do not cover the complete residue mapping.");
  if(Math.abs(confidence.plddt.mean-values.reduce((sum,value)=>sum+value,0)/n)>1e-9||confidence.plddt.minimum!==Math.min(...values)||confidence.plddt.maximum!==Math.max(...values))fail("pLDDT summaries do not match the per-residue values.");
  if(args.expected_chains) {
    if(mapping.expected_sequence_status!=="exact-match-uppercase-normalized"||args.expected_chains.length!==structure.chains.length||args.expected_chains.some((item,i)=>item.chain!==structure.chains[i].chain||item.sequence.toUpperCase()!==structure.chains[i].sequence))fail("Expected chain sequences do not match the saved import.");
  } else if(mapping.expected_sequence_status!=="not-supplied")fail("Independent sequence comparison was not requested.");
  const matrix=confidence.pae;
  if(matrix.status==="available") {
    if(matrix.shape[0]!==n||matrix.shape[1]!==n||matrix.values.length!==n||matrix.values.some(row=>row.length!==n))fail("PAE matrix dimensions do not match the residue mapping.");
    const maximum=Math.max(...matrix.values.map(row=>Math.max(...row)));
    if(matrix.observed_matrix_max!==maximum||(matrix.reported_max_pae!==null&&Math.abs(matrix.reported_max_pae-maximum)>PAE_MAX_TOLERANCE))fail("PAE maximum does not match the original matrix.");
  }
  for(const field of ["ptm","iptm"] as const)if(confidence[field].status==="available"&&confidence[field].source_field!==`/${field}`)fail("Scalar confidence metric points to a different source field.");
  return result;
}

export function predictionResidueLabel(residue:PredictionResidue):string {
  const id=residue.identity;
  return `index ${residue.index} · model ${id.model} · chain ${id.chain||"(blank)"} · ${id.residue_name} ${id.residue_number} (${id.one_letter})`;
}
export function predictionPaeCell(result:StructurePrediction,row:number,column:number) {
  if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0||row>=result.structure.residue_count||column>=result.structure.residue_count)throw new Error("Choose a valid zero-based PAE row and column.");
  const pae=result.confidence.pae;
  if(pae.status!=="available")return undefined;
  return {row,column,value:pae.values[row][column],rowResidue:result.structure.residues[row],columnResidue:result.structure.residues[column]};
}

/** One pixel per original matrix[row][column], row-major; never symmetrized. */
export function predictionPaePixels(result:StructurePrediction):Uint8ClampedArray|undefined {
  const pae=result.confidence.pae;if(pae.status!=="available")return undefined;
  const n=result.structure.residue_count,bytes=new Uint8ClampedArray(n*n*4),maximum=pae.observed_matrix_max;
  for(let row=0;row<n;row++)for(let col=0;col<n;col++) {
    const mix=maximum===0?0:pae.values[row][col]/maximum,offset=(row*n+col)*4;
    bytes[offset]=Math.round(22+mix*(244-22));bytes[offset+1]=Math.round(78+mix*(238-78));bytes[offset+2]=Math.round(99+mix*(223-99));bytes[offset+3]=255;
  }
  return bytes;
}
