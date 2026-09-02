import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { FileCheckpoint, PatchOperation, PatchProposal, WorkspaceEntry } from "../../shared/contracts.ts";
import type { AppDatabase } from "./database.ts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_DIRECTORIES = 512;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_SCAN_DEPTH = 16;
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
// Still fail closed, but leave enough wall-clock headroom for Windows Defender
// to inspect a bounded workspace containing hundreds of retained run manifests.
const MAX_SCAN_MILLISECONDS = 6_000;
const SEARCHABLE_EXTENSIONS = new Set([
  ".proto",
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".py",
  ".r",
  ".ipynb",
]);
const LISTABLE_EXTENSIONS = new Set([
  ...SEARCHABLE_EXTENSIONS,
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);
const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".npm-cache",
  ".pnpm-store",
  ".pytest_cache",
  ".svn",
  ".venv",
  ".venv-sidecar",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "nvidia corporation",
  "out",
  "release",
  "venv",
]);
// Electron Builder output directories are intentionally not workspace source.
// Local validation commonly uses names such as release-final, release-v2, and
// release-stress-r39; traversing their unpacked applications can exhaust the
// bounded startup scan before the real Proto artifacts are indexed.
const IGNORED_DIRECTORY_PREFIXES = ["release-"];
const GENERATED_APP_DIRECTORIES = new Set(["qa", "runtime"]);
const ROOT_BUILD_IGNORED_DIRECTORIES = new Set([
  "cache",
  "pyinstaller",
  "upgrade-queue",
  // Retained screenshots, unpacked Electron applications, and browser export
  // diagnostics are QA evidence for the workbench itself. They are not Proto
  // review artifacts and can contain hundreds of nested runtime directories.
  "visualization-qa",
]);
const ROOT_BUILD_REVIEW_ARTIFACTS = new Set([
  "evidence.cards.json",
  "human_review_checklist.md",
  "manifest.json",
  "provenance.json",
  "review.json",
  "review_packet.json",
  "review_packet.md",
  "validation_report.json",
]);

export class WorkspaceFiles {
  private canonicalRoot?: string;
  private readonly root: string;
  private readonly database: AppDatabase;

  constructor(root: string, database: AppDatabase) {
    this.root = root;
    this.database = database;
  }

  async read(inputPath: string): Promise<{ path: string; content: string; sha256: string }> {
    const root = await this.getCanonicalRoot();
    const path = await this.resolveInside(inputPath, false);
    const content = await readRegularContainedFile(root, path);
    if (content === undefined) throw new Error("Only bounded single-link workspace files can be read.");
    return { path, content, sha256: sha256(content) };
  }

