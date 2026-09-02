import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  ModuleArtifactHash,
  ModuleIntegrityManifest,
  ModuleIntegrityReport,
  ModuleIntegrityResult,
  ModuleManifestEntry,
  WorkbenchModuleDescriptor,
} from "../../shared/modules.ts";
import { CORE_MODULES, OPTIONAL_MODULES } from "../../shared/modules.ts";

export async function verifyModuleIntegrity(options: {
  appRoot: string;
  resourceRoot: string;
  enforce: boolean;
  expectedAppVersion?: string;
}): Promise<ModuleIntegrityReport> {
  const manifestPath = join(options.appRoot, "out", "module-manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    return options.enforce
      ? unavailableReport(manifestPath, "missing", `Required module integrity manifest is unavailable: ${error}`)
      : developmentReport(manifestPath, `Development manifest unavailable: ${error}`);
  }

  let manifest: ModuleIntegrityManifest;
  try {
    manifest = JSON.parse(raw) as ModuleIntegrityManifest;
  } catch (error) {
    return options.enforce
      ? unavailableReport(manifestPath, "tampered", `Module integrity manifest is invalid JSON: ${error}`)
      : developmentReport(manifestPath, `Development manifest invalid: ${error}`);
  }
  if (!isSupportedManifest(manifest)) {
    return options.enforce
      ? unavailableReport(manifestPath, "tampered", "Module integrity manifest has an unsupported schema or hash algorithm.", raw)
      : developmentReport(manifestPath, "Development manifest has an unsupported schema or hash algorithm.");
  }

  const knownModules = new Map<string, WorkbenchModuleDescriptor>(
    [...CORE_MODULES, ...OPTIONAL_MODULES].map((module) => [module.id, module]),
  );
  const artifactCache = new Map<string, Promise<ArtifactVerification>>();
  const results: ModuleIntegrityResult[] = [];
  const manifestIds = manifest.modules.map((entry) => entry?.moduleId);
  const duplicateIds = new Set(manifestIds.filter((id, index) => manifestIds.indexOf(id) !== index));
  const unknownIds = manifestIds.filter((id) => typeof id === "string" && !knownModules.has(id));

  for (const expected of knownModules.values()) {
    const entry = manifest.modules.find((candidate) => candidate?.moduleId === expected.id);
    if (!entry) {
      results.push(resultFor(expected, "missing", 0, ["Module is absent from the embedded integrity manifest."]));
      continue;
    }
    const diagnostics: string[] = [];
    let status: ModuleIntegrityResult["status"] = "verified";
    if (entry.version !== expected.version || entry.core !== expected.core) {
      status = "tampered";
      diagnostics.push("Module identity metadata does not match the compiled registry.");
    }
    if (duplicateIds.has(expected.id)) {
      status = "tampered";
      diagnostics.push("Module ID appears more than once in the integrity manifest.");
    }
    if (!Array.isArray(entry.artifacts) || !entry.artifacts.length) {
      status = "missing";
      diagnostics.push("Module has no audited artifacts.");
    }
    const descriptorPath = `runtime/modules/${expected.id}.json`;
    if (!Array.isArray(entry.artifacts)
      || !entry.artifacts.some((artifact) => artifact?.scope === "resource" && artifact?.path === descriptorPath)) {
      status = "tampered";
      diagnostics.push("Module is not bound to its independent identity descriptor.");
    }
    if (typeof entry.moduleSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.moduleSha256)) {
      status = "tampered";
      diagnostics.push("Module-level SHA-256 is missing or malformed.");
    } else if (!Array.isArray(entry.artifacts) || entry.moduleSha256 !== moduleDigest(entry)) {
      status = "tampered";
      diagnostics.push("Module-level SHA-256 does not match its artifact identity list.");
    }

    for (const artifact of Array.isArray(entry.artifacts) ? entry.artifacts : []) {
      if (!isArtifactHash(artifact)) {
        status = "tampered";
        diagnostics.push("Module contains a malformed artifact record.");
        continue;
      }
      const key = `${artifact.scope}:${artifact.path}`;
      let verification = artifactCache.get(key);
      if (!verification) {
        verification = verifyArtifact(artifact, options.appRoot, options.resourceRoot);
        artifactCache.set(key, verification);
      }
      const outcome = await verification;
      if (outcome.status === "missing") status = "missing";
      else if (outcome.status === "tampered" && status !== "missing") status = "tampered";
      if (outcome.diagnostic) diagnostics.push(outcome.diagnostic);
    }
    const descriptorOutcome = await verifyModuleDescriptor(expected, options.resourceRoot);
    if (descriptorOutcome.status === "missing") status = "missing";
    else if (descriptorOutcome.status === "tampered" && status !== "missing") status = "tampered";
    if (descriptorOutcome.diagnostic) diagnostics.push(descriptorOutcome.diagnostic);
    results.push(resultFor(
      expected,
      status,
      Array.isArray(entry.artifacts) ? entry.artifacts.length : 0,
      [...new Set(diagnostics)].slice(0, 20),
      entry.moduleSha256,
    ));
  }

  const auditResult = results.find((result) => result.moduleId === "core.audit");
  if (auditResult && unknownIds.length) {
    markTampered(auditResult, `Unknown module IDs are present: ${[...new Set(unknownIds)].join(", ")}`);
  }
  if (auditResult && options.expectedAppVersion && manifest.appVersion !== options.expectedAppVersion) {
    markTampered(
      auditResult,
      `Manifest app version ${manifest.appVersion} does not match packaged app version ${options.expectedAppVersion}.`,
    );
  }

  const coreFailures = results.filter((result) => result.core && result.status !== "verified");
  return {
    ok: coreFailures.length === 0,
    enforced: options.enforce,
    manifestPath,
    checkedAt: new Date().toISOString(),
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    manifestAppVersion: manifest.appVersion,
    manifestGeneratedAt: manifest.generatedAt,
    modules: results,
  };
}

