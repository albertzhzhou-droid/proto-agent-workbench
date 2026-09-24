export interface SchemaMigrationReport {
  namespace: string;
  checkedAt: string;
  entries: Array<{ version: number; sha: string; appliedAt: string; status: "applied" | "verified" }>;
}