  async search(
    query: string,
    extensionHint?: string,
  ): Promise<Array<{ path: string; line: number; preview: string }>> {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    const root = await this.getCanonicalRoot();
    const files = await collectFiles(root, extensionHint);
    const results: Array<{ path: string; line: number; preview: string }> = [];
    for (const path of files) {
      const content = await readRegularContainedFile(root, path);
      if (content === undefined) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].toLocaleLowerCase().includes(normalized)) {
          results.push({ path, line: index + 1, preview: lines[index].trim().slice(0, 240) });
          if (results.length >= 100) return results;
        }
      }
    }
    return results;
  }

  async list(): Promise<WorkspaceEntry[]> {
    const root = await this.getCanonicalRoot();
    const files = await collectFiles(root, undefined, true);
    return Promise.all(
      files.map(async (path) => {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
          throw new Error("Only single-link regular workspace files can be listed.");
        }
        return {
          path,
          relativePath: relative(root, path),
          name: basename(path),
          mediaType: mediaTypeFor(path),
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      }),
    );
  }

  async resolveReadable(inputPath: string): Promise<string> {
    return this.resolveInside(inputPath, false);
  }

  async canonicalRootPath(): Promise<string> {
    return this.getCanonicalRoot();
  }

  async proposePatch(input: {
    runId: string;
    targetPath: string;
    after: string;
    rationale: string;
  }): Promise<PatchProposal> {
    const path = await this.resolveInside(input.targetPath, true);
    const beforeState = await observeTextPath(path);
    const patch: PatchProposal = {
      id: randomUUID(),
      runId: input.runId,
      targetPath: path,
      baseSha256: beforeState.sha256,
      baseExists: beforeState.exists,
      before: beforeState.content,
      after: input.after,
      afterExists: true,
      unifiedDiff: createTwoFilesPatch(path, path, beforeState.content, input.after, "current", "proposed", {
        context: 4,
      }),
      rationale: input.rationale,
      status: "pending",
      revision: 0,
      createdAt: new Date().toISOString(),
    };
    this.database.savePatch(patch);
    return patch;
  }

  async applyApprovedPatch(
    patchId: string,
    expectedRevision: number,
  ): Promise<{ patch: PatchProposal; operation: PatchOperation; checkpoint: FileCheckpoint }> {
    const patch = this.database.getPatch(patchId);
    if (!patch) throw new Error("Patch proposal was not found.");
    if (patch.status !== "pending") throw new Error(`Patch is already ${patch.status}.`);
    if (patch.revision !== expectedRevision) throw new Error("The patch changed after it was reviewed. Refresh before deciding.");
    const path = await this.resolveInside(patch.targetPath, true);
    const current = await observeTextPath(path);
    if (current.exists !== patch.baseExists || current.sha256 !== patch.baseSha256) {
      this.database.markPendingPatchStale(patch.id, patch.revision);
      throw new Error("The file changed after this patch was proposed. Regenerate the diff before applying it.");
    }
    const resultSha256 = sha256(patch.after);
    const prepared = this.database.preparePatchOperation(patch.id, patch.revision, {
      targetPath: path,
      existed: current.exists,
      content: current.content,
      sha256: current.sha256,
      resultSha256,
      resultExists: patch.afterExists,
    });
    if (!["prepared", "applying"].includes(prepared.operation.state)) {
      throw new Error(`Patch operation is ${prepared.operation.state}; reconcile it before continuing.`);
    }
    const applying = prepared.operation.state === "prepared"
      ? this.database.markPatchOperationApplying(prepared.operation.id, prepared.operation.revision)
      : prepared.operation;
    try {
      await replaceTextPathCas(path, {
        expectedExists: patch.baseExists,
        expectedSha256: patch.baseSha256,
        resultExists: patch.afterExists,
        content: patch.after,
      });
      const observed = await observeTextPath(path);
      if (observed.exists !== patch.afterExists || observed.sha256 !== resultSha256) {
        throw new Error("The workspace did not retain the reviewed patch result.");
      }
      const applied = this.database.markPatchOperationApplied(applying.id, applying.revision, observed.sha256);
      return { patch: applied.patch, operation: applied.operation, checkpoint: prepared.checkpoint };
    } catch (error) {
      const latest = this.database.getPatchOperation(applying.id) ?? applying;
      const observed = await observeTextPath(path).catch(() => ({ exists: false, content: "", sha256: sha256("") }));
      const reconciled = this.database.reconcilePatchOperation(latest.id, latest.revision, observed);
      if (reconciled.state === "applied") {
        const appliedPatch = this.database.getPatch(patch.id);
        if (!appliedPatch) throw error;
        return { patch: appliedPatch, operation: reconciled, checkpoint: prepared.checkpoint };
      }
      throw error;
    }
  }

  rejectPatch(patchId: string, expectedRevision: number): PatchProposal {
    const patch = this.database.getPatch(patchId);
    if (!patch) throw new Error("Patch proposal was not found.");
    return this.database.rejectPendingPatch(patchId, expectedRevision);
  }

  async reconcilePatchOperation(operationId: string, expectedRevision: number): Promise<PatchOperation> {
    const operation = this.database.getPatchOperation(operationId);
    if (!operation) throw new Error("Patch operation was not found.");
    const context = this.database.getRunContext(operation.runId);
    const root = await this.getCanonicalRoot();
    if (context?.workspacePath && context.workspacePath !== root) throw new Error("Patch operation belongs to another workspace.");
    const path = await this.resolveInside(operation.targetPath, true);
    const observed = await observeTextPath(path);
    return this.database.reconcilePatchOperation(operation.id, expectedRevision, observed);
  }

  async assertOperationResultCurrent(operationId: string): Promise<PatchOperation> {
    const operation = this.database.getPatchOperation(operationId);
    if (!operation) throw new Error("Patch operation was not found.");
    const path = await this.resolveInside(operation.targetPath, true);
    const observed = await observeTextPath(path);
    if (observed.exists !== operation.resultExists || observed.sha256 !== operation.resultSha256) {
      return this.database.reconcilePatchOperation(operation.id, operation.revision, observed);
    }
    return operation;
  }

  async prepareCheckpointRestore(checkpointId: string, expectedRevision: number): Promise<PatchProposal> {
    const snapshot = this.database.getCheckpointSnapshot(checkpointId);
    if (!snapshot) throw new Error("File checkpoint was not found.");
    const operation = this.database.getPatchOperation(snapshot.checkpoint.operationId);
    if (!operation) throw new Error("Patch operation was not found.");
    const path = await this.resolveInside(snapshot.checkpoint.targetPath, true);
    const current = await observeTextPath(path);
    if (current.exists !== operation.resultExists || current.sha256 !== operation.resultSha256) {
      this.database.markCheckpointConflict(
        checkpointId,
        expectedRevision,
        "The file changed after this checkpoint was created. Proto will not overwrite the newer content.",
      );
      throw new Error("The file changed after this checkpoint was created. Compare the newer content before restoring.");
    }
    const patch: PatchProposal = {
      id: randomUUID(),
      runId: snapshot.checkpoint.runId,
      targetPath: path,
      baseSha256: current.sha256,
      baseExists: current.exists,
      before: current.content,
      after: snapshot.content,
      afterExists: snapshot.checkpoint.existed,
      unifiedDiff: createTwoFilesPatch(path, path, current.content, snapshot.content, "current", "checkpoint", { context: 4 }),
      rationale: `Restore the reviewed file checkpoint created before patch ${snapshot.checkpoint.patchId}.`,
      status: "pending",
      revision: 0,
      restoresCheckpointId: snapshot.checkpoint.id,
      createdAt: new Date().toISOString(),
    };
    return this.database.createCheckpointRestorePatch(checkpointId, expectedRevision, patch);
  }

  async reconcilePatchOperations(): Promise<{ reconciled: number; conflicted: number }> {
    const root = await this.getCanonicalRoot();
    let reconciled = 0;
    let conflicted = 0;
    for (const operation of this.database.listRecoverablePatchOperations()) {
      const context = this.database.getRunContext(operation.runId);
      if (context?.workspacePath && context.workspacePath !== root) continue;
      let next: PatchOperation;
      try {
        next = await this.reconcilePatchOperation(operation.id, operation.revision);
      } catch {
        continue;
      }
      if (next.revision !== operation.revision) reconciled += 1;
      if (next.state === "conflict") conflicted += 1;
    }
    return { reconciled, conflicted };
  }

  private async resolveInside(inputPath: string, allowMissing: boolean): Promise<string> {
    const root = await this.getCanonicalRoot();
    const candidate = resolve(isAbsolute(inputPath) ? inputPath : join(root, inputPath));
    assertContained(root, candidate);
    if (await fileExists(candidate)) {
      const original = await lstat(candidate);
      if (original.isSymbolicLink()) throw new Error("Symbolic links and junctions are not accessible through the workbench.");
      if (original.isFile() && original.nlink !== 1) {
        throw new Error("Hard-linked files are not accessible through the workbench.");
      }
      const canonical = await realpath(candidate);
      assertContained(root, canonical);
      if (!sameCanonicalPath(candidate, canonical)) {
        throw new Error("Workspace paths cannot traverse symbolic links or junctions.");
      }
      const info = await lstat(canonical);
      if (info.isSymbolicLink()) throw new Error("Symbolic-link targets are not writable through the workbench.");
      if (info.isFile() && info.nlink !== 1) {
        throw new Error("Hard-linked files are not accessible through the workbench.");
      }
      return canonical;
    }
    if (!allowMissing) throw new Error("Workspace file does not exist.");
    const requestedParent = dirname(candidate);
    const parent = await realpath(requestedParent);
    assertContained(root, parent);
    if (!sameCanonicalPath(requestedParent, parent)) {
      throw new Error("Workspace paths cannot traverse symbolic links or junctions.");
    }
    const parentInfo = await lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error("New workspace files require a canonical regular parent directory.");
    }
    return join(parent, basename(candidate));
  }

  private async getCanonicalRoot(): Promise<string> {
    this.canonicalRoot ??= await realpath(this.root);
    return this.canonicalRoot;
  }
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) {
    return;
  }
  throw new Error("Path is outside the selected workspace.");
}

