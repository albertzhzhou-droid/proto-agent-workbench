/** One chemistry execution contract for both Chat editions and Computation. */
import type {ChemScienceCatalog} from "./chem-science.ts";
export type {ChemScienceCatalog,ChemScienceOperator} from "./chem-science.ts";
export type ChemScienceRequest =
  | {action:"catalog"}
  | {action:"run";operator:string;input:Record<string,unknown>;runId?:string;timeoutMs?:number}
  | {action:"history";limit?:number}
  | {action:"read";runId:string}
  | {action:"cancel";runId:string};
export interface ChemScienceError {code:string;message:string;details?:unknown}
export interface ChemScienceRun {
  schema_version?:"proto-agent.chem-compute.v1";
  maturity?:{method_stage:"method-implementation";scientific_validation:"not-established";domain_validation:"not-established"};
  evidenceStanding?:import("./evidence-standing.ts").EvidenceStanding;
  runId:string;operator:string;status:"running"|"completed"|"error"|"cancelled"|"unverifiable"|"unsupported-version";
  createdAt:string;finishedAt?:string;input:Record<string,unknown>;result?:Record<string,unknown>;
  /** History metadata omits input and result bodies; use read for complete evidence. */
  summary?:boolean;
  provenance?:Record<string,unknown>;error?:ChemScienceError;
  artifacts:{input:string;result:string;manifest:string;computeManifest?:string};
  hashes?:{input:string;result:string;computeManifest?:string};
}
export interface ChemScienceResponse<T = ChemScienceCatalog|ChemScienceRun|{runs:ChemScienceRun[]}> {
  ok:boolean;data?:T;error?:ChemScienceError;
}
export interface ChemScienceApi {request(input:ChemScienceRequest):Promise<ChemScienceResponse>}