type ArtifactVerification = { status: "verified" | "missing" | "tampered"; diagnostic?: string };

async function verifyArtifact(
  artifact: ModuleArtifactHash,
  appRoot: string,
  resourceRoot: string,
): Promise<ArtifactVerification> {
  const base = artifact.scope === "app" ? appRoot : resourceRoot;
  const normalizedPath = normalize(artifact.path);
  if (isAbsolute(normalizedPath) || normalizedPath.split(/[\\/]/).includes("..")) {
    return { status: "tampered", diagnostic: `Unsafe manifest path: ${artifact.path}` };
  }
  const absolute = resolve(base, normalizedPath);
  const relativePath = relative(resolve(base), absolute);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { status: "tampered", diagnostic: `Artifact escapes its integrity root: ${artifact.path}` };
  }
  try {
    const metadata = await stat(absolute);
    if (!metadata.isFile()) return { status: "missing", diagnostic: `Artifact is not a file: ${artifact.path}` };
    if (metadata.size !== artifact.sizeBytes) {
      return { status: "tampered", diagnostic: `Size mismatch: ${artifact.path}` };
    }
    const digest = await sha256File(absolute);
    if (digest !== artifact.sha256) return { status: "tampered", diagnostic: `SHA-256 mismatch: ${artifact.path}` };
    return { status: "verified" };
  } catch (error) {
    return { status: "missing", diagnostic: `Missing artifact ${artifact.path}: ${error}` };
  }
}