function sameCanonicalPath(left: string, right: string): boolean {
  const requested = resolve(left);
  const canonical = resolve(right);
  return process.platform === "win32"
    ? requested.toLocaleLowerCase() === canonical.toLocaleLowerCase()
    : requested === canonical;
}

async function collectFiles(root: string, extensionHint?: string, includeBinary = false): Promise<string[]> {
  const files: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const deadline = Date.now() + MAX_SCAN_MILLISECONDS;
  let directories = 0;
  let entriesScanned = 0;
  let totalBytes = 0;
  while (queue.length) {
    if (Date.now() > deadline) throw new Error("Workspace scan exceeded its time budget.");
    if (++directories > MAX_SCAN_DIRECTORIES) throw new Error("Workspace scan exceeded its directory budget.");
    const { path: directory, depth } = queue.shift() as { path: string; depth: number };
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink()) continue;
    const canonicalDirectory = await realpath(directory);
    assertContained(root, canonicalDirectory);
    if (!directoryInfo.isDirectory()) continue;
    const entries = await opendir(canonicalDirectory);
    for await (const entry of entries) {
      if (Date.now() > deadline) throw new Error("Workspace scan exceeded its time budget.");
      if (++entriesScanned > MAX_SCAN_ENTRIES) throw new Error("Workspace scan exceeded its entry budget.");
      const path = join(canonicalDirectory, entry.name);
      if (entry.isSymbolicLink()) continue;
      let kind: "directory" | "file" | "other" = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";
      let info;
      if (kind === "other") {
        info = await lstat(path);
        if (info.isSymbolicLink()) continue;
        kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
      }
      if (kind === "directory") {
        if (isIgnoredScanDirectory(root, canonicalDirectory, entry.name, depth)) continue;
        if (depth >= MAX_SCAN_DEPTH) throw new Error("Workspace scan exceeded its depth budget.");
        // Revalidate and canonicalize once when this queued directory is
        // opened. The previous implementation repeated lstat+realpath both
        // here and at dequeue, which made Defender-sensitive startup scans
        // exceed the bounded wall-clock budget.
        queue.push({ path, depth: depth + 1 });
        continue;
      }
      if (kind !== "file") continue;
      const dot = entry.name.lastIndexOf(".");
      const extension = dot >= 0 ? entry.name.slice(dot).toLocaleLowerCase() : "";
      if (!(includeBinary ? LISTABLE_EXTENSIONS : SEARCHABLE_EXTENSIONS).has(extension)) continue;
      if (extensionHint && !entry.name.toLocaleLowerCase().endsWith(extensionHint.toLocaleLowerCase())) continue;
      if (isInsideRootBuild(root, path) && !isRootBuildReviewArtifact(entry.name)) continue;
      info ??= await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) continue;
      totalBytes += info.size;
      if (totalBytes > MAX_SCAN_BYTES) throw new Error("Workspace scan exceeded its byte budget.");
      if (files.length >= MAX_SCAN_FILES) throw new Error("Workspace scan exceeded its file budget.");
      const canonical = await realpath(path);
      assertContained(root, canonical);
      files.push(canonical);
    }
  }
  return files;
}

