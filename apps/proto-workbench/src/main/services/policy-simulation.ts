import { createHash } from "node:crypto";
import type {
  MissionPreflight,
  MissionRequirement,
  MissionRequirementState,
  PolicySimulationDelta,
  PolicySimulationReport,
  PolicySimulationScenario,
  PolicySimulationScenarioId,
} from "../../shared/contracts.ts";
import { buildMissionPreflight, type MissionPreflightInputs } from "./mission-preflight.ts";

export const POLICY_SIMULATION_LIMITS = {
  maxGoalCharacters: 8_192,
  maxScenarios: 9,
} as const;

type ScenarioDefinition = {
  label: string;
  summary: string;
  apply(input: MissionPreflightInputs): void;
};

const SCENARIOS: Record<PolicySimulationScenarioId, ScenarioDefinition> = {
  current: {
    label: "Current controls",
    summary: "Re-evaluate the exact current mission posture and trusted environment snapshot.",
    apply: () => undefined,
  },
  "plan-posture": {
    label: "Plan posture",
    summary: "Keep the same mission and environment, but defer workspace writes and code execution.",
    apply: (input) => { input.thread.mode = "plan"; },
  },
  "act-posture": {
    label: "Act posture",
    summary: "Keep the same mission and environment, but expose effects to their dedicated approval gates.",
    apply: (input) => { input.thread.mode = "act"; },
  },
  "network-unavailable": {
    label: "Network unavailable",
    summary: "Remove live lookup tools and network paths without changing the mission text.",
    apply: (input) => {
      input.toolNames = input.toolNames.filter((tool) => !isNetworkTool(tool));
      input.capabilities.networkPaths = [];
      input.capabilities.networkEnabled = false;
    },
  },
  "execution-unavailable": {
    label: "Execution unavailable",
    summary: "Evaluate the mission with every code-execution provider unavailable.",
    apply: (input) => {
      input.capabilities.execution = disabledExecution("The simulation removed every configured execution provider.");
    },
  },
  "isolated-execution-ready": {
    label: "Pinned sandbox available",
    summary: "Model a digest-pinned OCI provider that is visible but still requires a fresh per-call approval.",
    apply: (input) => {
      input.capabilities.execution = {
        mode: "oci",
        available: true,
        configured: true,
        provider_visible: true,
        smoke_verified: false,
        provider: "hypothetical-oci",
        image: `hypothetical@sha256:${"0".repeat(64)}`,
        image_digest_pinned: true,
      };
    },
  },
  "workspace-drift": {
    label: "Workspace trust drift",
    summary: "Model a sidecar bound to a different workspace with atomic replacement unavailable.",
    apply: (input) => {
      input.capabilities.workspace = "simulated://workspace-drift";
      input.capabilities.filesystemSafety.atomicReplace = false;
    },
  },
  "model-chat-only": {
    label: "Chat-only model",
    summary: "Model the selected runtime as unable to issue structured agent tool calls.",
    apply: (input) => {
      if (input.model) input.model.toolCapability = "chat-only";
    },
  },
  "strict-lockdown": {
    label: "Strict lockdown",
    summary: "Remove live lookup, reviewed patch, and execution capabilities while retaining read-only inspection.",
    apply: (input) => {
      input.toolNames = input.toolNames.filter((tool) => !isNetworkTool(tool) && tool !== "workspace_propose_patch");
      input.capabilities.networkPaths = [];
      input.capabilities.networkEnabled = false;
      input.capabilities.execution = disabledExecution("Strict lockdown keeps code execution unavailable.");
      if (input.model) input.model.toolCapability = "chat-only";
    },
  },
};

export function buildPolicySimulation(
  environment: MissionPreflightInputs,
  requestedScenarioIds: PolicySimulationScenarioId[],
): PolicySimulationReport {
  const goal = environment.content.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
  if (!goal) throw new Error("Policy simulation requires a non-empty mission goal.");
  if (goal.length > POLICY_SIMULATION_LIMITS.maxGoalCharacters) {
    throw new Error(`Policy simulation goals are limited to ${POLICY_SIMULATION_LIMITS.maxGoalCharacters} characters.`);
  }
  const scenarioIds = normalizeScenarioIds(requestedScenarioIds);
  const baseline = evaluateScenario(environment, "current");
  const scenarios = scenarioIds.map((id) => projectScenario(environment, id, baseline.preflight));
  const digestPayload = {
    schema: "proto-workbench.policy-simulation.v1",
    threadId: baseline.preflight.threadId,
    goalSha256: baseline.preflight.goalSha256,
    baselineDigest: baseline.preflight.digest,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      decisionDigest: scenario.decisionDigest,
      state: scenario.state,
      wouldBeLaunchable: scenario.wouldBeLaunchable,
      deltas: scenario.deltas.map((delta) => ({
        requirementId: delta.requirementId,
        baselineState: delta.baselineState,
        scenarioState: delta.scenarioState,
        direction: delta.direction,
      })),
    })),
  };
  const digest = sha256(stableJson(digestPayload));
  return {
    schema: "proto-workbench.policy-simulation.v1",
    digest,
    decisionId: `sim_${digest.slice(0, 24)}`,
    issuedAt: new Date().toISOString(),
    threadId: baseline.preflight.threadId,
    goalPreview: baseline.preflight.goalPreview,
    goalSha256: baseline.preflight.goalSha256,
    simulationOnly: true,
    executedEffects: [],
    baselineScenarioId: "current",
    scenarios,
    boundary: "Comparison only. No scenario can launch a model, call a tool, resolve an approval, access the network, execute code, or change a file.",
    limits: { ...POLICY_SIMULATION_LIMITS },
  };
}

