import { createHash } from "node:crypto";
import type {
  AgentThread,
  ChatAttachment,
  MissionIntent,
  MissionPreflight,
  MissionRequirement,
  ModelDescriptor,
  RuntimeStatus,
} from "../../shared/contracts.ts";
import type { ModuleIntegrityReport } from "../../shared/modules.ts";
import type { McpCapabilities } from "./mcp-client.ts";

export interface MissionPreflightInputs {
  thread: AgentThread;
  content: string;
  attachments: ChatAttachment[];
  model?: ModelDescriptor;
  runtime: RuntimeStatus;
  moduleIntegrity: ModuleIntegrityReport;
  visionModuleEnabled: boolean;
  workspaceUri: string;
  capabilities: McpCapabilities;
  toolNames: string[];
}

const NETWORK_INTENT = /(?:\b(?:search|browse|query|fetch|download|look\s*up|pubmed|crossref|uniprot|rhea|europe\s*pmc|online|internet|web)\b|联网|上网|网络|在线|检索|搜索|查询|下载|文献库)/iu;
const WRITE_INTENT = /(?:\b(?:write|edit|change|modify|update|create|delete|remove|rename|patch|apply|compile|export|save|implement|fix|upgrade|build)\b|写入|修改|编辑|更新|创建|删除|移除|重命名|补丁|应用|编译|导出|保存|实现|修复|升级|构建)/iu;
const EXECUTION_INTENT = /(?:\b(?:run|execute|python|notebook|jupyter|script|shell|terminal|powershell|benchmark|train|simulate)\b|运行|执行|脚本|终端|命令|测试|训练|模拟|仿真)/iu;

export function classifyMissionIntent(content: string): MissionIntent {
  const normalized = normalizeText(content);
  return {
    network: NETWORK_INTENT.test(normalized),
    writes: WRITE_INTENT.test(normalized),
    execution: EXECUTION_INTENT.test(normalized),
  };
}

