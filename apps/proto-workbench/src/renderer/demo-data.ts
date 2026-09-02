import type {
  AgentRunEvent,
  AppSettings,
  ModelDescriptor,
  PatchProposal,
  ReviewPacketView,
  RunSummary,
} from "../shared/contracts.ts";
import { defaultModuleSettings } from "../shared/modules.ts";

const GIB = 1024 ** 3;
export const DEMO_RUN_ID = "run_20260712_1024";

export const DEMO_MODELS: ModelDescriptor[] = [
  {
    id: "gpt-oss-20b",
    name: "GPT-OSS 20B",
    path: "C:\\Users\\demo\\.lmstudio\\models\\lmstudio-community\\gpt-oss-20b-GGUF\\gpt-oss-20b-MXFP4.gguf",
    files: [],
    sizeBytes: 12.11 * GIB,
    architecture: "gpt-oss",
    quantization: "MXFP4",
    contextLength: 131072,
    vision: false,
    toolCapability: "agent-ready",
    fingerprint: "demo-gpt-oss",
    estimatedVramBytes: 11.28 * GIB,
    loadState: "active",
    pinned: true,
    lastUsedAt: new Date().toISOString(),
    metadataSource: "gguf",
  },
  {
    id: "qwythos-9b",
    name: "Qwythos 9B Mythos",
    path: "C:\\Users\\demo\\.lmstudio\\models\\empero-ai\\Qwythos-9B-Claude-Mythos-5-1M-GGUF\\Qwythos-9B-Claude-Mythos-5-1M-Q4_K_M.gguf",
    files: [],
    sizeBytes: 6.55 * GIB,
    architecture: "qwen35",
    quantization: "Q4_K_M",
    contextLength: 1048576,
    vision: true,
    projectorPath: "mmproj-Qwythos-9B-Claude-Mythos-5-1M-f16.gguf",
    toolCapability: "agent-ready",
    fingerprint: "demo-qwythos",
    estimatedVramBytes: 6.1 * GIB,
    loadState: "warm",
    pinned: false,
    lastUsedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    metadataSource: "gguf",
  },
  {
    id: "qwen-agentworld",
    name: "Qwen AgentWorld 35B A3B",
    path: "C:\\Users\\demo\\.lmstudio\\models\\unsloth\\Qwen-AgentWorld-35B-A3B-GGUF\\Qwen-AgentWorld-35B-A3B-UD-Q4_K_S.gguf",
    files: [],
    sizeBytes: 20.89 * GIB,
    architecture: "qwen35moe",
    quantization: "Q4_K_S",
    contextLength: 262144,
    vision: false,
    toolCapability: "agent-ready",
    fingerprint: "demo-agentworld",
    estimatedVramBytes: 19.46 * GIB,
    loadState: "queued",
    pinned: false,
    metadataSource: "gguf",
  },
  {
    id: "gemma-4-26b",
    name: "Gemma 4 26B A4B",
    path: "C:\\Users\\demo\\.lmstudio\\models\\lmstudio-community\\gemma-4-26B-A4B-it-GGUF\\gemma-4-26B-A4B-it-Q4_K_M.gguf",
    files: [],
    sizeBytes: 17.99 * GIB,
    architecture: "gemma4",
    quantization: "Q4_K_M",
    contextLength: 262144,
    vision: true,
    projectorPath: "mmproj-gemma-4-26B-A4B-it-BF16.gguf",
    toolCapability: "agent-ready",
    fingerprint: "demo-gemma",
    estimatedVramBytes: 16.76 * GIB,
    loadState: "unloaded",
    pinned: false,
    metadataSource: "gguf",
  },
];

export const DEMO_SETTINGS: AppSettings = {
  modelRoot: "C:\\Users\\demo\\.lmstudio\\models",
  workspacePath: "C:\\Users\\demo\\Documents\\Proto CLI",
  residencyPolicy: {
    mode: "auto-evict",
    budgetBytes: 21.6 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: ["gpt-oss-20b"],
  },
  modules: defaultModuleSettings(),
};

const now = "2026-07-12T03:18:34.000Z";
export const DEMO_EVENTS: AgentRunEvent[] = [
  event("goal", "user", "Goal defined", "Define a reviewable promoter design goal and success criteria.", "10:24:31", {
    inputProvenance: ["goal.md"],
  }),
  event("plan", "assistant", "Plan generated", "Decompose the goal into design, deterministic validation, and evidence review.", "10:27:12", {
    outputArtifacts: ["plan.yaml"],
  }),
  event("design", "assistant", "Design edited", "Prepared a controlled Proto edit without writing to the workspace.", "10:41:58", {
    inputProvenance: ["plan.yaml"],
    outputArtifacts: ["designs/toggle_switch.proto"],
  }),
  event("design", "assistant", "Diff ready for review", "3 lines changed: +2 -1. Human approval required.", "10:42:21", {
    id: "event-diff",
    status: "approval-required",
    inputProvenance: ["designs/toggle_switch.proto (current)"],
    outputArtifacts: ["designs/toggle_switch.proto (proposed)"],
  }),
  event("validate", "tool", "Validation completed", "Structured Proto checks passed without errors.", "11:02:47", {
    tool: "proto_check",
    outputArtifacts: ["build/validation_report.json"],
  }),
  event("validate", "tool", "Design workflow completed", "Check, compile, sequence validation, score, and exports completed.", "11:03:05", {
    tool: "proto_workflow_run",
    outputArtifacts: ["build/runs/toggle_switch/manifest.json"],
  }),
  event("review", "tool", "Review packet created", "Evidence cards assembled for human scientific review.", "11:18:34", {
    tool: "proto_review_packet",
    outputArtifacts: ["build/reviews/toggle_switch/review_packet.json"],
    status: "completed",
  }),
];