function projectScenario(
  environment: MissionPreflightInputs,
  id: PolicySimulationScenarioId,
  baseline: MissionPreflight,
): PolicySimulationScenario {
  const { definition, preflight } = evaluateScenario(environment, id);
  const deltas = compareRequirements(baseline.requirements, preflight.requirements);
  const blocking = preflight.requirements.filter((requirement) => requirement.state === "blocked");
  const gated = preflight.requirements.filter((requirement) => requirement.state === "approval-required");
  const deferred = preflight.requirements.filter((requirement) => requirement.state === "deferred");
  const determining = blocking.length ? blocking : gated.length ? gated : deferred;
  return {
    id,
    label: definition.label,
    summary: definition.summary,
    hypothetical: id !== "current",
    decisionDigest: preflight.digest,
    state: preflight.state,
    wouldBeLaunchable: preflight.launchable,
    intent: preflight.intent,
    requirements: preflight.requirements,
    deltas,
    determiningRequirements: determining.map((requirement) => requirement.id),
    warnings: preflight.warnings,
    nextAction: id === "current"
      ? preflight.nextAction
      : "Review the changed requirements. This hypothetical result cannot be used as a launch or approval contract.",
  };
}

function evaluateScenario(environment: MissionPreflightInputs, id: PolicySimulationScenarioId) {
  const definition = SCENARIOS[id];
  if (!definition) throw new Error(`Unknown policy simulation scenario: ${String(id)}`);
  const scenarioInput = cloneInputs(environment);
  definition.apply(scenarioInput);
  return { definition, preflight: buildMissionPreflight(scenarioInput) };
}

function normalizeScenarioIds(requested: PolicySimulationScenarioId[]): PolicySimulationScenarioId[] {
  if (!Array.isArray(requested)) throw new Error("Policy simulation scenarios must be an array.");
  const unique = [...new Set(requested)];
  if (unique.some((id) => !Object.hasOwn(SCENARIOS, id))) throw new Error("Policy simulation includes an unknown scenario.");
  const normalized = ["current" as const, ...unique.filter((id) => id !== "current")];
  if (normalized.length > POLICY_SIMULATION_LIMITS.maxScenarios) {
    throw new Error(`Policy simulation is limited to ${POLICY_SIMULATION_LIMITS.maxScenarios} scenarios.`);
  }
  return normalized;
}

function compareRequirements(
  baseline: MissionRequirement[],
  scenario: MissionRequirement[],
): PolicySimulationDelta[] {
  const baselineById = new Map(baseline.map((requirement) => [requirement.id, requirement]));
  return scenario.map((requirement) => {
    const before = baselineById.get(requirement.id);
    if (!before) throw new Error(`Scenario introduced an unknown requirement: ${requirement.id}`);
    return {
      requirementId: requirement.id,
      title: requirement.title,
      baselineState: before.state,
      scenarioState: requirement.state,
      direction: deltaDirection(before, requirement),
      detail: requirement.detail,
    };
  });
}

function deltaDirection(before: MissionRequirement, after: MissionRequirement): PolicySimulationDelta["direction"] {
  if (before.state === after.state) return before.detail === after.detail ? "unchanged" : "posture-shift";
  const rank: Record<MissionRequirementState, number> = {
    blocked: 0,
    deferred: 1,
    "approval-required": 2,
    ready: 3,
  };
  return rank[after.state] < rank[before.state] ? "more-restrictive" : "less-restrictive";
}

function cloneInputs(input: MissionPreflightInputs): MissionPreflightInputs {
  return {
    ...input,
    thread: { ...input.thread },
    attachments: input.attachments.map((attachment) => ({ ...attachment })),
    model: input.model ? { ...input.model, files: [...input.model.files] } : undefined,
    runtime: { ...input.runtime },
    moduleIntegrity: structuredClone(input.moduleIntegrity),
    capabilities: structuredClone(input.capabilities),
    toolNames: [...input.toolNames],
  };
}

function isNetworkTool(tool: string): boolean {
  return /(?:pubmed|europe_pmc|crossref|uniprot|rhea)/u.test(tool);
}

function disabledExecution(reason: string): MissionPreflightInputs["capabilities"]["execution"] {
  return {
    mode: "disabled",
    available: false,
    configured: false,
    provider_visible: false,
    smoke_verified: false,
    image_digest_pinned: false,
    reason,
  };
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
