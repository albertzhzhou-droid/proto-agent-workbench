import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const ALL_FILES_FILTER = "**/*";
const JSON_FILES_FILTER = "**/*.json";

export async function collectConfiguredExtraResources(projectRoot, packageJson) {
  const entries = packageJson?.build?.extraResources;
  if (!Array.isArray(entries)) throw new Error("Package extraResources must be an array.");

  const resources = [];
  for (const entry of entries) {
    resources.push(...await collectConfiguredEntry(projectRoot, entry));
  }
  return uniqueDestinations(resources);
}

export async function collectConfiguredRuntimeResources(projectRoot, packageJson) {
  return (await collectConfiguredExtraResources(projectRoot, packageJson))
    .filter((resource) => resource.path === "runtime" || resource.path.startsWith("runtime/"));
}

export async function collectTreeFiles(projectRoot, sourceRelative, targetRelative, filter = [ALL_FILES_FILTER]) {
  const sourcePath = safeSourcePath(projectRoot, sourceRelative);
  const targetPath = safePackagePath(targetRelative, "package target");
  const matcher = filterMatcher(filter);
  const metadata = await lstat(sourcePath);
  if (metadata.isSymbolicLink()) throw new Error(`Package input cannot be a symbolic link: ${sourceRelative}`);

  if (metadata.isFile()) {
    const name = sourceRelative.split("/").at(-1) ?? sourceRelative;
    if (!matcher(name)) return [];
    return [{ path: targetPath, sourcePath: safePackagePath(sourceRelative, "package source") }];
  }
  if (!metadata.isDirectory()) throw new Error(`Package input is not a regular file or directory: ${sourceRelative}`);

  const files = [];
  await visit(sourcePath, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Package input cannot contain symbolic links: ${sourceRelative}/${relativePath}`);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() && matcher(relativePath)) {
        files.push({
          path: `${targetPath}/${relativePath}`,
          sourcePath: `${safePackagePath(sourceRelative, "package source")}/${relativePath}`,
        });
      } else if (!entry.isFile()) {
        throw new Error(`Package input contains an unsupported filesystem entry: ${sourceRelative}/${relativePath}`);
      }
    }
  }
}

async function collectConfiguredEntry(projectRoot, entry) {
  if (!entry || typeof entry !== "object" || typeof entry.from !== "string" || typeof entry.to !== "string") {
    throw new Error("Every extraResources entry must have string from and to paths.");
  }
  const source = safePackagePath(entry.from, "extraResources source");
  const target = safePackagePath(entry.to, "extraResources target");
  return collectTreeFiles(projectRoot, source, target, entry.filter);
}

function filterMatcher(value) {
  const filters = value === undefined ? [ALL_FILES_FILTER] : value;
  if (!Array.isArray(filters) || filters.some((filter) => typeof filter !== "string")) {
    throw new Error("extraResources filters must be an array of strings.");
  }
  const unique = [...new Set(filters)];
  if (unique.length !== 1 || (unique[0] !== ALL_FILES_FILTER && unique[0] !== JSON_FILES_FILTER)) {
    throw new Error(`Unsupported extraResources filter: ${unique.join(", ") || "<empty>"}`);
  }
  return unique[0] === ALL_FILES_FILTER
    ? () => true
    : (path) => path.toLowerCase().endsWith(".json");
}

function safeSourcePath(projectRoot, sourceRelative) {
  const root = resolve(projectRoot);
  const source = safePackagePath(sourceRelative, "package source");
  const absolute = resolve(root, ...source.split("/"));
  const fromRoot = relative(root, absolute);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`Package source escapes the project root: ${sourceRelative}`);
  return absolute;
}

function safePackagePath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty relative path.`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (isAbsolute(value) || /^[a-z]:/i.test(normalized) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path: ${value}`);
  }
  return parts.join("/").split(sep).join("/");
}

function uniqueDestinations(resources) {
  const byPath = new Map();
  for (const resource of resources) {
    if (byPath.has(resource.path)) throw new Error(`Two extraResources inputs target the same path: ${resource.path}`);
    byPath.set(resource.path, resource);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