async function verifyModuleDescriptor(
  expected: WorkbenchModuleDescriptor,
  resourceRoot: string,
): Promise<ArtifactVerification> {
  const path = join(resourceRoot, "runtime", "modules", `${expected.id}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return { status: "missing", diagnostic: `Module identity descriptor is unavailable: ${error}` };
  }
  try {
    const descriptor = JSON.parse(raw) as Record<string, unknown>;
    const tools = Array.isArray(descriptor.tools)
      ? descriptor.tools.filter((tool): tool is string => typeof tool === "string").sort()
      : [];
    const expectedTools = [...expected.tools].sort();
    const matches = descriptor.schemaVersion === "proto-workbench.module.v1"
      && descriptor.moduleId === expected.id
      && descriptor.version === expected.version
      && descriptor.core === expected.core
      && descriptor.label === expected.label
      && descriptor.resourceTier === expected.resourceTier
      && JSON.stringify(tools) === JSON.stringify(expectedTools);
    return matches
      ? { status: "verified" }
      : { status: "tampered", diagnostic: "Module identity descriptor does not match the compiled registry." };
  } catch (error) {
    return { status: "tampered", diagnostic: `Module identity descriptor is invalid JSON: ${error}` };
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function moduleDigest(entry: Pick<ModuleManifestEntry, "moduleId" | "version" | "core" | "artifacts">): string {
  const canonical = {
    moduleId: entry.moduleId,
    version: entry.version,
    core: entry.core,
    artifacts: [...entry.artifacts]
      .filter(isArtifactHash)
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

function resultFor(
  module: WorkbenchModuleDescriptor,
  status: ModuleIntegrityResult["status"],
  checkedArtifacts: number,
  diagnostics: string[],
  moduleSha256?: string,
): ModuleIntegrityResult {
  return {
    moduleId: module.id,
    version: module.version,
    core: module.core,
    status,
    disposition: dispositionFor(module.core, status),
    moduleSha256,
    checkedArtifacts,
    diagnostics,
  };
}

function dispositionFor(
  core: boolean,
  status: ModuleIntegrityResult["status"],
): ModuleIntegrityResult["disposition"] {
  if (status === "not-audited") return "not-audited";
  if (status === "verified") return core ? "loaded" : "available";
  return core ? "blocked-startup" : "quarantined";
}

function markTampered(result: ModuleIntegrityResult, diagnostic: string): void {
  if (result.status !== "missing") result.status = "tampered";
  result.disposition = "blocked-startup";
  result.diagnostics = [...new Set([...result.diagnostics, diagnostic])].slice(0, 20);
}

function isSupportedManifest(value: unknown): value is ModuleIntegrityManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<ModuleIntegrityManifest>;
  return manifest.schemaVersion === "proto-workbench.modules.v1"
    && manifest.hashAlgorithm === "SHA-256"
    && typeof manifest.appVersion === "string"
    && typeof manifest.generatedAt === "string"
    && Array.isArray(manifest.modules);
}

function isArtifactHash(value: unknown): value is ModuleArtifactHash {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<ModuleArtifactHash>;
  return (artifact.scope === "app" || artifact.scope === "resource")
    && typeof artifact.path === "string"
    && Number.isSafeInteger(artifact.sizeBytes)
    && Number(artifact.sizeBytes) >= 0
    && typeof artifact.sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(artifact.sha256);
}

function developmentReport(manifestPath: string, diagnostic: string): ModuleIntegrityReport {
  return {
    ok: true,
    enforced: false,
    manifestPath,
    checkedAt: new Date().toISOString(),
    modules: [...CORE_MODULES, ...OPTIONAL_MODULES].map((module) =>
      resultFor(module, "not-audited", 0, [diagnostic])),
  };
}

function unavailableReport(
  manifestPath: string,
  status: "missing" | "tampered",
  diagnostic: string,
  raw?: string,
): ModuleIntegrityReport {
  return {
    ok: false,
    enforced: true,
    manifestPath,
    checkedAt: new Date().toISOString(),
    manifestSha256: raw ? createHash("sha256").update(raw).digest("hex") : undefined,
    modules: [...CORE_MODULES, ...OPTIONAL_MODULES].map((module) =>
      resultFor(module, status, 0, [diagnostic])),
  };
}
