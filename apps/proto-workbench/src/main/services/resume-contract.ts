import { createHash } from "node:crypto";
import type {
  AgentThread,
  MissionCapabilitySnapshot,
  MissionRecipe,
  ModelDescriptor,
  ResumeContract,
  ResumeDrift,
  RuntimeStatus,
  RunCheckpoint,
} from "../../shared/contracts.ts";
import type { ModuleIntegrityReport } from "../../shared/modules.ts";
import type { McpCapabilities } from "./mcp-client.ts";
import { classifyMissionIntent } from "./mission-preflight.ts";

export interface MissionCapabilityInputs {
  workspaceIdentity: string;
  model?: ModelDescriptor;
  runtime: RuntimeStatus;
  moduleIntegrity: ModuleIntegrityReport;
  capabilities: McpCapabilities;
  toolNames: string[];
}

export interface MissionRecipeInputs extends MissionCapabilityInputs {
  thread: AgentThread;
  goal: string;
  createdAt?: string;
}

export function buildMissionCapabilitySnapshot(input: MissionCapabilityInputs): MissionCapabilitySnapshot {
  const tools = [...new Set(input.toolNames.map(normalizeText).filter(Boolean))].sort();
  if (tools.length > 256 || tools.some((name) => name.length > 256)) {
    throw new Error("Mission capability snapshots are limited to 256 bounded tool names.");
  }
  const moduleSet = input.moduleIntegrity.modules
    .map((module) => ({
      id: module.moduleId,
      version: module.version,
      core: module.core,
      status: module.status,
      sha256: module.moduleSha256 ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const body = {
    schema: "proto-workbench.mission-capabilities.v1" as const,
    workspaceIdentity: input.workspaceIdentity,
    model: input.model ? {
      id: input.model.id,
      fingerprint: input.model.fingerprint,
      toolCapability: input.model.toolCapability,
      vision: input.model.vision,
      active: input.model.loadState === "active",
    } : undefined,
    runtime: {
      available: input.runtime.available,
      backend: input.runtime.backend,
      degraded: Boolean(input.runtime.degraded),
    },
    integrity: {
      ok: input.moduleIntegrity.ok,
      enforced: input.moduleIntegrity.enforced,
      manifestSha256: input.moduleIntegrity.manifestSha256,
      moduleSetSha256: sha256(stableJson(moduleSet)),
    },
    tools: {
      names: tools,
      digest: sha256(stableJson(tools)),
    },
    network: {
      enabled: input.capabilities.networkEnabled,
      authorization: input.capabilities.networkAuthorization,
    },
    filesystem: {
      relativePathsOnly: input.capabilities.filesystemSafety.relativePathsOnly,
      reparsePointsAllowed: input.capabilities.filesystemSafety.reparsePointsAllowed,
      atomicReplace: input.capabilities.filesystemSafety.atomicReplace,
    },
    execution: {
      mode: input.capabilities.execution.mode,
      available: input.capabilities.execution.available,
      configured: input.capabilities.execution.configured,
      providerVisible: input.capabilities.execution.provider_visible,
      imageDigestPinned: input.capabilities.execution.image_digest_pinned,
      smokeVerified: input.capabilities.execution.smoke_verified,
    },
  };
  return { ...body, digest: sha256(stableJson(body)) };
}

export function buildMissionRecipe(input: MissionRecipeInputs): MissionRecipe {
  const goal = normalizeText(input.goal);
  if (!goal || goal.length > 32_768) throw new Error("A bounded mission goal is required for a reusable recipe.");
  const title = normalizeText(input.thread.title);
  if (!title || title.length > 200) throw new Error("The mission recipe title is invalid.");
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!validTimestamp(createdAt)) throw new Error("The mission recipe timestamp is invalid.");
  const body = {
    schema: "proto-workbench.mission-recipe.v1" as const,
    title,
    mode: input.thread.mode,
    goal,
    goalSha256: sha256(goal),
    intent: classifyMissionIntent(goal),
    capabilities: buildMissionCapabilitySnapshot(input),
    createdAt,
  };
  return { ...body, digest: sha256(stableJson(body)) };
}

export function buildResumeContract(
  checkpoint: RunCheckpoint,
  currentCapabilities: MissionCapabilitySnapshot,
): ResumeContract {
  const source = checkpoint.missionRecipe?.capabilities;
  const drift: ResumeDrift[] = [
    compare(
      "workspace",
      "Workspace identity",
      source?.workspaceIdentity,
      currentCapabilities.workspaceIdentity,
      source ? shortHash(source.workspaceIdentity) : "Not captured",
      shortHash(currentCapabilities.workspaceIdentity),
      "A child task must remain bound to the exact canonical workspace identity.",
      source && source.workspaceIdentity !== currentCapabilities.workspaceIdentity ? "blocked" : source ? "stable" : "unavailable",
      "launchpad",
    ),
    compare(
      "integrity",
      "Module integrity",
      source ? `${source.integrity.manifestSha256 ?? "development"}:${source.integrity.moduleSetSha256}` : undefined,
      `${currentCapabilities.integrity.manifestSha256 ?? "development"}:${currentCapabilities.integrity.moduleSetSha256}`,
      source ? integrityLabel(source) : "Not captured",
      integrityLabel(currentCapabilities),
      !currentCapabilities.integrity.ok
        ? "Current core-module integrity is not trusted. Recovery stays blocked."
        : "Module identity is compared before any child task is created.",
      !currentCapabilities.integrity.ok ? "blocked" : undefined,
      "settings",
    ),
    compare(
      "model",
      "Model identity",
      source?.model ? `${source.model.id}:${source.model.fingerprint}:${source.model.active}` : source ? "none" : undefined,
      currentCapabilities.model ? `${currentCapabilities.model.id}:${currentCapabilities.model.fingerprint}:${currentCapabilities.model.active}` : "none",
      source?.model ? `${source.model.id} · ${shortHash(source.model.fingerprint)}` : source ? "No model" : "Not captured",
      currentCapabilities.model ? `${currentCapabilities.model.id} · ${currentCapabilities.model.active ? "active" : "not active"}` : "No active model",
      "Model changes do not mutate the checkpoint, but the resumed mission must pass a fresh launch preflight.",
      undefined,
      "models",
    ),
    compare(
      "runtime",
      "Inference runtime",
      source ? stableJson(source.runtime) : undefined,
      stableJson(currentCapabilities.runtime),
      source ? runtimeLabel(source) : "Not captured",
      runtimeLabel(currentCapabilities),
      "Runtime availability is rechecked; no inference starts while creating the child task.",
    ),
    compare(
      "tools",
      "Tool surface",
      source?.tools.digest,
      currentCapabilities.tools.digest,
      source ? `${source.tools.names.length} tools · ${shortHash(source.tools.digest)}` : "Not captured",
      `${currentCapabilities.tools.names.length} tools · ${shortHash(currentCapabilities.tools.digest)}`,
      "Added or removed tools require review because replayed reasoning may choose a different path.",
    ),
    compare(
      "network",
      "Network authorization",
      source ? stableJson(source.network) : undefined,
      stableJson(currentCapabilities.network),
      source ? networkLabel(source) : "Not captured",
      networkLabel(currentCapabilities),
      "A restored task never inherits a previous network approval; every live call needs a fresh capability.",
    ),
    compare(
      "filesystem",
      "Filesystem safety",
      source ? stableJson(source.filesystem) : undefined,
      stableJson(currentCapabilities.filesystem),
      source ? filesystemLabel(source) : "Not captured",
      filesystemLabel(currentCapabilities),
      filesystemSafe(currentCapabilities)
        ? "Path containment and atomic replacement remain independently enforced."
        : "The current sidecar does not report the required contained filesystem contract.",
      filesystemSafe(currentCapabilities) ? undefined : "blocked",
      "settings",
    ),
    compare(
      "execution",
      "Execution boundary",
      source ? stableJson(source.execution) : undefined,
      stableJson(currentCapabilities.execution),
      source ? executionLabel(source) : "Not captured",
      executionLabel(currentCapabilities),
      currentCapabilities.execution.mode === "unsafe-host"
        ? "Unsafe host execution cannot be inherited by a resumed task."
        : "Execution remains disabled unless a digest-pinned OCI boundary and a fresh approval are available.",
      currentCapabilities.execution.mode === "unsafe-host" ? "blocked" : undefined,
      "settings",
    ),
  ];
  const blocked = drift.some((item) => item.state === "blocked");
  const changed = drift.some((item) => item.state === "changed" || item.state === "unavailable");
  const state = blocked ? "blocked" as const : changed ? "review-required" as const : "ready" as const;
  const warnings = checkpoint.missionRecipe
    ? []
    : ["This legacy checkpoint predates Mission Recipe capture. Its task history is immutable, but historical capabilities are unavailable and must be treated as changed."];
  const digestPayload = {
    schema: "proto-workbench.resume-contract.v1",
    checkpointId: checkpoint.id,
    checkpointSnapshotDigest: checkpoint.snapshotDigest,
    recipeDigest: checkpoint.missionRecipe?.digest ?? null,
    currentCapabilityDigest: currentCapabilities.digest,
    drift: drift.map(({ id, state: driftState }) => ({ id, state: driftState })),
    state,
  };
  return {
    schema: "proto-workbench.resume-contract.v1",
    digest: sha256(stableJson(digestPayload)),
    issuedAt: new Date().toISOString(),
    checkpointId: checkpoint.id,
    checkpointSnapshotDigest: checkpoint.snapshotDigest,
    recipeDigest: checkpoint.missionRecipe?.digest,
    state,
    launchable: !blocked,
    currentCapabilities,
    drift,
    warnings,
    nextAction: blocked
      ? drift.find((item) => item.state === "blocked")?.detail ?? "Resolve the blocked trust boundary and review again."
      : changed
        ? "Review the capability drift, then create a non-executing child task. Its first mission still requires a fresh Mission Preflight."
        : "Create a non-executing child task from this exact recipe. Later effects remain separately approval-gated.",
  };
}

export function assertMissionRecipe(value: unknown): asserts value is MissionRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored mission recipe is malformed.");
  const recipe = value as MissionRecipe;
  if (recipe.schema !== "proto-workbench.mission-recipe.v1"
    || !sha256String(recipe.digest)
    || !recipe.title || recipe.title.length > 200
    || (recipe.mode !== "plan" && recipe.mode !== "act")
    || !recipe.goal || recipe.goal.length > 32_768
    || recipe.goalSha256 !== sha256(recipe.goal)
    || !validTimestamp(recipe.createdAt)
    || typeof recipe.intent?.network !== "boolean"
    || typeof recipe.intent?.writes !== "boolean"
    || typeof recipe.intent?.execution !== "boolean"
    || stableJson(recipe.intent) !== stableJson(classifyMissionIntent(recipe.goal))
    || normalizeText(recipe.goal) !== recipe.goal
    || normalizeText(recipe.title) !== recipe.title) {
    throw new Error("Stored mission recipe is malformed.");
  }
  assertCapabilitySnapshot(recipe.capabilities);
  const { digest: _digest, ...body } = recipe;
  if (sha256(stableJson(body)) !== recipe.digest) throw new Error("Stored mission recipe does not match its digest.");
}

export function assertCapabilitySnapshot(value: unknown): asserts value is MissionCapabilitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored mission capability snapshot is malformed.");
  const snapshot = value as MissionCapabilitySnapshot;
  if (snapshot.schema !== "proto-workbench.mission-capabilities.v1"
    || !sha256String(snapshot.digest)
    || !sha256String(snapshot.workspaceIdentity)
    || !sha256String(snapshot.integrity?.moduleSetSha256)
    || (snapshot.integrity.manifestSha256 !== undefined && !sha256String(snapshot.integrity.manifestSha256))
    || !Array.isArray(snapshot.tools?.names)
    || snapshot.tools.names.length > 256
    || snapshot.tools.names.some((name) => typeof name !== "string" || !name || name.length > 256)
    || stableJson([...new Set(snapshot.tools.names)].sort()) !== stableJson(snapshot.tools.names)
    || snapshot.tools.digest !== sha256(stableJson(snapshot.tools.names))
    || typeof snapshot.runtime?.available !== "boolean"
    || (snapshot.runtime.backend !== undefined && snapshot.runtime.backend !== "cuda" && snapshot.runtime.backend !== "cpu")
    || typeof snapshot.runtime.degraded !== "boolean"
    || typeof snapshot.integrity.ok !== "boolean"
    || typeof snapshot.integrity.enforced !== "boolean"
    || typeof snapshot.network?.enabled !== "boolean"
    || snapshot.network?.authorization !== "per-call-hmac-capability"
    || typeof snapshot.filesystem?.relativePathsOnly !== "boolean"
    || typeof snapshot.filesystem.reparsePointsAllowed !== "boolean"
    || typeof snapshot.filesystem.atomicReplace !== "boolean"
    || !["unsafe-host", "oci", "disabled"].includes(snapshot.execution?.mode)
    || typeof snapshot.execution.available !== "boolean"
    || typeof snapshot.execution.configured !== "boolean"
    || typeof snapshot.execution.providerVisible !== "boolean"
    || typeof snapshot.execution.imageDigestPinned !== "boolean"
    || typeof snapshot.execution.smokeVerified !== "boolean") {
    throw new Error("Stored mission capability snapshot is malformed.");
  }
  if (snapshot.model && (!snapshot.model.id
    || !sha256String(snapshot.model.fingerprint)
    || !["agent-ready", "chat-only", "unknown"].includes(snapshot.model.toolCapability)
    || typeof snapshot.model.vision !== "boolean"
    || typeof snapshot.model.active !== "boolean")) {
    throw new Error("Stored mission capability snapshot model identity is malformed.");
  }
  const { digest: _digest, ...body } = snapshot;
  if (sha256(stableJson(body)) !== snapshot.digest) {
    throw new Error("Stored mission capability snapshot does not match its digest.");
  }
}

