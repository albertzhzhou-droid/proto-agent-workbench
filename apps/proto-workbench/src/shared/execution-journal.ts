import type { PolicyDecision, PolicySurface } from "./tool-policy.ts";
import type { SchemaMigrationReport } from "./storage-migrations.ts";

export interface JournalRecord {
  operationId: string;
  runId: string;
  scope: { surface: PolicySurface; scopeId: string; parentOperationId?: string };
  tool: string;
  capabilityId?: string | null;
  effect: "read" | "write";
  argumentsSha256: string;
  state: "intent" | "dispatched" | "no-effect" | "effect-unknown" | "completed" | "reconciled-applied" | "reconciled-not-applied";
  outcome?: "ok" | "tool-error";
  decisionId?: string;
  decision?: PolicyDecision;
  createdAt: string;
  updatedAt: string;
  receipt?: Record<string, unknown>;
}

export interface JournalReconciliation {
  id: string;
  operationId: string;
  verdict: "applied" | "not-applied";
  actor: string;
  evidenceRef: string;
  reconciledAt: string;
}

export interface JournalApi {
  list(input: {surface?: PolicySurface;scopeId?:string;state?:JournalRecord["state"];limit?:number;offset?:number}): Promise<{
    records: JournalRecord[];
    total: number;
    unknownEffects: number;
  }>;
  inspect(input: { operationId: string }): Promise<{
    record?: JournalRecord;
    reconciliations?: JournalReconciliation[];
    migrationReport?: SchemaMigrationReport;
  }>;
  reconcile(input: { operationId: string; verdict: "applied" | "not-applied"; actor: string; evidenceRef: string }): Promise<JournalRecord>;
}
