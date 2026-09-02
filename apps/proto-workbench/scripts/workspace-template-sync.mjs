import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_APP_ROOT = resolve(scriptRoot, "..");
export const DEFAULT_REPOSITORY_ROOT = resolve(DEFAULT_APP_ROOT, "..", "..");
export const DEFAULT_WORKSPACE_TEMPLATE_ROOT = join(DEFAULT_APP_ROOT, "runtime", "workspace-template");

export const MANAGED_WORKSPACE_FILES = Object.freeze([
  "connectors/proto_workbench.json",
  "workflows/design_review.json",
]);

export const MANAGED_SKILL_ROOT = ".codex/skills";

function slash(path) {
  return path.split(sep).join("/");
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

async function collectTree(root, label) {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${root}`);
  }

  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} cannot contain symbolic links: ${absolute}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${label} can contain only directories and regular files: ${absolute}`);
      }
      const content = await readFile(absolute);
      files.push({
        path: slash(relative(root, absolute)),
        content,
        sizeBytes: content.byteLength,
        sha256: digest(content),
      });
    }
  }

  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function captureManagedSnapshot(root, label) {
  const files = [];
  for (const managedPath of MANAGED_WORKSPACE_FILES) {
    const absolute = join(root, ...managedPath.split("/"));
    await assertRegularFile(absolute, `${label} managed asset`);
    const content = await readFile(absolute);
    files.push({
      path: managedPath,
      content,
      sizeBytes: content.byteLength,
      sha256: digest(content),
    });
  }

  const skillFiles = await collectTree(join(root, ...MANAGED_SKILL_ROOT.split("/")), `${label} Skill tree`);
  if (skillFiles.length === 0) throw new Error(`${label} Skill tree cannot be empty.`);
  for (const file of skillFiles) {
    files.push({ ...file, path: `${MANAGED_SKILL_ROOT}/${file.path}` });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function compareSnapshots(expected, actual, expectedLabel, actualLabel) {
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  const errors = [];

  for (const path of [...expectedByPath.keys()].sort()) {
    const expectedFile = expectedByPath.get(path);
    const actualFile = actualByPath.get(path);
    if (!actualFile) {
      errors.push(`${actualLabel} is missing ${path}`);
      continue;
    }
    if (actualFile.sha256 !== expectedFile.sha256 || actualFile.sizeBytes !== expectedFile.sizeBytes) {
      errors.push(
        `${path} hash mismatch (${expectedLabel} ${expectedFile.sha256}, ${actualLabel} ${actualFile.sha256})`,
      );
    }
  }

  for (const path of [...actualByPath.keys()].sort()) {
    if (!expectedByPath.has(path)) errors.push(`${actualLabel} contains unmanaged extra file ${path}`);
  }
  if (errors.length > 0) throw new Error(`Workspace template verification failed:\n- ${errors.join("\n- ")}`);
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.sync-${process.pid}.tmp`;
  try {
    await writeFile(temporary, content);
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeSkillSnapshot(templateRoot, sourceSnapshot) {
  const target = join(templateRoot, ...MANAGED_SKILL_ROOT.split("/"));
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const staged = await mkdtemp(join(parent, ".skills-sync-"));
  try {
    for (const file of sourceSnapshot) {
      if (!file.path.startsWith(`${MANAGED_SKILL_ROOT}/`)) continue;
      const relativePath = file.path.slice(MANAGED_SKILL_ROOT.length + 1);
      const destination = join(staged, ...relativePath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyWorkspaceTemplate({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  templateRoot = DEFAULT_WORKSPACE_TEMPLATE_ROOT,
} = {}) {
  const source = await captureManagedSnapshot(repositoryRoot, "repository source");
  const template = await captureManagedSnapshot(templateRoot, "packaged workspace template");
  compareSnapshots(source, template, "source", "template");
  return {
    schemaVersion: "proto-workbench.workspace-template.v1",
    fileCount: source.length,
    skillFileCount: source.filter((file) => file.path.startsWith(`${MANAGED_SKILL_ROOT}/`)).length,
    files: source.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })),
  };
}

export async function syncWorkspaceTemplate({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  templateRoot = DEFAULT_WORKSPACE_TEMPLATE_ROOT,
} = {}) {
  const sourceBefore = await captureManagedSnapshot(repositoryRoot, "repository source");
  for (const managedPath of MANAGED_WORKSPACE_FILES) {
    const source = sourceBefore.find((file) => file.path === managedPath);
    await atomicWrite(join(templateRoot, ...managedPath.split("/")), source.content);
  }
  await writeSkillSnapshot(templateRoot, sourceBefore);

  // A concurrent source mutation must fail the build instead of producing an A/B
  // package assembled from different repository states.
  const sourceAfter = await captureManagedSnapshot(repositoryRoot, "repository source after synchronization");
  compareSnapshots(sourceBefore, sourceAfter, "source before sync", "source after sync");
  return verifyWorkspaceTemplate({ repositoryRoot, templateRoot });
}