function isIgnoredScanDirectory(root: string, parent: string, name: string, parentDepth: number): boolean {
  const normalized = name.toLocaleLowerCase();
  if (IGNORED_DIRECTORIES.has(normalized)) return true;
  if (IGNORED_DIRECTORY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  const parentFromRoot = relative(root, parent).replaceAll("\\", "/").toLocaleLowerCase();
  // Packaged runtimes and retained visual QA belong to the workbench
  // application, not to the user's reviewable workspace inventory. Keeping
  // this path-specific avoids hiding a legitimate top-level runtime/ or qa/.
  if (parentFromRoot === "apps/proto-workbench" && GENERATED_APP_DIRECTORIES.has(normalized)) return true;
  if (parentFromRoot === "build" && ROOT_BUILD_IGNORED_DIRECTORIES.has(normalized)) {
    return true;
  }
  // A root-level build/ directory is part of the Proto workspace contract and
  // contains reviewable IR/provenance. Nested build/ trees are application or
  // dependency output and must not consume the bounded startup scan.
  return normalized === "build" && parentDepth > 0;
}

function isInsideRootBuild(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  const [first] = pathFromRoot.split(sep);
  return first?.toLocaleLowerCase() === "build";
}

function isRootBuildReviewArtifact(name: string): boolean {
  const normalized = name.toLocaleLowerCase();
  return normalized.endsWith(".ir.json") || ROOT_BUILD_REVIEW_ARTIFACTS.has(normalized);
}

async function readRegularContainedFile(root: string, path: string): Promise<string | undefined> {
  const original = await lstat(path);
  if (
    original.isSymbolicLink()
    || !original.isFile()
    || original.nlink !== 1
    || original.size > MAX_TEXT_BYTES
  ) return undefined;
  const canonical = await realpath(path);
  assertContained(root, canonical);
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(canonical, fsConstants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (
      !info.isFile()
      || info.nlink !== 1
      || info.size > MAX_TEXT_BYTES
      || !sameRegularFileIdentity(original, info)
    ) return undefined;
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    if (after.nlink !== 1 || !sameRegularFileIdentity(info, after)) return undefined;
    return content;
  } finally {
    await handle.close();
  }
}

async function observeTextPath(path: string): Promise<{ exists: boolean; content: string; sha256: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "", sha256: sha256("") };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error("Only single-link regular workspace files can be changed.");
  }
  if (info.size > MAX_TEXT_BYTES) throw new Error("File exceeds the 2 MiB text review limit.");
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.size > MAX_TEXT_BYTES
      || !sameRegularFileIdentity(info, opened)
    ) {
      throw new Error("Only bounded single-link workspace files can be changed.");
    }
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    if (after.nlink !== 1 || !sameRegularFileIdentity(opened, after)) {
      throw new Error("The workspace file changed while it was being read.");
    }
    return { exists: true, content, sha256: sha256(content) };
  } finally {
    await handle.close();
  }
}