const before = `design toggle_switch_v1 chassis ecoli_k12

construct repressor_a_unit:
  promoter pLac
  rbs B0034
  cds tetR
  terminator B0015

construct reporter_unit:
  promoter pTet
  rbs B0034
  cds gfp_mock
  terminator B0015

constraint gc_content min=0.35 max=0.65
`;

const after = `design toggle_switch_v1 chassis ecoli_k12

construct repressor_a_unit:
  promoter pLac
  rbs B0034
  cds tetR
  terminator B0015

construct reporter_unit:
  promoter pTet
  rbs B0034
  cds gfp_mock
  terminator B0015

constraint avoid_restriction_site enzyme=BsaI
constraint gc_content min=0.35 max=0.65
`;

export const DEMO_PATCH: PatchProposal = {
  id: "demo-patch",
  runId: DEMO_RUN_ID,
  targetPath: "C:\\Users\\demo\\Documents\\Proto CLI\\designs\\toggle_switch.proto",
  baseSha256: "demo",
  baseExists: true,
  before,
  after,
  afterExists: true,
  unifiedDiff: "",
  rationale: "Add a reviewable restriction-site avoidance constraint before deterministic validation.",
  status: "pending",
  revision: 0,
  createdAt: now,
};

export const DEMO_REVIEW: ReviewPacketView = {
  runId: DEMO_RUN_ID,
  packetPath: "build/reviews/toggle_switch/review_packet.json",
  gate: "review-required",
  summary: "All deterministic software validations passed. Evidence packet is complete for human review.",
  claims: [
    { id: "C1", claim: "Syntax and part references valid", evidence: ["diagnostics.json"], status: "supported" },
    { id: "C2", claim: "Sequence constraints passed", evidence: ["sequence_report.json"], status: "supported" },
    { id: "C3", claim: "Typed IR compiled", evidence: ["toggle_switch.ir.json"], status: "supported" },
    { id: "C4", claim: "SBOL structure valid", evidence: ["sbol_validation.json"], status: "supported" },
    { id: "C5", claim: "Human scientific review required", evidence: ["review_packet.md"], status: "needs-review" },
  ],
  checklist: [
    { id: "intent", label: "Design intent is clear and sufficient", status: "done" },
    { id: "evidence", label: "All claims are supported by evidence", status: "done" },
    { id: "sequence", label: "No critical software-level sequence issues", status: "pending" },
    { id: "risk", label: "Risks and assumptions have been reviewed", status: "pending" },
    { id: "approve", label: "Approve this run for downstream review", status: "pending" },
  ],
  unresolvedQuestions: [
    "Has the toy parts library been replaced with a reviewed source library?",
    "Are chassis-specific assumptions supported by reviewed evidence?",
  ],
  safetyBoundary:
    "Software validation only; this review does not certify wet-lab readiness, orderability, biosafety, or regulatory compliance.",
};

export const DEMO_RUNS: RunSummary[] = [
  demoRun(DEMO_RUN_ID, "T7 promoter library v1", "2026-07-12T02:24:00Z", "approval-required", "waiting-patch-review", "Patch review required"),
  demoRun("run_toggle_v2", "Toggle switch v2", "2026-07-11T08:42:00Z", "completed", "completed", "Run completed"),
  demoRun("run_crispr", "CRISPRi cascade design", "2026-07-10T01:18:00Z", "approval-required", "waiting-tool-approval", "Approval required"),
  demoRun("run_laci", "LacI variant scan", "2026-07-09T06:07:00Z", "completed", "completed", "Run completed"),
  demoRun("run_auxotrophy", "Minimal cell auxotrophy", "2026-07-08T03:33:00Z", "failed", "failed", "Run failed"),
  demoRun("run_biosensor", "Biosensor calibration", "2026-07-07T07:21:00Z", "completed", "completed", "Run completed"),
];

function demoRun(
  runId: string,
  title: string,
  createdAt: string,
  status: RunSummary["status"],
  state: RunSummary["lifecycle"]["state"],
  label: string,
): RunSummary {
  const attention = state === "waiting-patch-review"
    ? "patch-review"
    : state === "waiting-tool-approval"
      ? "tool-approval"
      : state === "failed"
        ? "failure"
        : "none";
  return {
    runId,
    title,
    createdAt,
    status,
    archived: false,
    lifecycle: {
      state,
      attention,
      label,
      detail: state === "waiting-patch-review"
        ? "Review the proposed workspace change before it is written."
        : state === "waiting-tool-approval"
          ? "A bounded tool action is waiting for a decision."
          : label,
      terminal: ["completed", "failed"].includes(state),
    },
  };
}

function event(
  stage: AgentRunEvent["stage"],
  actor: AgentRunEvent["actor"],
  title: string,
  summary: string,
  time: string,
  overrides: Partial<AgentRunEvent> = {},
): AgentRunEvent {
  return {
    id: overrides.id ?? `event-${stage}-${time.replaceAll(":", "")}`,
    runId: DEMO_RUN_ID,
    stage,
    actor,
    title,
    summary,
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: `2026-07-12T${time}.000Z`,
    completedAt: `2026-07-12T${time}.000Z`,
    ...overrides,
  };
}