function compare(
  id: ResumeDrift["id"],
  title: string,
  source: string | undefined,
  current: string,
  before: string,
  now: string,
  detail: string,
  forcedState?: ResumeDrift["state"],
  action?: ResumeDrift["action"],
): ResumeDrift {
  const state = forcedState ?? (source === undefined ? "unavailable" : source === current ? "stable" : "changed");
  return { id, title, state, before, now, detail, ...(state === "stable" ? {} : { action }) };
}

function integrityLabel(snapshot: MissionCapabilitySnapshot): string {
  return `${snapshot.integrity.ok ? "trusted" : "blocked"} · ${shortHash(snapshot.integrity.manifestSha256 ?? snapshot.integrity.moduleSetSha256)}`;
}

function runtimeLabel(snapshot: MissionCapabilitySnapshot): string {
  return snapshot.runtime.available
    ? `${snapshot.runtime.backend?.toUpperCase() ?? "Local"}${snapshot.runtime.degraded ? " · degraded" : " · ready"}`
    : "Unavailable";
}

function networkLabel(snapshot: MissionCapabilitySnapshot): string {
  return `${snapshot.network.enabled ? "available" : "disabled"} · per-call approval`;
}

function filesystemLabel(snapshot: MissionCapabilitySnapshot): string {
  return filesystemSafe(snapshot) ? "contained · atomic" : "contract incomplete";
}

function executionLabel(snapshot: MissionCapabilitySnapshot): string {
  if (snapshot.execution.mode === "disabled") return "Disabled";
  if (snapshot.execution.mode === "unsafe-host") return "Unsafe host";
  return snapshot.execution.available && snapshot.execution.configured && snapshot.execution.imageDigestPinned
    ? `OCI · pinned${snapshot.execution.smokeVerified ? " · verified" : ""}`
    : "OCI · unavailable";
}

function filesystemSafe(snapshot: MissionCapabilitySnapshot): boolean {
  return snapshot.filesystem.relativePathsOnly
    && !snapshot.filesystem.reparsePointsAllowed
    && snapshot.filesystem.atomicReplace;
}

function shortHash(value: string): string {
  return value.slice(0, 8);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