async function replaceTextPathCas(
  path: string,
  input: {
    expectedExists: boolean;
    expectedSha256: string;
    resultExists: boolean;
    content: string;
  },
): Promise<void> {
  const before = await observeTextPath(path);
  if (before.exists !== input.expectedExists || before.sha256 !== input.expectedSha256) {
    throw new Error("The workspace file changed before the controlled write began.");
  }
  if (!input.resultExists) {
    if (before.exists) await unlink(path);
    const afterDelete = await observeTextPath(path);
    if (afterDelete.exists) throw new Error("The approved file removal did not complete.");
    return;
  }

  const temporaryPath = join(dirname(path), `.${basename(path)}.proto-${randomUUID()}.tmp`);
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(input.content, "utf8");
    await handle.sync();
    const prepared = await handle.stat();
    if (!prepared.isFile() || prepared.nlink !== 1) {
      throw new Error("The prepared workspace result is not a single-link regular file.");
    }
  } finally {
    await handle.close();
  }
  try {
    const stillCurrent = await observeTextPath(path);
    if (stillCurrent.exists !== input.expectedExists || stillCurrent.sha256 !== input.expectedSha256) {
      throw new Error("The workspace file changed while the reviewed result was being prepared.");
    }
    const prepared = await lstat(temporaryPath);
    if (prepared.isSymbolicLink() || !prepared.isFile() || prepared.nlink !== 1) {
      throw new Error("The prepared workspace result is not a single-link regular file.");
    }
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function sameRegularFileIdentity(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mediaTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLocaleLowerCase();
  return (
    {
      proto: "text/x-proto",
      md: "text/markdown",
      txt: "text/plain",
      json: "application/json",
      csv: "text/csv",
      ts: "text/typescript",
      tsx: "text/typescript",
      js: "text/javascript",
      mjs: "text/javascript",
      py: "text/x-python",
      r: "text/x-r",
      ipynb: "application/x-ipynb+json",
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
    } as Record<string, string>
  )[extension] ?? "application/octet-stream";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
