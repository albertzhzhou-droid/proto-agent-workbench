import { sha256Text } from "./sha256.ts";

export interface AlignmentRecord {name: string; sequence: string}
export interface ProteinStudyRow extends AlignmentRecord {
  ungapped_sequence: string; sequence_sha256: string; alignment_to_sequence: Array<number | null>;
}
export interface ProteinStudy {
  study_schema: "proto-agent.protein-comparison.v1";
  sequence_count: number; alignment_length: number; alignment: ProteinStudyRow[];
  conservation: {columns: Array<{position:number;consensus:string|null;conservation_fraction:number;occupancy_fraction:number;entropy_bits:number|null}>};
  phylogeny: {newick_tree:string;method:string;limitations:string[];tree_graph:ProteinTreeGraph} | null;
  limitations: string[];
}

export interface ProteinTreeGraph {
  nodes:Array<{id:number;name:string|null}>;
  edges:Array<{source:number;target:number;length:number}>;
  rooting:"arbitrary-display";
  display_root_edge:{source:number;target:number;length:number};
}

export function proteinTreeLayout(graph:ProteinTreeGraph, names:string[]) {
  if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||graph.nodes.length<4||graph.nodes.length>100||graph.rooting!=="arbitrary-display"
    ||!Array.isArray(names)||names.length<3||names.length>50||new Set(names).size!==names.length||names.some(name=>typeof name!=="string")) throw new Error("Invalid comparison tree.");
  if(graph.nodes.some(node=>!node||!Number.isSafeInteger(node.id)||node.id<0||node.id>=Number.MAX_SAFE_INTEGER
    ||(node.name!==null&&typeof node.name!=="string"))) throw new Error("Invalid tree identity.");
  const nodes=new Map(graph.nodes.map(node=>[node.id,node]));
  if(nodes.size!==graph.nodes.length||graph.edges.length!==nodes.size-1) throw new Error("Tree identities are not unique or connected.");
  const tips=graph.nodes.filter(node=>node.name!==null).map(node=>node.name);
  if(tips.length!==names.length||new Set(tips).size!==tips.length||names.some(name=>!tips.includes(name))) throw new Error("Tree tips do not match the alignment.");
  const root=graph.display_root_edge;
  if(!root)throw new Error("Tree display root is missing.");
  if(graph.edges.some(edge=>!edge||!Number.isSafeInteger(edge.source)||!Number.isSafeInteger(edge.target)
    ||!nodes.has(edge.source)||!nodes.has(edge.target)||edge.source===edge.target||!Number.isFinite(edge.length)||edge.length<0)) throw new Error("Invalid tree edge.");
  const edges=graph.edges.filter(edge=>!(edge.source===root.source&&edge.target===root.target||edge.target===root.source&&edge.source===root.target));
  if(edges.length!==graph.edges.length-1||!graph.edges.some(edge=>(edge.source===root.source&&edge.target===root.target||edge.target===root.source&&edge.source===root.target)&&edge.length===root.length)) throw new Error("Tree display root is not bound to an edge.");
  const rootId=Math.max(...nodes.keys())+1;
  nodes.set(rootId,{id:rootId,name:null});
  edges.push({source:rootId,target:root.source,length:root.length/2},{source:rootId,target:root.target,length:root.length/2});
  const adjacency=new Map<number,Array<{id:number;length:number}>>([...nodes.keys()].map(id=>[id,[]]));
  for(const edge of edges){
    if(!nodes.has(edge.source)||!nodes.has(edge.target)||edge.source===edge.target||!Number.isFinite(edge.length)||edge.length<0)throw new Error("Invalid tree edge.");
    adjacency.get(edge.source)!.push({id:edge.target,length:edge.length});adjacency.get(edge.target)!.push({id:edge.source,length:edge.length});
  }
  const positioned:Array<{id:number;name:string|null;x:number;y:number;depth:number;parent:number|null}>=[];
  const visited=new Set<number>();let leaf=0;
  const walk=(id:number,parent:number|null,x:number,depth:number):number=>{
    if(!Number.isFinite(x))throw new Error("Tree branch distances overflow the supported numeric range.");
    if(visited.has(id))throw new Error("Tree contains a cycle.");visited.add(id);
    const node=nodes.get(id)!,children=adjacency.get(id)!.filter(child=>child.id!==parent);
    if(node.name!==null&&children.length)throw new Error("Named tree tip has children.");
    if(node.name===null&&!children.length)throw new Error("Unlabelled tree tip.");
    const ys=children.map(child=>walk(child.id,id,x+child.length,depth+1));
    const y=ys.length?ys.reduce((sum,value)=>sum+value,0)/ys.length:24+(leaf++)*26;
    positioned.push({id,name:node.name,x,y,depth,parent});return y;
  };
  walk(rootId,null,0,0);
  if(visited.size!==nodes.size)throw new Error("Tree is disconnected.");
  const distance=Math.max(...positioned.map(node=>node.x));
  const scale=distance>0?"branch-length":"topology";
  const denominator=distance||Math.max(...positioned.map(node=>node.depth));
  return {nodes:positioned.map(node=>({...node,x:20+360*((distance>0?node.x:node.depth)/denominator)})),height:Math.max(100,leaf*26+25),scale};
}

