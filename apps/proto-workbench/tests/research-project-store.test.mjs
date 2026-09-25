import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ResearchProjectStore } from "../src/main/services/research-project-store.ts";
import { RESEARCH_PROJECT_LIMITS } from "../src/shared/research-project.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = join(repository, "build", "research-project-tests");
mkdirSync(fixtures, { recursive: true });
const run = mkdtempSync(join(fixtures, "store-"));
const workspace = name => { const root = join(run, name); mkdirSync(root); return root; };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hasCode = code => error => error?.code === code;
const objectPath = (root, identity) => join(root, ".proto", "objects", "sha256", identity.sha256.slice(0, 2), identity.sha256);
const append = (store, studyId, versionId, value = { label: "synthetic software fixture" }, expectedHead) => store.appendVersion({ studyId, versionId, kind: "study-spec", value, ...(expectedHead !== undefined ? { expectedHead } : {}) });

test("project-owned versions reopen with immutable parents, object hashes and guarded heads", () => {
  const root = workspace("versions");
  let store = ResearchProjectStore.open(root);
  const first = append(store, "study", "version-1", { question: "fixture comparison" }, null);
  assert.equal(first.parentVersionId, null);
  const second = append(store, "study", "version-2", { question: "revised comparison" }, "version-1");
  assert.equal(second.parentVersionId, "version-1");
  assert.deepEqual(append(store, "study", "version-2", second.value), second);
  assert.throws(() => append(store, "study", "version-2", { question: "different" }), hasCode("VERSION_ID_CONFLICT"));
  assert.throws(() => append(store, "study", "version-3", {}, "version-1"), hasCode("REVISION_CONFLICT"));
  assert.throws(() => store.getVersion("version-3"), hasCode("VERSION_NOT_FOUND"));
  store.close();
  assert.equal(existsSync(join(root, ".proto", "project.sqlite")), true);
  assert.equal(existsSync(join(root, "build")), false);
  store = ResearchProjectStore.open(root);
  assert.deepEqual(store.getVersion("version-1").value, first.value);
  assert.deepEqual(store.getHead("study", "study-spec"), second);
  assert.equal(store.listVersions("study", "study-spec").length, 2);
  const db = new DatabaseSync(store.path, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM project_events WHERE kind='research-version-added'").get().n, 2);
  db.close(); store.close();
});

test("object reads bind the whole object even when corruption is outside the requested range", () => {
  const root = workspace("range"), store = ResearchProjectStore.open(root);
  const bytes = Buffer.alloc(3 * 1024 * 1024, 77);
  bytes.write("synthetic-matrix-window", 1024);
  const identity = store.putObject(bytes);
  const range = store.readObjectRange(identity, 1024, 23);
  assert.deepEqual(Buffer.from(range.dataBase64, "base64"), bytes.subarray(1024, 1047));
  assert.equal(range.rangeSha256, hash(bytes.subarray(1024, 1047)));
  assert.deepEqual(range.identity, identity);
  assert.throws(() => store.readObjectRange(identity, bytes.length - 3, 5), hasCode("INVALID_RANGE"));
  assert.throws(() => store.readObjectRange(identity, 0, RESEARCH_PROJECT_LIMITS.rangeBytes + 1), hasCode("RANGE_LIMIT"));
  assert.throws(() => store.readObject(identity, 100), hasCode("OBJECT_LIMIT"));
  const damaged = Buffer.from(bytes); damaged[bytes.length - 1] = 0;
  writeFileSync(objectPath(root, identity), damaged);
  assert.throws(() => store.readObjectRange(identity, 1024, 23), hasCode("OBJECT_CORRUPT"));
  store.close();
});

test("truncated and linked objects fail after reopening; a valid historical value never masks damage", () => {
  const root = workspace("damaged-reopen");
  let store = ResearchProjectStore.open(root);
  const version = append(store, "study", "v1"); store.close();
  const path = objectPath(root, version.object);
  writeFileSync(path, "{}");
  store = ResearchProjectStore.open(root);
  assert.throws(() => store.getVersion("v1"), error => ["INVALID_RANGE", "OBJECT_CORRUPT"].includes(error?.code));
  store.close();
  const linkedRoot = workspace("linked-object"); store = ResearchProjectStore.open(linkedRoot);
  const object = store.putObject(Buffer.from("fixture"));
  linkSync(objectPath(linkedRoot, object), join(linkedRoot, "second-link"));
  assert.throws(() => store.readObjectRange(object, 0, 2), hasCode("UNSAFE_FILE"));
  store.close();
});

test("path traversal, junctions and hardlinked project databases are rejected", () => {
  const root = workspace("unsafe-path"), outside = workspace("outside"), store = ResearchProjectStore.open(root);
  writeFileSync(join(outside, "file"), "outside fixture");
  assert.throws(() => store.snapshotFile("../outside/file"), hasCode("UNSAFE_PATH"));
  assert.throws(() => store.snapshotFile("C:/outside/file"), hasCode("UNSAFE_PATH"));
  assert.throws(() => store.snapshotFile("sources/NUL.txt"), hasCode("UNSAFE_PATH"));
  symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => store.snapshotFile("linked/file"), hasCode("UNSAFE_PATH"));
  store.close();
  const linkedDbRoot = workspace("linked-db");
  const dbStore = ResearchProjectStore.open(linkedDbRoot); dbStore.close();
  linkSync(join(linkedDbRoot, ".proto", "project.sqlite"), join(linkedDbRoot, "copy.sqlite"));
  assert.throws(() => ResearchProjectStore.open(linkedDbRoot), hasCode("UNSAFE_FILE"));
  const linkedDirectoryRoot = workspace("linked-directory");
  symlinkSync(outside, join(linkedDirectoryRoot, ".proto"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => ResearchProjectStore.open(linkedDirectoryRoot), hasCode("UNSAFE_PATH"));
  assert.equal(existsSync(join(outside, "project.sqlite")), false);
});

test("unknown schema remains byte-identical read-only and cannot acquire a new write authority", () => {
  const root = workspace("future-schema"); mkdirSync(join(root, ".proto"));
  const path = join(root, ".proto", "project.sqlite"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE future_versions(id TEXT); INSERT INTO future_versions VALUES('unchanged'); PRAGMA user_version=99;"); db.close();
  const before = hash(readFileSync(path)), store = ResearchProjectStore.open(root);
  assert.equal(store.status.readOnly, true); assert.equal(store.status.schemaVersion, 99);
  assert.throws(() => append(store, "study", "v1"), hasCode("UNSUPPORTED_PROJECT_SCHEMA"));
  assert.throws(() => store.listHeads("study-spec"), hasCode("UNSUPPORTED_PROJECT_SCHEMA"));
  store.close(); assert.equal(hash(readFileSync(path)), before);
});

test("known schema migration adds empty object references without rewriting original version bytes", () => {
  const root = workspace("v1-migration"); let store = ResearchProjectStore.open(root);
  const original = append(store, "study", "v1", { unchanged: "historical bytes" }); store.close();
  const db = new DatabaseSync(join(root, ".proto", "project.sqlite"));
  db.exec("ALTER TABLE research_versions DROP COLUMN references_json; PRAGMA user_version=1;"); db.close();
  store = ResearchProjectStore.open(root);
  assert.equal(store.status.schemaVersion, 2);
  assert.deepEqual(store.getVersion("v1").references, []);
  assert.deepEqual(store.getVersion("v1").object, original.object);
  assert.deepEqual(store.getVersion("v1").value, original.value);
  store.close();
});

test("metadata rollback does not create a successful version or event even after object publication", () => {
  const root = workspace("rollback"), store = ResearchProjectStore.open(root), db = new DatabaseSync(store.path);
  db.exec("CREATE TRIGGER block_event BEFORE INSERT ON project_events WHEN NEW.kind='research-version-added' BEGIN SELECT RAISE(ABORT,'injected event failure'); END;");
  assert.throws(() => append(store, "study", "v1", { value: 42 }), /injected event failure/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM research_versions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM research_heads").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM project_events").get().n, 0);
  assert.equal(store.getHead("study", "study-spec"), null);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM objects").get().n >= 1);
  db.close(); store.close();
});

test("legacy import inventories and copies original bytes, preserves identity, and reports partial parity", () => {
  const root = workspace("legacy"), store = ResearchProjectStore.open(root);
  mkdirSync(join(root, "build", "old"), { recursive: true });
  const path = "build/old/study.json", bytes = Buffer.from('{ "id": "legacy-unchanged", "unknown_version": 88 }\n');
  writeFileSync(join(root, path), bytes);
  const input = { sourceId: "legacy-source", files: [{ path, identity: "legacy-unchanged", expectedSha256: hash(bytes) }] };
  const report = store.importLegacy(input);
  assert.equal(report.idempotent, false);
  assert.deepEqual(report.parity, { bytes: "verified", originalIdentity: "preserved", projection: "not-evaluated", legacyWriteAuthority: "unchanged", cutover: false });
  assert.equal(report.files[0].identity, "legacy-unchanged");
  assert.deepEqual(store.readObject(report.files[0].object), bytes);
  assert.deepEqual(readFileSync(join(root, path)), bytes);
  assert.equal(store.importLegacy(input).idempotent, true);
  writeFileSync(join(root, path), bytes.toString().replace("88", "89"));
  assert.throws(() => store.importLegacy({ sourceId: "legacy-source", files: [{ path, identity: "legacy-unchanged" }] }), hasCode("LEGACY_SOURCE_CHANGED"));
  assert.deepEqual(store.readObject(report.files[0].object), bytes);
  store.close();
});

test("legacy live SQLite is rejected until a consistent closed source is available", () => {
  const root = workspace("legacy-live"), store = ResearchProjectStore.open(root);
  const db = new DatabaseSync(join(root, "legacy.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE data(id TEXT); INSERT INTO data VALUES('fixture');");
  assert.throws(() => store.importLegacy({ sourceId: "legacy", files: [{ path: "legacy.sqlite" }] }), hasCode("LEGACY_SQLITE_LIVE"));
  db.close();
  assert.equal(store.importLegacy({ sourceId: "legacy", files: [{ path: "legacy.sqlite" }] }).parity.bytes, "verified");
  store.close();
});

test("stable head pagination rejects cross-workspace cursors and changed generations", () => {
  const root = workspace("pagination"), store = ResearchProjectStore.open(root);
  for (const id of ["a", "b", "c"]) append(store, id, `${id}-v1`);
  const first = store.listHeads("study-spec", 1); assert.equal(first.items[0].studyId, "a");
  assert.equal(store.listHeads("study-spec", 1, first.nextCursor).items[0].studyId, "b");
  const other = ResearchProjectStore.open(workspace("pagination-other"));
  assert.throws(() => other.listHeads("study-spec", 1, first.nextCursor), hasCode("INVALID_CURSOR")); other.close();
  append(store, "d", "d-v1");
  assert.throws(() => store.listHeads("study-spec", 1, first.nextCursor), hasCode("CURSOR_STALE"));
  store.close();
});

test("full capsules reopen in a second project with original identities and unverified imported provenance", () => {
  const source = ResearchProjectStore.open(workspace("capsule-source"));
  const first = append(source, "study", "v1", { fixture: "first" }, null);
  append(source, "study", "v2", { fixture: "second" }, "v1");
  source.appendVersion({ studyId: "study", versionId: "evidence-1", kind: "run-evidence", value: { result: { estimate: 2.5 }, origin: "unsigned-local-artifacts" }, expectedHead: null });
  const full = source.exportCapsule({ mode: "full", studyIds: ["study"] }); source.close();
  const targetRoot = workspace("capsule-target"); let target = ResearchProjectStore.open(targetRoot);
  const report = target.importCapsule(full);
  assert.equal(report.registered, 3); assert.equal(report.integrity, "verified");
  assert.equal(target.importCapsule(full).registered, 0);
  assert.equal(target.getVersion("v1").origin, "imported-unverified");
  assert.deepEqual(target.getVersion("v1").object, first.object);
  assert.equal(target.getHead("study", "study-spec").versionId, "v2");
  target.close(); target = ResearchProjectStore.open(targetRoot);
  assert.equal(target.getHead("study", "run-evidence").value.result.estimate, 2.5);
  target.close();
});

test("explicit source references travel in full capsules and are hash-checked on every version reopen", () => {
  const sourceRoot = workspace("capsule-source-bytes"), source = ResearchProjectStore.open(sourceRoot);
  const bytes = Buffer.from(">synthetic-fixture\nACDEFGHIK\n"), identity = source.putObject(bytes);
  const version = source.appendVersion({ studyId: "study", kind: "study-spec", versionId: "v1", value: { fixture: "sequence-source" }, references: [identity], expectedHead: null });
  assert.deepEqual(version.references, [identity]);
  assert.throws(() => source.appendVersion({ studyId: "study", kind: "study-spec", versionId: "v1", value: version.value }), hasCode("VERSION_ID_CONFLICT"));
  const full = source.exportCapsule({ mode: "full" }); source.close();
  const targetRoot = workspace("capsule-source-bytes-target"), target = ResearchProjectStore.open(targetRoot);
  const missing = JSON.parse(full.toString()); missing.objects = missing.objects.filter(object => object.identity.sha256 !== identity.sha256);
  assert.throws(() => target.importCapsule(Buffer.from(JSON.stringify(missing))), hasCode("CAPSULE_REFERENCE"));
  target.importCapsule(full);
  assert.deepEqual(target.readObject(target.getVersion("v1").references[0]), bytes);
  writeFileSync(objectPath(targetRoot, identity), Buffer.alloc(bytes.length, 42));
  assert.throws(() => target.getVersion("v1"), hasCode("OBJECT_CORRUPT"));
  target.close();
});

test("capsules reject recognizable secrets and database state in explicitly referenced input bytes", () => {
  const source = ResearchProjectStore.open(workspace("capsule-secret-source"));
  const identity = source.putObject(Buffer.from("api_key=syntheticsecretfixture123456\n"));
  source.appendVersion({ studyId: "study", versionId: "v1", kind: "study-spec", value: { fixture: true }, references: [identity] });
  assert.throws(() => source.exportCapsule({ mode: "full" }), hasCode("CAPSULE_AUTHORITY_FIELD"));
  const databaseIdentity = source.putObject(Buffer.from("SQLite format 3\0synthetic database bytes"));
  source.appendVersion({ studyId: "db-study", versionId: "db-v1", kind: "study-spec", value: { fixture: true }, references: [databaseIdentity] });
  assert.throws(() => source.exportCapsule({ mode: "full", studyIds: ["db-study"] }), hasCode("CAPSULE_AUTHORITY_FIELD"));
  source.close();
});

test("manifest-only capsules do not register missing objects or imply reproducibility", () => {
  const source = ResearchProjectStore.open(workspace("manifest-source")); append(source, "study", "v1");
  const bytes = source.exportCapsule({ mode: "manifest-only" }); source.close();
  const destination = ResearchProjectStore.open(workspace("manifest-target"));
  const report = destination.importCapsule(bytes);
  assert.equal(report.integrity, "manifest-only-objects-unavailable"); assert.equal(report.registered, 0);
  assert.equal(destination.getHead("study", "study-spec"), null); destination.close();
});

test("capsule corruption, missing references, cycles and authority fields fail closed", () => {
  const source = ResearchProjectStore.open(workspace("negative-source")); append(source, "study", "v1");
  const original = JSON.parse(source.exportCapsule({ mode: "full" }).toString());
  const target = ResearchProjectStore.open(workspace("negative-target"));
  const badHash = structuredClone(original); badHash.objects[0].dataBase64 = Buffer.from('{"corrupt":true}').toString("base64");
  assert.throws(() => target.importCapsule(Buffer.from(JSON.stringify(badHash))), hasCode("OBJECT_CORRUPT"));
  const badReference = structuredClone(original); badReference.heads[0].versionId = "missing";
  assert.throws(() => target.importCapsule(Buffer.from(JSON.stringify(badReference))), hasCode("CAPSULE_REFERENCE"));
  const cycle = structuredClone(original); cycle.versions[0].parentVersionId = "v1";
  assert.throws(() => target.importCapsule(Buffer.from(JSON.stringify(cycle))), hasCode("CAPSULE_REFERENCE"));
  append(source, "credential-study", "secret-v1", { api_key: "never-export-fixture" });
  assert.throws(() => source.exportCapsule({ mode: "full" }), hasCode("CAPSULE_AUTHORITY_FIELD"));
  assert.equal(target.listHeads("study-spec").items.length, 0);
  source.close(); target.close();
});

test("capsule version conflict rolls back all new versions and preserves the chosen local head", () => {
  const source = ResearchProjectStore.open(workspace("conflict-source"));
  append(source, "a", "new-version", { a: 1 }); append(source, "z", "conflict-version", { z: 1 });
  const capsule = source.exportCapsule({ mode: "full" }); source.close();
  const target = ResearchProjectStore.open(workspace("conflict-target"));
  append(target, "z", "conflict-version", { z: 2 });
  assert.throws(() => target.importCapsule(capsule), hasCode("VERSION_ID_CONFLICT"));
  assert.throws(() => target.getVersion("new-version"), hasCode("VERSION_NOT_FOUND"));
  assert.equal(target.getHead("z", "study-spec").value.z, 2);
  target.close();
});

test("database pathname replacement is detected before further reads or writes", () => {
  const root = workspace("database-replacement"), store = ResearchProjectStore.open(root);
  append(store, "study", "v1");
  const path = store.path;
  // Windows does not permit renaming SQLite's open handle; the platform itself enforces this boundary.
  if (process.platform === "win32") {
    assert.throws(() => renameSync(path, `${path}.moved`));
  } else {
    renameSync(path, `${path}.moved`); writeFileSync(path, readFileSync(`${path}.moved`));
    assert.throws(() => store.listHeads("study-spec"), hasCode("DATABASE_CHANGED"));
  }
  store.close();
});
