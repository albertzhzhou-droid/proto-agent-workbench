import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  RESEARCH_PROJECT_LIMITS as LIMITS, RESEARCH_PROJECT_SCHEMA_VERSION,
  ResearchCapsuleSchema, ResearchIdentitySchema, ResearchObjectIdentitySchema, ResearchVersionKindSchema, ResearchVersionRecordSchema,
} from "../../shared/research-project.ts";
import type {
  ResearchCapsule, ResearchCapsuleImportReport, ResearchLegacyFile, ResearchLegacyImportReport,
  ResearchLegacyInventoryItem, ResearchObjectIdentity, ResearchObjectRange, ResearchOpenedVersion,
  ResearchProjectStatus, ResearchVersionKind, ResearchVersionPage, ResearchVersionRecord,
} from "../../shared/research-project.ts";

const CHUNK_BYTES = 64 * 1024;
const DATABASE_LIMIT = 128 * 1024 * 1024;
const now = () => new Date().toISOString();
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export class ResearchProjectError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "ResearchProjectError"; this.code = code; }
}
function fail(code: string, message: string): never { throw new ResearchProjectError(code, message); }
function safePath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail("UNSAFE_PATH", "Expected a normalized relative project path without links or special path components.");
  }
  return value;
}
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const fileIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function guardParents(root: string, path: string, create = false): void {
  const rel = relative(root, dirname(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== dirname(path)) fail("UNSAFE_PATH", "Path escapes the project root.");
  let current = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(current), current)) fail("UNSAFE_PATH", "Project parents must be unlinked regular directories.");
  }
}
function guardFile(root: string, path: string, limit: number): Stats {
  guardParents(root, path);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit || !samePath(realpathSync(path), path)) fail("UNSAFE_FILE", "Project files must be bounded regular files with one link.");
  return info;
}
/** Read a bounded slice while hashing the entire same file handle, then recheck the pathname. */
function verifiedRead(root: string, path: string, expected: ResearchObjectIdentity | undefined, offset: number, length: number, fileLimit = LIMITS.objectBytes): { bytes: Buffer; identity: ResearchObjectIdentity } {
  const before = guardFile(root, path, fileLimit);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > before.size || length > before.size - offset) fail("INVALID_RANGE", "Requested range must fit exactly within the complete object; ranges are never silently clipped.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fileIdentity(before, fstatSync(fd))) fail("FILE_CHANGED", "File identity changed before reading.");
    const bytes = Buffer.alloc(length), chunk = Buffer.alloc(CHUNK_BYTES), digest = createHash("sha256");
    let position = 0;
    while (position < before.size) {
      const size = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (!size) fail("OBJECT_TRUNCATED", "Object was truncated during its complete digest check.");
      digest.update(chunk.subarray(0, size));
      const start = Math.max(offset, position), end = Math.min(offset + length, position + size);
      if (end > start) chunk.copy(bytes, start - offset, start - position, end - position);
      position += size;
    }
    const identity = { sha256: digest.digest("hex"), size: position };
    if (!fileIdentity(before, fstatSync(fd)) || !fileIdentity(before, guardFile(root, path, fileLimit))) fail("FILE_CHANGED", "File changed during its complete digest check.");
    if (expected && (identity.sha256 !== expected.sha256 || identity.size !== expected.size)) fail("OBJECT_CORRUPT", "Object bytes or size do not match the retained complete identity.");
    return { bytes, identity };
  } finally { closeSync(fd); }
}

