import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SchemaMigration {
  version: number;
  sql: string;
  columns?: Array<{ table: string; name: string; definition: string }>;
}
export type { SchemaMigrationReport } from "../../shared/storage-migrations.ts";
import type { SchemaMigrationReport } from "../../shared/storage-migrations.ts";
export class SchemaMigrationError extends Error {
  readonly code = "SCHEMA_MIGRATION_MISMATCH";
}

/** Each namespace owns its ordered migration history, including in shared SQLite files.
 * Hashes identify migration definitions; they are not signatures or authenticity claims. */
export function applySchemaMigrations(db: DatabaseSync, namespace: string, migrations: SchemaMigration[]): SchemaMigrationReport {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace) || migrations.some((item, index) => item.version !== index + 1))
    throw new SchemaMigrationError("Migration namespaces and consecutive versions must be explicit.");
  const report: SchemaMigrationReport = { namespace, checkedAt: new Date().toISOString(), entries: [] };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY,sha TEXT NOT NULL,applied_at TEXT NOT NULL)");
    const rows = db.prepare("SELECT version,sha,applied_at FROM schema_migrations WHERE version LIKE ? ORDER BY version").all(`${namespace}:%`) as Array<{version:string;sha:string;applied_at:string}>;
    const known = new Set(migrations.map(item => `${namespace}:${item.version}`));
    if (rows.some(row => !known.has(row.version))) throw new SchemaMigrationError(`The ${namespace} database contains a migration newer than this reader. Original rows were retained.`);
    for (const migration of migrations) {
      const sha = createHash("sha256").update(JSON.stringify({sql:migration.sql.replaceAll("\r\n", "\n").trim(),columns:migration.columns??[]})).digest("hex");
      const version = `${namespace}:${migration.version}`, row = rows.find(item => item.version === version);
      if (row && row.sha !== sha) throw new SchemaMigrationError(`Migration ${version} differs from its recorded checksum. Original database retained.`);
      if (!row) {
        db.exec(migration.sql);
        for (const column of migration.columns ?? []) {
          if (![column.table,column.name].every(value => /^[a-z][a-z0-9_]*$/.test(value))) throw new SchemaMigrationError("Invalid migration column identifier.");
          const existing = db.prepare(`PRAGMA table_info(${column.table})`).all() as Array<{name:string}>;
          if (!existing.some(item => item.name === column.name)) db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.definition}`);
        }
        db.prepare("INSERT INTO schema_migrations(version,sha,applied_at) VALUES(?,?,?)").run(version,sha,report.checkedAt);
      }
      report.entries.push({version:migration.version,sha,appliedAt:row?.applied_at??report.checkedAt,status:row?"verified":"applied"});
    }
    db.exec("COMMIT");
    return report;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
