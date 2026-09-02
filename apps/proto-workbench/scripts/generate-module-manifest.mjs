import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_MODULES, OPTIONAL_MODULES } from "../src/shared/modules.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const outputPath = join(projectRoot, "out", "module-manifest.json");
const allModules = [...CORE_MODULES, ...OPTIONAL_MODULES];
const moduleDescriptorRoot = join(projectRoot, "runtime", "modules");
await writeModuleDescriptors(moduleDescriptorRoot, allModules);

const appFiles = await collectFiles(join(projectRoot, "out"), "app", projectRoot, (path) => path !== outputPath);
const llamaFiles = await collectFiles(join(projectRoot, "runtime", "llama.cpp"), "resource", projectRoot);
const protoFiles = await collectFiles(join(projectRoot, "runtime", "proto-agent"), "resource", projectRoot);
const templateFiles = await collectFiles(join(projectRoot, "runtime", "workspace-template"), "resource", projectRoot);
const descriptorFiles = await collectFiles(moduleDescriptorRoot, "resource", projectRoot);
const hashCache = new Map();

async function materialize(files) {
  return Promise.all(files.map(async (file) => {
    const key = `${file.scope}:${file.path}`;
    if (!hashCache.has(key)) {
      const absolute = join(projectRoot, ...file.sourcePath.split("/"));
      const metadata = await stat(absolute);
      hashCache.set(key, {
        scope: file.scope,
        path: file.path,
        sizeBytes: metadata.size,
        sha256: await sha256File(absolute),
      });
    }
    return hashCache.get(key);
  }));
}

const groups = {
  app: await materialize(appFiles),
  llama: await materialize(llamaFiles),
  proto: await materialize(protoFiles),
  template: await materialize(templateFiles),
  descriptors: await materialize(descriptorFiles),
};

const modules = allModules.map((module) => {
  const entry = {
    moduleId: module.id,
    version: module.version,
    core: module.core,
    artifacts: artifactsForModule(module.id),
  };
  return { ...entry, moduleSha256: moduleDigest(entry) };
});

const manifest = {
  schemaVersion: "proto-workbench.modules.v1",
  appVersion: packageJson.version,
  generatedAt: new Date().toISOString(),
  hashAlgorithm: "SHA-256",
  modules,
};

const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(outputPath, serializedManifest, "utf8");
const manifestSha256 = createHash("sha256").update(serializedManifest).digest("hex");
process.stdout.write(`Module manifest: ${relative(projectRoot, outputPath)} (${modules.length} modules, SHA-256 ${manifestSha256})\n`);

function artifactsForModule(moduleId) {
  const descriptor = groups.descriptors.filter((artifact) => artifact.path === `runtime/modules/${moduleId}.json`);
  if (moduleId === "core.audit" || moduleId === "core.workspace" || moduleId === "core.governance") {
    return uniqueArtifacts([...descriptor, ...groups.app]);
  }
  if (moduleId === "core.inference") return uniqueArtifacts([...descriptor, ...groups.app, ...groups.llama]);
  if (moduleId === "core.validation" || moduleId === "core.review") {
    return uniqueArtifacts([...descriptor, ...groups.proto, ...groups.template]);
  }
  if (moduleId === "media.vision") return uniqueArtifacts([...descriptor, ...groups.app, ...groups.llama]);
  return uniqueArtifacts([...descriptor, ...groups.proto]);
}

function uniqueArtifacts(artifacts) {
  return [...new Map(artifacts.map((artifact) => [`${artifact.scope}:${artifact.path}`, artifact])).values()];
}

async function collectFiles(root, scope, base, include = () => true) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, scope, base, include));
    else if (entry.isFile() && include(absolute)) {
      const sourcePath = relative(base, absolute).split(sep).join("/");
      files.push({ scope, path: sourcePath, sourcePath });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function moduleDigest(entry) {
  const canonical = {
    moduleId: entry.moduleId,
    version: entry.version,
    core: entry.core,
    artifacts: [...entry.artifacts]
      .sort((left, right) => `${left.scope}:${left.path}`.localeCompare(`${right.scope}:${right.path}`))
      .map((artifact) => ({
        scope: artifact.scope,
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function writeModuleDescriptors(root, modules) {
  await mkdir(root, { recursive: true });
  await Promise.all(modules.map(async (module) => {
    const descriptor = {
      schemaVersion: "proto-workbench.module.v1",
      moduleId: module.id,
      version: module.version,
      core: module.core,
      label: module.label,
      resourceTier: module.resourceTier,
      tools: [...module.tools].sort(),
    };
    await writeFile(join(root, `${module.id}.json`), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  }));
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
