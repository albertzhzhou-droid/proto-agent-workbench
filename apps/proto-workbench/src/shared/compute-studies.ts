import type { SchemaMigrationReport } from "./storage-migrations.ts";
import { z } from "zod";
import type { ComputeRequest, ComputeRun } from "./compute.ts";

const id=z.string().uuid(),runId=z.string().regex(/^[a-f0-9]{32}$/),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const name=z.string().trim().min(1).max(120),question=z.string().trim().max(8000),cursor=z.string().min(1).max(2048).optional();
export const ComputeStudiesRequestSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("list"),limit:z.number().int().min(1).max(50).optional(),cursor}).strict(),
  z.object({action:z.literal("create"),name,question}).strict(),
  z.object({action:z.literal("get"),studyId:id}).strict(),
  z.object({action:z.literal("update"),studyId:id,expectedRevision:revision,name,question}).strict(),
  z.object({action:z.literal("runs"),studyId:id.optional(),limit:z.number().int().min(1).max(30).optional(),cursor}).strict(),
  z.object({action:z.literal("link"),studyId:id,expectedRevision:revision,runId}).strict(),
  z.object({action:z.literal("unlink"),studyId:id,expectedRevision:revision,runId}).strict(),
  z.object({action:z.literal("open-run"),runId,studyId:id.optional()}).strict(),
]);
export type ComputeStudiesRequest=z.infer<typeof ComputeStudiesRequestSchema>;

/** Exact on-disk bindings captured at link time, never automatically rewritten. */
export interface ComputeStudyRunBinding {
  tool:string;createdAt:string;
  manifestSha256:string;provenanceSha256:string;inputSha256:string;resultSha256:string;
}
export interface ComputeStudyLink {runId:string;linkedAt:string;binding:ComputeStudyRunBinding}
export interface ComputeStudyHistoryEntry {
  revision:number;at:string;action:"create"|"update"|"link"|"unlink";
  name?:string;question?:string;runId?:string;binding?:ComputeStudyRunBinding;
}
export interface ComputeStudy {
  id:string;revision:number;name:string;question:string;createdAt:string;updatedAt:string;runCount:number;
  links:ComputeStudyLink[];history:ComputeStudyHistoryEntry[];
}
export type ComputeStudySummary=Omit<ComputeStudy,"links"|"history">;
export interface ComputeStudyIntegrity {
  status:"verified"|"damaged"|"unavailable"|"not-checked"|"unsupported-version"|"legacy-readonly";
  checkedAt:string;code:string;message:string;
  hashes?:Pick<ComputeStudyRunBinding,"manifestSha256"|"provenanceSha256"|"inputSha256"|"resultSha256">;
  /** Matching unsigned local bytes is not independent execution or scientific validation. */
  authority:"unsigned-local-artifacts";
}
export interface ComputeStudySourceDetail {
  name:string;path:string;expectedSha256:string;
  status:"current"|"changed"|"unavailable"|"not-checked";
  actualSha256?:string;code:string;message:string;
}
export interface ComputeStudySourceFreshness {
  status:"current"|"changed"|"unavailable"|"not-checked";
  checkedAt:string;details:ComputeStudySourceDetail[];
}
export interface ComputeStudyRunSummary {
  runId:string;tool?:string;createdAt?:string;linkedAt?:string;binding?:ComputeStudyRunBinding;
  integrity:ComputeStudyIntegrity;
}
export interface ComputeStudyOpenedRun extends ComputeStudyRunSummary {
  sourceFreshness:ComputeStudySourceFreshness;
  /** Both absent unless the full internal bundle and any study anchor verify. */
  request?:ComputeRequest;receipt?:ComputeRun;
}
export interface ComputeStudiesPage {
  nextCursor:string|null;generation:string;resetRequired?:boolean;indexingPending?:number;
  /** Discovery stopped at its safety bound; not a claim of a complete workspace census. */
  discoveryTruncated?:boolean;
}
export interface ComputeStudiesResponse {
  migrationReport?:SchemaMigrationReport;
  studies?:ComputeStudySummary[];runs?:ComputeStudyRunSummary[];study?:ComputeStudy;run?:ComputeStudyOpenedRun;
  page?:ComputeStudiesPage;
}
export const COMPUTE_STUDY_LIMITS={studies:200,links:64,history:128,studyBytes:2*1024*1024} as const;