export function buildMissionPreflight(input: MissionPreflightInputs): MissionPreflight {
  const goal = normalizeText(input.content);
  const intent = classifyMissionIntent(goal);
  const tools = [...new Set(input.toolNames.map((tool) => normalizeText(tool)).filter(Boolean))].sort();
  const requirements: MissionRequirement[] = [];
  const warnings: string[] = [];

  const failedCoreModules = input.moduleIntegrity.modules.filter(
    (module) => module.core && module.status !== "verified" && module.status !== "not-audited",
  );
  requirements.push({
    id: "integrity",
    title: "Core integrity",
    state: input.moduleIntegrity.ok && failedCoreModules.length === 0 ? "ready" : "blocked",
    detail: input.moduleIntegrity.ok && failedCoreModules.length === 0
      ? input.moduleIntegrity.enforced
        ? "The signed module manifest passed its startup audit."
        : "Development module audit passed; packaged builds enforce the manifest at startup."
      : `Core module verification failed${failedCoreModules.length ? ` for ${failedCoreModules.map((module) => module.moduleId).join(", ")}` : ""}.`,
    action: input.moduleIntegrity.ok ? undefined : "settings",
  });

  const workspaceBound = input.capabilities.workspace === input.workspaceUri;
  const filesystemSafe = input.capabilities.filesystemSafety.relativePathsOnly
    && !input.capabilities.filesystemSafety.reparsePointsAllowed
    && input.capabilities.filesystemSafety.atomicReplace;
  requirements.push({
    id: "workspace",
    title: "Workspace binding",
    state: workspaceBound && filesystemSafe ? "ready" : "blocked",
    detail: workspaceBound && filesystemSafe
      ? "The MCP sidecar is bound to this canonical workspace with relative paths and atomic replacement."
      : !workspaceBound
        ? "The MCP workspace identity does not match the active desktop workspace."
        : "The sidecar did not report all required filesystem containment guarantees.",
    action: workspaceBound && filesystemSafe ? undefined : "launchpad",
  });

  requirements.push({
    id: "runtime",
    title: "Local runtime",
    state: input.runtime.available ? "ready" : "blocked",
    detail: input.runtime.available
      ? `${input.runtime.backend?.toUpperCase() ?? "Local"} inference runtime is available${input.runtime.degraded ? " in degraded mode" : ""}.`
      : input.runtime.detail,
    action: input.runtime.available ? undefined : "launchpad",
  });

  const selectedModelReady = Boolean(input.model && input.model.loadState === "active");
  const needsAgentTools = input.thread.mode === "act" || intent.network || intent.writes || intent.execution;
  const modelCanUseTools = input.model?.toolCapability !== "chat-only" || !needsAgentTools;
  const modelReady = selectedModelReady && modelCanUseTools;
  requirements.push({
    id: "model",
    title: "Model capability",
    state: modelReady ? "ready" : "blocked",
    detail: !input.model
      ? "No local model is selected."
      : input.model.loadState !== "active"
        ? "The selected local model is not active."
        : !modelCanUseTools
          ? "This model is chat-only, but the mission requires agent tools."
          : input.model.toolCapability === "unknown"
            ? "The active model is loaded; tool behavior is not yet characterized."
            : "The active local model is compatible with this mission posture.",
    action: modelReady ? undefined : "models",
  });
  if (modelReady && input.model?.toolCapability === "unknown" && needsAgentTools) {
    warnings.push("The model's tool behavior is uncharacterized; tool calls remain fail-closed and approval-gated.");
  }

  const imageAttachments = input.attachments.filter((attachment) => attachment.mediaType.startsWith("image/"));
  const attachmentsReady = imageAttachments.length === 0
    || (input.visionModuleEnabled && Boolean(input.model?.vision));
  requirements.push({
    id: "attachments",
    title: "Attachment contract",
    state: attachmentsReady ? "ready" : "blocked",
    detail: input.attachments.length === 0
      ? "No external attachment grants are needed."
      : attachmentsReady
        ? `${input.attachments.length} validated attachment${input.attachments.length === 1 ? " is" : "s are"} bound to this preflight digest.`
        : !input.visionModuleEnabled
          ? "Image attachments are disabled by the active module profile."
          : "Image attachments require an active vision-capable local model.",
    action: attachmentsReady ? undefined : "models",
  });

  if (intent.network) {
    const networkTools = tools.some((tool) => /(?:pubmed|europe_pmc|crossref|uniprot|rhea)/.test(tool));
    const networkControlled = input.capabilities.networkAuthorization === "per-call-hmac-capability";
    requirements.push({
      id: "network",
      title: "Live network boundary",
      state: networkTools && networkControlled ? "approval-required" : "blocked",
      detail: networkTools && networkControlled
        ? "Live scientific lookup is available only through a fresh per-call approval capability."
        : !networkTools
          ? "No approved live scientific lookup tool is enabled for this workspace."
          : "The MCP sidecar did not report the required per-call network authorization boundary.",
      action: networkTools && networkControlled ? undefined : "settings",
    });
  } else {
    requirements.push({
      id: "network",
      title: "Live network boundary",
      state: "ready",
      detail: "No live network intent was detected; network remains disabled by default.",
    });
  }

  if (intent.writes) {
    const writeSupported = tools.includes("workspace_propose_patch") && filesystemSafe;
    requirements.push({
      id: "writes",
      title: "Workspace changes",
      state: input.thread.mode === "plan" ? "deferred" : writeSupported ? "approval-required" : "blocked",
      detail: input.thread.mode === "plan"
        ? "Plan mode may inspect and propose a path forward, but it cannot apply workspace changes."
        : writeSupported
          ? "The mission may propose a diff; applying it still requires explicit human review."
          : "The reviewed patch proposal boundary is unavailable.",
      action: input.thread.mode === "plan" || writeSupported ? undefined : "settings",
    });
  } else {
    requirements.push({
      id: "writes",
      title: "Workspace changes",
      state: "ready",
      detail: input.thread.mode === "plan"
        ? "Plan mode keeps workspace writes disabled."
        : "No write intent was detected; any later patch still pauses for explicit review.",
    });
  }

  if (intent.execution) {
    const execution = input.capabilities.execution;
    const isolated = execution.mode === "oci"
      && execution.available
      && execution.configured
      && execution.provider_visible
      && execution.image_digest_pinned;
    requirements.push({
      id: "execution",
      title: "Code execution",
      state: input.thread.mode === "plan" ? "deferred" : isolated ? "approval-required" : "blocked",
      detail: input.thread.mode === "plan"
        ? "Plan mode records the execution need but will not run code."
        : isolated
          ? `Digest-pinned ${execution.provider || "OCI"} execution is available and still requires per-call approval.`
          : execution.reason || "A configured, digest-pinned OCI sandbox is required before code can run.",
      action: input.thread.mode === "plan" || isolated ? undefined : "settings",
    });
    if (isolated && !execution.smoke_verified) {
      warnings.push("The OCI provider is visible but has not been smoke-verified in this session.");
    }
  } else {
    requirements.push({
      id: "execution",
      title: "Code execution",
      state: "ready",
      detail: "No code-execution intent was detected; execution remains disabled unless explicitly requested.",
    });
  }

  requirements.push({
    id: "human-review",
    title: "Human review",
    state: "ready",
    detail: "Network, execution, and file effects cannot inherit this launch confirmation; each uses its own fresh gate.",
  });

  const launchable = !requirements.some((requirement) => requirement.state === "blocked");
  const state = !launchable
    ? "blocked" as const
    : requirements.some((requirement) => requirement.state === "approval-required")
      ? "approval-required" as const
      : "ready" as const;
  const nextAction = !launchable
    ? requirements.find((requirement) => requirement.state === "blocked")?.detail ?? "Resolve the blocked requirement and refresh preflight."
    : state === "approval-required"
      ? "Start the mission; each declared side effect will still pause at its dedicated approval gate."
      : requirements.some((requirement) => requirement.state === "deferred")
        ? "Start the Plan mission; deferred effects will remain disabled until a separately reviewed Act mission."
        : "Start the mission with this exact goal, mode, model, capability set, and attachment set.";

  const goalSha256 = sha256(goal);
  const digestPayload = {
    schema: "proto-workbench.mission-preflight.v1",
    thread: {
      id: input.thread.id,
      mode: input.thread.mode,
      workspacePath: normalizePath(input.thread.workspacePath),
    },
    goalSha256,
    model: input.model ? {
      id: input.model.id,
      fingerprint: input.model.fingerprint,
      loadState: input.model.loadState,
      toolCapability: input.model.toolCapability,
      vision: input.model.vision,
    } : null,
    attachments: input.attachments.map((attachment) => ({
      path: normalizePath(attachment.path),
      name: normalizeText(attachment.name),
      mediaType: attachment.mediaType.toLocaleLowerCase(),
      sizeBytes: attachment.sizeBytes,
    })).sort((left, right) => left.path.localeCompare(right.path)),
    moduleIntegrity: {
      ok: input.moduleIntegrity.ok,
      enforced: input.moduleIntegrity.enforced,
      manifestSha256: input.moduleIntegrity.manifestSha256 ?? null,
      modules: input.moduleIntegrity.modules.map((module) => ({
        id: module.moduleId,
        status: module.status,
        sha256: module.moduleSha256 ?? null,
      })).sort((left, right) => left.id.localeCompare(right.id)),
    },
    visionModuleEnabled: input.visionModuleEnabled,
    runtime: {
      available: input.runtime.available,
      path: input.runtime.path ? normalizePath(input.runtime.path) : null,
      backend: input.runtime.backend ?? null,
      degraded: Boolean(input.runtime.degraded),
    },
    workspaceUri: input.workspaceUri,
    capabilities: input.capabilities,
    tools,
    intent,
    requirements: requirements.map(({ id, state }) => ({ id, state })),
  };

  return {
    schema: "proto-workbench.mission-preflight.v1",
    digest: sha256(stableJson(digestPayload)),
    issuedAt: new Date().toISOString(),
    threadId: input.thread.id,
    mode: input.thread.mode,
    modelId: input.model?.id,
    goalPreview: goal.slice(0, 180),
    goalSha256,
    state,
    launchable,
    intent,
    requirements,
    warnings,
    nextAction,
  };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

function normalizePath(value: string): string {
  return normalizeText(value).replace(/\\/g, "/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