export function parseProteinAlignment(text: string): AlignmentRecord[] {
  if (text.length > 18000) throw new Error("Alignment text exceeds 18,000 characters.");
  const rows: AlignmentRecord[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(">")) rows.push({name:line.slice(1).trim(),sequence:""});
    else {
      if (!rows.length) throw new Error("Start each protein with a >name FASTA header.");
      if (!/^[A-Za-z-]+$/.test(line)) throw new Error("Protein sequences must use ASCII amino-acid letters or '-' gaps before case normalization.");
      rows[rows.length - 1].sequence += line.toUpperCase();
    }
  }
  if (rows.length < 2 || rows.length > 50) throw new Error("Use 2 to 50 named proteins.");
  if (new Set(rows.map(row=>row.name)).size !== rows.length) throw new Error("Every protein needs a unique name.");
  for (const row of rows) {
    if (!row.name || [...row.name].length > 100 || /[\x00-\x1f\x7f]/.test(row.name)) throw new Error("Protein names need 1 to 100 printable characters.");
    if (!/^[ACDEFGHIKLMNPQRSTVWY-]{10,2000}$/.test(row.sequence) || !row.sequence.replaceAll("-", "")) {
      throw new Error(`${row.name}: use 10 to 2,000 standard amino acids or '-' gaps, with at least one residue.`);
    }
  }
  if (new Set(rows.map(row=>row.sequence.length)).size !== 1) throw new Error("Sequences must already be aligned to equal lengths. No padding is applied.");
  if (rows.reduce((total,row)=>total+row.sequence.length,0) > 10000) throw new Error("The full alignment is limited to 10,000 residues and gaps.");
  return rows;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function notes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(note=>typeof note === "string" && note.length <= 10000);
}

