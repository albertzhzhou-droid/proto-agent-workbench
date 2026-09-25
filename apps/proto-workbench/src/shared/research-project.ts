import { z } from "zod";

/** Project storage is a host-owned authority for research specifications and plans. */
export const RESEARCH_PROJECT_SCHEMA_VERSION = 2;
export const RESEARCH_PROJECT_LIMITS = {
  objectBytes: 512 * 1024 * 1024,
  valueBytes: 4 * 1024 * 1024,
  rangeBytes: 1024 * 1024,
  legacyFiles: 128,
  legacyTotalBytes: 512 * 1024 * 1024,
  capsuleBytes: 24 * 1024 * 1024,
  capsuleVersions: 200,
  capsuleObjects: 1000,
  versionReferences: 128,
  pageSize: 100,
} as const;

export const ResearchObjectIdentitySchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(RESEARCH_PROJECT_LIMITS.objectBytes),
}).strict();
export type ResearchObjectIdentity = z.infer<typeof ResearchObjectIdentitySchema>;
export const ResearchVersionKindSchema = z.enum(["study-spec", "research-plan", "run-evidence", "evidence-graph"]);
export type ResearchVersionKind = z.infer<typeof ResearchVersionKindSchema>;
export const ResearchIdentitySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const ResearchVersionRecordSchema = z.object({
  studyId: ResearchIdentitySchema,
  kind: ResearchVersionKindSchema,
  versionId: ResearchIdentitySchema,
  object: ResearchObjectIdentitySchema,
  references: z.array(ResearchObjectIdentitySchema).max(RESEARCH_PROJECT_LIMITS.versionReferences).default([]),
  parentVersionId: ResearchIdentitySchema.nullable(),
  createdAt: z.string().datetime(),
  origin: z.enum(["local", "imported-unverified"]),
}).strict();
export type ResearchVersionRecord = z.infer<typeof ResearchVersionRecordSchema>;
export type ResearchOpenedVersion = ResearchVersionRecord & { value: unknown };
export type ResearchVersionPage = { items: ResearchOpenedVersion[]; nextCursor: string | null };
export type ResearchObjectRange = {
  identity: ResearchObjectIdentity;
  offset: number;
  length: number;
  dataBase64: string;
  rangeSha256: string;
  integrity: "verified";
};
export type ResearchProjectStatus = {
  schemaVersion: number;
  supportedSchemaVersion: number;
  readOnly: boolean;
  authority: "research-versions-no-execution-grants";
  database: ".proto/project.sqlite";
};
export type ResearchLegacyFile = { path: string; identity?: string; expectedSha256?: string };
export type ResearchLegacyInventoryItem = { path: string; identity: string; object: ResearchObjectIdentity };
export type ResearchLegacyImportReport = {
  sourceId: string;
  inventorySha256: string;
  importedAt: string;
  files: ResearchLegacyInventoryItem[];
  parity: {
    bytes: "verified";
    originalIdentity: "preserved";
    projection: "not-evaluated";
    legacyWriteAuthority: "unchanged";
    cutover: false;
  };
  idempotent: boolean;
};

export const ResearchCapsuleSchema = z.object({
  schemaVersion: z.literal("proto.research-version-capsule.v1"),
  mode: z.enum(["manifest-only", "full"]),
  scope: z.literal("research-versions-and-evidence-snapshots"),
  createdAt: z.string().datetime(),
  authority: z.literal("imported-unverified-no-execution-or-review-grants"),
  versions: z.array(ResearchVersionRecordSchema).max(RESEARCH_PROJECT_LIMITS.capsuleVersions),
  objects: z.array(z.object({ identity: ResearchObjectIdentitySchema, dataBase64: z.string().optional() }).strict()).max(RESEARCH_PROJECT_LIMITS.capsuleObjects),
  heads: z.array(z.object({ studyId: ResearchIdentitySchema, kind: ResearchVersionKindSchema, versionId: ResearchIdentitySchema }).strict()).max(RESEARCH_PROJECT_LIMITS.capsuleVersions),
}).strict();
export type ResearchCapsule = z.infer<typeof ResearchCapsuleSchema>;
export type ResearchCapsuleImportReport = {
  mode: "manifest-only" | "full";
  versions: number;
  registered: number;
  integrity: "verified" | "manifest-only-objects-unavailable";
  authority: "imported-unverified-no-execution-or-review-grants";
};