function checkedJson(value: unknown): Buffer {
  let nodes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > 150000 || depth > 64) fail("VALUE_LIMIT", "Research JSON exceeds its bounded shape.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return;
    if (Array.isArray(item)) { for (const child of item) inspect(child, depth + 1); return; }
    if (typeof item === "object" && Object.getPrototypeOf(item) !== undefined && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      for (const child of Object.values(item)) inspect(child, depth + 1);
      return;
    }
    fail("INVALID_JSON_VALUE", "Research versions require finite, lossless JSON values.");
  };
  inspect(value, 0);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > LIMITS.valueBytes) fail("VALUE_LIMIT", "Version exceeds the JSON byte budget; use a separate object artifact.");
  return bytes;
}
function decodeJson(bytes: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const encoded = checkedJson(value);
    if (!encoded.equals(bytes)) fail("NONCANONICAL_VERSION_JSON", "Version JSON must preserve the exact host JSON encoding; duplicate keys and lossy numeric forms are rejected.");
    return value;
  } catch (error) { if (error instanceof ResearchProjectError) throw error; return fail("INVALID_JSON_VALUE", "Stored research JSON is invalid."); }
}
function portableValue(value: unknown): void {
  checkedJson(value);
  const visit = (item: unknown): void => {
    if (typeof item === "string" && /(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(item)) fail("CAPSULE_AUTHORITY_FIELD", "Capsule content contains a credential-shaped value.");
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.replaceAll(/[-_\s]/g, "").toLowerCase();
      if (/^(apikey|secret|password|accesstoken|refreshtoken|authorization|credentials?|livegrants?|grants?|ownership|fencingtoken|leaseowner|kernelcontext)$/.test(normalized)) fail("CAPSULE_AUTHORITY_FIELD", "Capsules cannot carry credentials, grants, ownership or executable kernel context.");
      visit(child);
    }
  };
  visit(value);
}
function portableSource(bytes: Buffer): void {
  if (bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) fail("CAPSULE_AUTHORITY_FIELD", "Raw SQLite databases are outside the portable scientific input scope.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return; }
  if (/(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_-]{8,})/i.test(text)) fail("CAPSULE_AUTHORITY_FIELD", "Referenced source contains a credential-shaped value.");
  // JSON inputs can also carry structured grants. Other table/structure/binary inputs remain exact source bytes.
  if (/^\s*[\[{]/.test(text)) {
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { return; }
    portableValue(parsed);
  }
}

type VersionRow = { study_id: string; kind: ResearchVersionKind; version_id: string; sha256: string; size: number; references_json: string; parent_version_id: string | null; created_at: string; origin: "local" | "imported-unverified" };
const fromRow = (row: VersionRow): ResearchVersionRecord => ResearchVersionRecordSchema.parse({ studyId: row.study_id, kind: row.kind, versionId: row.version_id, object: { sha256: row.sha256, size: row.size }, references: JSON.parse(row.references_json), parentVersionId: row.parent_version_id, createdAt: row.created_at, origin: row.origin });

/** New research versions live here. Existing domain stores retain their documented authority until parity/cutover is implemented. */
export class ResearchProjectStore {
  readonly root: string;
  readonly path: string;
  readonly status: ResearchProjectStatus;
  private readonly db: DatabaseSync;
  private readonly databaseIdentity: { dev: number; ino: number };

  static open(workspace: string): ResearchProjectStore { return new ResearchProjectStore(workspace); }
  private constructor(workspace: string) {
    this.root = realpathSync(workspace);
    if (!statSync(this.root).isDirectory()) fail("UNSAFE_PATH", "Project root is not a directory.");
    this.path = join(this.root, ".proto", "project.sqlite");
    guardParents(this.root, this.path, true);
    const existed = existsSync(this.path);
    if (!existed) { const fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); closeSync(fd); }
    this.guardDatabaseFiles();
    const probe = new DatabaseSync(this.path, { readOnly: true });
    let version: number, tables: number;
    try {
      version = (probe.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      tables = (probe.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { n: number }).n;
    } finally { probe.close(); }
    const supported = version === RESEARCH_PROJECT_SCHEMA_VERSION || version === 1 || (version === 0 && tables === 0);
    this.db = new DatabaseSync(this.path, { readOnly: !supported });
    this.databaseIdentity = { dev: lstatSync(this.path).dev, ino: lstatSync(this.path).ino };
    this.status = { schemaVersion: supported ? RESEARCH_PROJECT_SCHEMA_VERSION : version, supportedSchemaVersion: RESEARCH_PROJECT_SCHEMA_VERSION, readOnly: !supported, authority: "research-versions-no-execution-grants", database: ".proto/project.sqlite" };
    try {
      this.guardDatabase();
      if (supported) {
        this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
        if (!tables) this.transaction(() => {
          this.db.exec(`CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE objects (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size >= 0));
            CREATE TABLE research_versions (version_id TEXT PRIMARY KEY, study_id TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES objects(sha256), size INTEGER NOT NULL, references_json TEXT NOT NULL DEFAULT '[]', parent_version_id TEXT, created_at TEXT NOT NULL, origin TEXT NOT NULL);
            CREATE INDEX research_versions_study ON research_versions(study_id,kind,created_at,version_id);
            CREATE TABLE research_heads (study_id TEXT NOT NULL, kind TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES research_versions(version_id), PRIMARY KEY(study_id,kind));
            CREATE TABLE project_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE legacy_imports (source_id TEXT PRIMARY KEY, inventory_sha256 TEXT NOT NULL, report TEXT NOT NULL);
            PRAGMA user_version=2;`);
          this.db.prepare("INSERT INTO project_meta VALUES('project_id',?)").run(randomUUID());
        });
        else if (version === 1) this.transaction(() => {
          this.db.exec("ALTER TABLE research_versions ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=2;");
          this.db.prepare("INSERT INTO project_events(kind,payload) VALUES('schema-migrated',?)").run(JSON.stringify({ from: 1, to: 2, change: "add-empty-immutable-object-references" }));
        });
        if ((this.db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") fail("DATABASE_CORRUPT", "Project database integrity check failed.");
      }
    } catch (error) { this.db.close(); throw error; }
  }

  private guardDatabaseFiles(): void {
    guardParents(this.root, this.path);
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`, `${this.path}-journal`]) if (existsSync(candidate)) guardFile(this.root, candidate, DATABASE_LIMIT);
  }
  private guardDatabase(): void {
    this.guardDatabaseFiles();
    const current = lstatSync(this.path);
    if (current.dev !== this.databaseIdentity.dev || current.ino !== this.databaseIdentity.ino) fail("DATABASE_CHANGED", "Project database file identity changed.");
  }
  private readable(): void { this.guardDatabase(); if (this.status.readOnly) fail("UNSUPPORTED_PROJECT_SCHEMA", "Unknown project database schema is preserved read-only; use a compatible reader."); }
  private transaction<T>(callback: () => T): T {
    this.readable();
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.guardDatabase(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private objectPath(identity: ResearchObjectIdentity): string {
    ResearchObjectIdentitySchema.parse(identity);
    return join(this.root, ".proto", "objects", "sha256", identity.sha256.slice(0, 2), identity.sha256);
  }
  private publishStaged(staged: string, identity: ResearchObjectIdentity): void {
    verifiedRead(this.root, staged, identity, 0, 0);
    const target = this.objectPath(identity);
    guardParents(this.root, target, true);
    if (existsSync(target)) { verifiedRead(this.root, target, identity, 0, 0); unlinkSync(staged); return; }
    // Serialize publication with the project's SQLite writer lock; published files precede all metadata references.
    // This is recoverable object-first publication, not a filesystem/SQLite atomic transaction or a power-loss guarantee.
    renameSync(staged, target);
    verifiedRead(this.root, target, identity, 0, 0);
  }
  putObject(bytes: Uint8Array): ResearchObjectIdentity {
    this.readable();
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.objectBytes) fail("OBJECT_LIMIT", "Object exceeds the byte budget.");
    const identity = { sha256: hash(bytes), size: bytes.length };
    const staged = join(this.root, ".proto", "staging", `${randomUUID()}.object`);
    guardParents(this.root, staged, true);
    const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, Math.min(CHUNK_BYTES, bytes.length - offset)); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.transaction(() => {
      this.publishStaged(staged, identity);
      this.db.prepare("INSERT INTO objects(sha256,size) VALUES(?,?) ON CONFLICT(sha256) DO NOTHING").run(identity.sha256, identity.size);
      const existing = this.db.prepare("SELECT size FROM objects WHERE sha256=?").get(identity.sha256) as { size: number };
      if (existing.size !== identity.size) fail("OBJECT_IDENTITY_CONFLICT", "Stored object size conflicts with its identity.");
    });
    return identity;
  }
  /** Copy a source snapshot with fixed 64 KiB buffers. Legacy originals remain untouched. */
  snapshotFile(relativePath: string, expectedSha256?: string): ResearchObjectIdentity {
    this.readable();
    const rel = safePath(relativePath);
    if (rel.startsWith(".proto/")) fail("UNSAFE_PATH", "Source snapshots must be outside the project store.");
    const source = join(this.root, ...rel.split("/")), before = guardFile(this.root, source, LIMITS.objectBytes);
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) fail("OBJECT_IDENTITY_CONFLICT", "Expected source digest is invalid.");
    const staged = join(this.root, ".proto", "staging", `${randomUUID()}.object`);
    guardParents(this.root, staged, true);
    const reader = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let writer: number | undefined;
    let identity: ResearchObjectIdentity;
    try {
      if (!fileIdentity(before, fstatSync(reader))) fail("FILE_CHANGED", "Source changed before snapshotting.");
      writer = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      const chunk = Buffer.alloc(CHUNK_BYTES), digest = createHash("sha256");
      let position = 0;
      while (position < before.size) {
        const count = readSync(reader, chunk, 0, Math.min(CHUNK_BYTES, before.size - position), position);
        if (!count) fail("OBJECT_TRUNCATED", "Source was truncated while copying its snapshot.");
        digest.update(chunk.subarray(0, count));
        let written = 0;
        while (written < count) written += writeSync(writer, chunk, written, count - written);
        position += count;
      }
      fsyncSync(writer);
      if (!fileIdentity(before, fstatSync(reader)) || !fileIdentity(before, guardFile(this.root, source, LIMITS.objectBytes))) fail("FILE_CHANGED", "Source changed while copying its snapshot.");
      identity = { sha256: digest.digest("hex"), size: position };
      if (expectedSha256 && identity.sha256 !== expectedSha256) fail("LEGACY_IDENTITY", "Source bytes do not match the expected digest.");
    } finally { closeSync(reader); if (writer !== undefined) closeSync(writer); }
    verifiedRead(this.root, source, identity, 0, 0);
    this.transaction(() => {
      this.publishStaged(staged, identity);
      this.db.prepare("INSERT INTO objects(sha256,size) VALUES(?,?) ON CONFLICT(sha256) DO NOTHING").run(identity.sha256, identity.size);
      const stored = this.db.prepare("SELECT size FROM objects WHERE sha256=?").get(identity.sha256) as { size: number };
      if (stored.size !== identity.size) fail("OBJECT_IDENTITY_CONFLICT", "Stored object size conflicts with its identity.");
    });
    return identity;
  }
  readObject(identity: ResearchObjectIdentity, maxBytes: number = LIMITS.valueBytes): Buffer {
    this.readable(); ResearchObjectIdentitySchema.parse(identity);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > LIMITS.objectBytes || identity.size > maxBytes) fail("OBJECT_LIMIT", "Whole object read exceeds its explicit byte budget; request a bounded range.");
    return verifiedRead(this.root, this.objectPath(identity), identity, 0, identity.size).bytes;
  }
  readObjectRange(identity: ResearchObjectIdentity, offset: number, length: number): ResearchObjectRange {
    this.readable(); ResearchObjectIdentitySchema.parse(identity);
    if (!Number.isSafeInteger(length) || length < 0 || length > LIMITS.rangeBytes) fail("RANGE_LIMIT", "Requested range exceeds the per-read byte budget.");
    const result = verifiedRead(this.root, this.objectPath(identity), identity, offset, length);
    return { identity, offset, length, dataBase64: result.bytes.toString("base64"), rangeSha256: hash(result.bytes), integrity: "verified" };
  }
  appendVersion(input: { studyId: string; kind: ResearchVersionKind; versionId: string; value: unknown; references?: ResearchObjectIdentity[]; expectedHead?: string | null }): ResearchOpenedVersion {
    ResearchIdentitySchema.parse(input.studyId); ResearchIdentitySchema.parse(input.versionId); ResearchVersionKindSchema.parse(input.kind);
    if (input.expectedHead !== undefined && input.expectedHead !== null) ResearchIdentitySchema.parse(input.expectedHead);
    const references = (input.references ?? []).map(identity => ResearchObjectIdentitySchema.parse(identity)).sort((a, b) => a.sha256.localeCompare(b.sha256));
    if (references.length > LIMITS.versionReferences || new Set(references.map(identity => identity.sha256)).size !== references.length) fail("REFERENCE_LIMIT", "Version object references must be unique and bounded.");
    for (const reference of references) verifiedRead(this.root, this.objectPath(reference), reference, 0, 0);
    const identity = this.putObject(checkedJson(input.value));
    this.transaction(() => {
      const duplicate = this.db.prepare("SELECT * FROM research_versions WHERE version_id=?").get(input.versionId) as VersionRow | undefined;
      if (duplicate) {
        if (duplicate.study_id !== input.studyId || duplicate.kind !== input.kind || duplicate.sha256 !== identity.sha256 || duplicate.size !== identity.size || duplicate.references_json !== JSON.stringify(references)) fail("VERSION_ID_CONFLICT", "Version identity already names different immutable content or object references.");
        return;
      }
      const head = this.db.prepare("SELECT version_id FROM research_heads WHERE study_id=? AND kind=?").get(input.studyId, input.kind) as { version_id: string } | undefined;
      if (input.expectedHead !== undefined && (head?.version_id ?? null) !== input.expectedHead) fail("REVISION_CONFLICT", "Study head changed; reopen it before saving another version.");
      verifiedRead(this.root, this.objectPath(identity), identity, 0, 0);
      for (const reference of references) verifiedRead(this.root, this.objectPath(reference), reference, 0, 0);
      this.insertVersion({ studyId: input.studyId, kind: input.kind, versionId: input.versionId, object: identity, references, parentVersionId: head?.version_id ?? null, createdAt: now(), origin: "local" });
      this.setHead(input.studyId, input.kind, input.versionId);
    });
    return this.getVersion(input.versionId);
  }
  private insertVersion(record: ResearchVersionRecord): void {
    this.db.prepare("INSERT INTO research_versions(version_id,study_id,kind,sha256,size,references_json,parent_version_id,created_at,origin) VALUES(?,?,?,?,?,?,?,?,?)").run(record.versionId, record.studyId, record.kind, record.object.sha256, record.object.size, JSON.stringify(record.references), record.parentVersionId, record.createdAt, record.origin);
    this.db.prepare("INSERT INTO project_events(kind,payload) VALUES('research-version-added',?)").run(JSON.stringify(record));
  }
  private setHead(studyId: string, kind: ResearchVersionKind, versionId: string): void {
    this.db.prepare("INSERT INTO research_heads(study_id,kind,version_id) VALUES(?,?,?) ON CONFLICT(study_id,kind) DO UPDATE SET version_id=excluded.version_id").run(studyId, kind, versionId);
  }
  getVersion(versionId: string): ResearchOpenedVersion {
    this.readable(); ResearchIdentitySchema.parse(versionId);
    const row = this.db.prepare("SELECT * FROM research_versions WHERE version_id=?").get(versionId) as VersionRow | undefined;
    if (!row) fail("VERSION_NOT_FOUND", "Research version was not found.");
    const record = fromRow(row);
    for (const reference of record.references) verifiedRead(this.root, this.objectPath(reference), reference, 0, 0);
    return { ...record, value: decodeJson(this.readObject(record.object)) };
  }
  getHead(studyId: string, kind: ResearchVersionKind): ResearchOpenedVersion | null {
    this.readable(); ResearchIdentitySchema.parse(studyId); ResearchVersionKindSchema.parse(kind);
    const row = this.db.prepare("SELECT version_id FROM research_heads WHERE study_id=? AND kind=?").get(studyId, kind) as { version_id: string } | undefined;
    return row ? this.getVersion(row.version_id) : null;
  }
  listVersions(studyId: string, kind: ResearchVersionKind, limit = 100): ResearchVersionRecord[] {
    this.readable(); ResearchIdentitySchema.parse(studyId); ResearchVersionKindSchema.parse(kind);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) fail("PAGE_LIMIT", "Version list requires a bounded page size.");
    return (this.db.prepare("SELECT * FROM research_versions WHERE study_id=? AND kind=? ORDER BY created_at DESC,version_id DESC LIMIT ?").all(studyId, kind, limit) as VersionRow[]).map(fromRow);
  }
  listHeads(kind: ResearchVersionKind, limit = 30, cursor?: string): ResearchVersionPage {
    this.readable(); ResearchVersionKindSchema.parse(kind);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize) fail("PAGE_LIMIT", "Head list requires a bounded page size.");
    const projectId = (this.db.prepare("SELECT value FROM project_meta WHERE key='project_id'").get() as { value: string }).value;
    const generation = (this.db.prepare("SELECT COALESCE(MAX(sequence),0) n FROM project_events").get() as { n: number }).n;
    let last = "";
    if (cursor) {
      if (cursor.length > 2048) fail("INVALID_CURSOR", "Page cursor exceeds its byte budget.");
      let parsed: { projectId?: unknown; kind?: unknown; generation?: unknown; last?: unknown; limit?: unknown };
      try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { fail("INVALID_CURSOR", "Invalid page cursor."); }
      if (!parsed || parsed.projectId !== projectId || parsed.kind !== kind || parsed.limit !== limit || typeof parsed.last !== "string" || !ResearchIdentitySchema.safeParse(parsed.last).success) fail("INVALID_CURSOR", "Page cursor belongs to a different project or query.");
      if (parsed.generation !== generation) fail("CURSOR_STALE", "Research versions changed; restart pagination.");
      last = parsed.last;
    }
    const rows = this.db.prepare("SELECT study_id,version_id FROM research_heads WHERE kind=? AND study_id>? ORDER BY study_id LIMIT ?").all(kind, last, limit + 1) as Array<{ study_id: string; version_id: string }>;
    const selected = rows.slice(0, limit);
    return { items: selected.map(row => this.getVersion(row.version_id)), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ projectId, kind, limit, generation, last: selected.at(-1)!.study_id })).toString("base64url") : null };
  }

  importLegacy(input: { sourceId: string; files: ResearchLegacyFile[] }): ResearchLegacyImportReport {
    this.readable(); ResearchIdentitySchema.parse(input.sourceId);
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > LIMITS.legacyFiles) fail("LEGACY_LIMIT", "Legacy inventory requires a bounded nonempty file list.");
    const files: ResearchLegacyInventoryItem[] = [], originals: Array<{ path: string; object: ResearchObjectIdentity }> = [];
    let total = 0;
    const paths = new Set<string>();
    for (const file of input.files) {
      const rel = safePath(file.path), path = join(this.root, ...rel.split("/"));
      if (rel.startsWith(".proto/") || paths.has(process.platform === "win32" ? rel.toLowerCase() : rel)) fail("LEGACY_PATH", "Legacy inventory paths must be unique and outside the new store.");
      paths.add(process.platform === "win32" ? rel.toLowerCase() : rel);
      if (file.identity !== undefined) ResearchIdentitySchema.parse(file.identity);
      if (file.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(file.expectedSha256)) fail("LEGACY_IDENTITY", "Invalid expected legacy digest.");
      // A raw file copy is not a live SQLite consistency snapshot. Require the producer to close/checkpoint first.
      if (/\.(sqlite|db)$/i.test(rel)) for (const suffix of ["-wal", "-journal"]) if (existsSync(`${path}${suffix}`) && guardFile(this.root, `${path}${suffix}`, DATABASE_LIMIT).size > 0) fail("LEGACY_SQLITE_LIVE", "Legacy SQLite has a live WAL/journal; provide a closed consistent snapshot before importing original bytes.");
      const size = guardFile(this.root, path, LIMITS.objectBytes).size;
      total += size; if (total > LIMITS.legacyTotalBytes) fail("LEGACY_LIMIT", "Legacy inventory exceeds its total byte budget.");
      const identity = this.snapshotFile(rel, file.expectedSha256);
      originals.push({ path, object: identity });
      files.push({ path: rel, identity: file.identity ?? rel, object: identity });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const inventorySha256 = hash(JSON.stringify(files));
    // Reopen originals and retained copies before committing the inventory/parity event.
    for (const original of originals) { verifiedRead(this.root, original.path, original.object, 0, 0); verifiedRead(this.root, this.objectPath(original.object), original.object, 0, 0); }
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT inventory_sha256,report FROM legacy_imports WHERE source_id=?").get(input.sourceId) as { inventory_sha256: string; report: string } | undefined;
      if (previous) { if (previous.inventory_sha256 !== inventorySha256) fail("LEGACY_SOURCE_CHANGED", "This legacy source identity was already imported with different original bytes or identities."); return { ...JSON.parse(previous.report) as ResearchLegacyImportReport, idempotent: true }; }
      const report: ResearchLegacyImportReport = { sourceId: input.sourceId, inventorySha256, importedAt: now(), files, parity: { bytes: "verified", originalIdentity: "preserved", projection: "not-evaluated", legacyWriteAuthority: "unchanged", cutover: false }, idempotent: false };
      this.db.prepare("INSERT INTO legacy_imports VALUES(?,?,?)").run(input.sourceId, inventorySha256, JSON.stringify(report));
      this.db.prepare("INSERT INTO project_events(kind,payload) VALUES('legacy-inventory-imported',?)").run(JSON.stringify(report));
      return report;
    });
  }

  exportCapsule(input: { mode: "manifest-only" | "full"; studyIds?: string[] }): Buffer {
    this.readable();
    if (input.mode !== "manifest-only" && input.mode !== "full") fail("CAPSULE_MODE", "Unsupported capsule mode.");
    const selected = input.studyIds ? new Set(input.studyIds.map(id => ResearchIdentitySchema.parse(id))) : null;
    if (selected && selected.size > LIMITS.capsuleVersions) fail("CAPSULE_LIMIT", "Too many selected studies.");
    this.db.exec("BEGIN");
    try {
      const where = selected ? ` WHERE study_id IN (${[...selected].map(() => "?").join(",") || "NULL"})` : "";
      const rows = this.db.prepare(`SELECT * FROM research_versions${where} ORDER BY study_id,kind,created_at,version_id LIMIT ?`).all(...(selected ? [...selected] : []), LIMITS.capsuleVersions + 1) as VersionRow[];
      const versions = rows.map(fromRow);
      if (versions.length > LIMITS.capsuleVersions) fail("CAPSULE_LIMIT", "Capsule exceeds the version budget; select fewer studies.");
      const identities = new Map(versions.flatMap(version => [version.object, ...version.references]).map(identity => [identity.sha256, identity]));
      if (identities.size > LIMITS.capsuleObjects) fail("CAPSULE_LIMIT", "Capsule exceeds its object count budget.");
      if (input.mode === "full" && [...identities.values()].reduce((sum, identity) => sum + 4 * Math.ceil(identity.size / 3), 0) > LIMITS.capsuleBytes - 512 * 1024) fail("CAPSULE_LIMIT", "Selected object bytes exceed the capsule memory budget.");
      const objects: ResearchCapsule["objects"] = [], seen = new Set<string>();
      for (const version of versions) {
        const bytes = this.readObject(version.object);
        portableValue(decodeJson(bytes));
        if (!seen.has(version.object.sha256)) { seen.add(version.object.sha256); objects.push({ identity: version.object, ...(input.mode === "full" ? { dataBase64: bytes.toString("base64") } : {}) }); }
      }
      for (const identity of identities.values()) {
        if (seen.has(identity.sha256)) continue;
        if (input.mode === "manifest-only") {
          verifiedRead(this.root, this.objectPath(identity), identity, 0, 0);
          objects.push({ identity });
        } else {
          const bytes = this.readObject(identity, LIMITS.capsuleBytes);
          // Explicitly referenced scientific inputs are portable content, never project/profile database state.
          // Refuse recognizable credentials even when an input is plain text rather than version JSON.
          portableSource(bytes);
          objects.push({ identity, dataBase64: bytes.toString("base64") });
        }
      }
      const heads = (this.db.prepare(`SELECT study_id,kind,version_id FROM research_heads${where} ORDER BY study_id,kind LIMIT ?`).all(...(selected ? [...selected] : []), LIMITS.capsuleVersions + 1) as Array<{ study_id: string; kind: ResearchVersionKind; version_id: string }>).map(row => ({ studyId: row.study_id, kind: row.kind, versionId: row.version_id }));
      const capsule: ResearchCapsule = { schemaVersion: "proto.research-version-capsule.v1", mode: input.mode, scope: "research-versions-and-evidence-snapshots", createdAt: now(), authority: "imported-unverified-no-execution-or-review-grants", versions, objects, heads };
      const bytes = Buffer.from(JSON.stringify(capsule));
      if (bytes.length > LIMITS.capsuleBytes) fail("CAPSULE_LIMIT", "Capsule exceeds its serialized byte budget.");
      return bytes;
    } finally { this.db.exec("COMMIT"); }
  }
  importCapsule(bytes: Uint8Array): ResearchCapsuleImportReport {
    this.readable();
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.capsuleBytes) fail("CAPSULE_LIMIT", "Capsule exceeds its input byte budget.");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("CAPSULE_INVALID", "Capsule must be valid UTF-8 JSON."); }
    const capsule = ResearchCapsuleSchema.parse(parsed);
    const versions = new Map(capsule.versions.map(version => [version.versionId, version]));
    const objects = new Map(capsule.objects.map(object => [object.identity.sha256, object]));
    if (versions.size !== capsule.versions.length || objects.size !== capsule.objects.length) fail("CAPSULE_DUPLICATE", "Capsule object/version identities must be unique.");
    const headKeys = new Set<string>();
    for (const head of capsule.heads) {
      const version = versions.get(head.versionId), key = `${head.studyId}/${head.kind}`;
      if (!version || version.studyId !== head.studyId || version.kind !== head.kind || headKeys.has(key)) fail("CAPSULE_REFERENCE", "Capsule head does not name one matching included version.");
      headKeys.add(key);
    }
    for (const version of capsule.versions) {
      const object = objects.get(version.object.sha256);
      if (!object || object.identity.size !== version.object.size) fail("CAPSULE_REFERENCE", "Capsule version object identity is missing or inconsistent.");
      if (new Set(version.references.map(reference => reference.sha256)).size !== version.references.length) fail("CAPSULE_REFERENCE", "Version object references must be unique.");
      for (const reference of version.references) if (objects.get(reference.sha256)?.identity.size !== reference.size) fail("CAPSULE_REFERENCE", "Capsule is missing an explicitly referenced source object.");
      if (version.parentVersionId !== null) {
        const parent = versions.get(version.parentVersionId);
        if (!parent || parent.studyId !== version.studyId || parent.kind !== version.kind || parent.versionId === version.versionId) fail("CAPSULE_REFERENCE", "Capsule parent must name another included version from the same study and kind.");
      }
      const ancestry = new Set<string>(); let ancestor: ResearchVersionRecord | undefined = version;
      while (ancestor) { if (ancestry.has(ancestor.versionId)) fail("CAPSULE_REFERENCE", "Version ancestry must be acyclic."); ancestry.add(ancestor.versionId); ancestor = ancestor.parentVersionId ? versions.get(ancestor.parentVersionId) : undefined; }
    }
    if (new Set(capsule.versions.flatMap(version => [version.object.sha256, ...version.references.map(reference => reference.sha256)])).size !== objects.size) fail("CAPSULE_REFERENCE", "Capsule cannot contain unrelated objects.");
    if (capsule.mode === "manifest-only") {
      if (capsule.objects.some(object => object.dataBase64 !== undefined)) fail("CAPSULE_MODE", "Manifest-only capsules must not contain embedded objects.");
      return { mode: capsule.mode, versions: versions.size, registered: 0, integrity: "manifest-only-objects-unavailable", authority: capsule.authority };
    }
    for (const object of capsule.objects) {
      if (typeof object.dataBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(object.dataBase64)) fail("CAPSULE_OBJECT_MISSING", "Full capsules require canonical base64 object bytes.");
      const content = Buffer.from(object.dataBase64, "base64");
      if (content.length !== object.identity.size || hash(content) !== object.identity.sha256) fail("OBJECT_CORRUPT", "Capsule object does not match its complete size and digest.");
      if (capsule.versions.some(version => version.object.sha256 === object.identity.sha256)) portableValue(decodeJson(content));
      else portableSource(content);
    }
    // Validate all content before any registration. Published unreferenced objects remain harmless on later rollback.
    for (const object of capsule.objects) this.putObject(Buffer.from(object.dataBase64!, "base64"));
    const registered = this.transaction(() => {
      let count = 0;
      for (const version of capsule.versions) {
        verifiedRead(this.root, this.objectPath(version.object), version.object, 0, 0);
        const prior = this.db.prepare("SELECT * FROM research_versions WHERE version_id=?").get(version.versionId) as VersionRow | undefined;
        if (prior) {
          const existing = fromRow(prior);
          if (existing.studyId !== version.studyId || existing.kind !== version.kind || existing.object.sha256 !== version.object.sha256 || existing.object.size !== version.object.size || JSON.stringify(existing.references) !== JSON.stringify(version.references) || existing.parentVersionId !== version.parentVersionId || existing.createdAt !== version.createdAt) fail("VERSION_ID_CONFLICT", "Imported version identity conflicts with existing immutable history.");
        } else { this.insertVersion({ ...version, origin: "imported-unverified" }); count++; }
      }
      for (const head of capsule.heads) {
        const prior = this.db.prepare("SELECT version_id FROM research_heads WHERE study_id=? AND kind=?").get(head.studyId, head.kind) as { version_id: string } | undefined;
        if (!prior) this.setHead(head.studyId, head.kind, head.versionId);
        // Preserve an existing local head; imported branches never silently supersede local choices.
      }
      return count;
    });
    for (const version of capsule.versions) this.getVersion(version.versionId);
    return { mode: capsule.mode, versions: versions.size, registered, integrity: "verified", authority: capsule.authority };
  }
  close(): void { this.db.close(); }
}