export function proteinStudy(value: Record<string, unknown>, expectedRecords?: unknown): ProteinStudy {
  if (!plainObject(value) || value.study_schema !== "proto-agent.protein-comparison.v1" || !Array.isArray(value.alignment)) throw new Error("Unrecognized protein study result.");
  if(value.alignment.some(row=>!plainObject(row)||typeof row.name!=="string"||typeof row.sequence!=="string"
    ||row.name!==row.name.trim()||/[\x00-\x1f\x7f]/.test(row.name)||!/^[ACDEFGHIKLMNPQRSTVWY-]{10,2000}$/.test(row.sequence))) throw new Error("Invalid study alignment records.");
  const records = value.alignment as ProteinStudyRow[];
  const parsed = parseProteinAlignment(records.map(row=>`>${row.name}\n${row.sequence}`).join("\n"));
  if (value.sequence_count !== parsed.length || value.alignment_length !== parsed[0].sequence.length) throw new Error("Study dimensions do not match the alignment.");
  for (const row of records) {
    const sequence=row.sequence.replaceAll("-", "");
    let index=0;
    const positions=[...row.sequence].map(residue=>residue === "-" ? null : index++);
    if (row.ungapped_sequence !== sequence || row.sequence_sha256 !== sha256Text(sequence)
      || JSON.stringify(row.alignment_to_sequence) !== JSON.stringify(positions)) throw new Error("Study residue coordinates or sequence digest do not match the supplied alignment.");
  }
  if(expectedRecords!==undefined){
    if(!Array.isArray(expectedRecords)||expectedRecords.length!==records.length||expectedRecords.some((expected,index)=>
      !plainObject(expected)||typeof expected.name!=="string"||typeof expected.sequence!=="string"
      ||!/^[A-Za-z-]{10,2000}$/.test(expected.sequence)
      ||expected.name!==records[index].name||expected.sequence.toUpperCase()!==records[index].sequence)) throw new Error("Saved study does not match the submitted protein alignment.");
  }
  if(!plainObject(value.coordinate_system)||value.coordinate_system.alignment_columns!=="1-based"
    ||value.coordinate_system.sequence_positions!=="0-based; null for gaps") throw new Error("Unsupported study coordinate system.");
  const study=value as unknown as ProteinStudy;
  if(!notes(study.limitations))throw new Error("Invalid study interpretation notes.");
  const conservation=value.conservation;
  if (!plainObject(conservation)||!Array.isArray(conservation.columns)||conservation.columns.length!==study.alignment_length
    ||conservation.sequence_count!==records.length||conservation.alignment_length!==study.alignment_length) throw new Error("Invalid conservation coordinates.");
  const consensus:string[]=[],conserved:number[]=[];
  const close=(actual:unknown,expected:number|null)=>expected===null?actual===null:typeof actual==="number"&&Number.isFinite(actual)&&Math.abs(actual-expected)<=1e-12;
  for(let i=0;i<study.alignment_length;i++){
    const counts=new Map<string,number>();
    for(const row of records){const residue=row.sequence[i];if(residue!=="-")counts.set(residue,(counts.get(residue)??0)+1);}
    const ranked=[...counts].sort(([a,ca],[b,cb])=>cb-ca||(a<b?-1:a>b?1:0));
    const observed=[...counts.values()].reduce((sum,count)=>sum+count,0);
    const top=ranked[0]?.[0]??null,score=(ranked[0]?.[1]??0)/records.length;
    const entropy=observed?[...counts.values()].reduce((sum,count)=>sum-(count/observed)*Math.log2(count/observed),0):null;
    const column:unknown=conservation.columns[i];
    if(!plainObject(column)||column.position!==i+1||column.consensus!==top||!close(column.conservation_fraction,score)
      ||!close(column.occupancy_fraction,observed/records.length)||!close(column.entropy_bits,entropy)
      ||!close(column.residue_identity_fraction,observed?(ranked[0][1]/observed):null)||column.gap_count!==records.length-observed) throw new Error("Conservation summary does not match the supplied alignment.");
    consensus.push(top??"-");if(score>0.8)conserved.push(i+1);
  }
  if(conservation.consensus!==consensus.join("")||JSON.stringify(conservation.conserved_positions)!==JSON.stringify(conserved)
    ||conservation.conserved_threshold!==0.8||conservation.threshold_comparison!==">"||conservation.position_basis!=="1-based alignment columns") throw new Error("Conservation summary uses unsupported coordinates or thresholds.");
  if ((records.length===2)!==(study.phylogeny===null)) throw new Error("Tree availability does not match the sequence count.");
  if (study.phylogeny !== null && (typeof study.phylogeny?.newick_tree !== "string" || study.phylogeny.newick_tree.length > 20000
    ||typeof study.phylogeny.method!=="string"||study.phylogeny.method.length>10000||!notes(study.phylogeny.limitations))) throw new Error("Invalid tree result.");
  if(study.phylogeny)proteinTreeLayout(study.phylogeny.tree_graph,records.map(row=>row.name));
  return study;
}

export function linkedProteinPosition(row: ProteinStudyRow, column: number,
  proteins: Array<{id:string;sequence:string;sequenceSha256:string}>) {
  if (!row||typeof row.sequence!=="string"||!/^[ACDEFGHIKLMNPQRSTVWY-]{10,2000}$/.test(row.sequence)
    ||row.ungapped_sequence!==row.sequence.replaceAll("-", "")||row.sequence_sha256!==sha256Text(row.ungapped_sequence)
    ||!Array.isArray(row.alignment_to_sequence)||row.alignment_to_sequence.length!==row.sequence.length
    ||!Number.isInteger(column) || column < 0 || column >= row.sequence.length||row.sequence[column]==="-") return undefined;
  const matches=proteins.filter(protein=>protein.id === row.name && protein.sequence === row.ungapped_sequence && protein.sequenceSha256 === row.sequence_sha256);
  const index=row.alignment_to_sequence[column];
  const expectedIndex=row.sequence.slice(0,column).replaceAll("-", "").length;
  return matches.length === 1 && Number.isInteger(index) && index===expectedIndex ? {proteinId:matches[0].id,start:index,end:index+1} : undefined;
}
