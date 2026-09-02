import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Stage 10 exposes a typed simulation-only report and harness API", async () => {
  const contracts = await source("src/shared/contracts.ts");
  const ipc = await source("src/shared/ipc.ts");

  assert.match(contracts, /schema: "proto-workbench\.policy-simulation\.v1"/);
  assert.match(contracts, /simulationOnly: true/);
  assert.match(contracts, /executedEffects: \[\]/);
  assert.match(contracts, /simulatePolicy\(input: PolicySimulationRequest\): Promise<PolicySimulationReport>/);
  assert.match(ipc, /harnessPolicySimulation: "harness:policy-simulation"/);
});

test("Stage 10 captures trusted inputs and validates attachments before simulation", async () => {
  const main = await source("src/main/index.ts");
  const preload = await source("src/preload/index.ts");
  const ipcSecurity = await source("src/main/ipc-security.ts");

  assert.match(main, /captureMissionEnvironment\(input\.threadId\)/);
  assert.match(main, /buildPolicySimulation\(/);
  assert.match(main, /handlePrivileged\(IPC\.harnessPolicySimulation/);
  assert.match(main, /validateSelectedAttachments\(/);
  assert.match(preload, /scenarioIds: \[\.\.\.new Set\(input\.scenarioIds\)\]\.slice\(0, 9\)/);
  assert.match(ipcSecurity, /\[IPC\.harnessPolicySimulation\]: z\.tuple/);
  assert.match(ipcSecurity, /scenarioIds: z\.array\(POLICY_SCENARIO_ID\)/);
});

test("Stage 10 pure simulation service has no effect-capable dependencies", async () => {
  const service = await source("src/main/services/policy-simulation.ts");

  assert.match(service, /No scenario can launch a model, call a tool, resolve an approval, access the network, execute code, or change a file/);
  assert.match(service, /const SCENARIOS: Record<PolicySimulationScenarioId, ScenarioDefinition>/);
  assert.match(service, /const scenarioInput = cloneInputs\(environment\)/);
  assert.doesNotMatch(service, /mcpClient\.call|workspaceFiles\.|database\.|threads\.send|resolveApproval|fetch\(/);
});

test("Stage 10 UI compares postures without exposing launch, approval, or write actions", async () => {
  const decisionLab = await source("src/renderer/DecisionLab.tsx");
  const app = await source("src/renderer/App.tsx");

  assert.match(decisionLab, /Decision Lab/);
  assert.match(decisionLab, /Effects executed/);
  assert.match(decisionLab, /Enumerated scenarios only/);
  assert.match(decisionLab, /role="tablist"/);
  assert.match(decisionLab, /event\.key === "Escape"/);
  assert.doesNotMatch(decisionLab, /threads\.send|approvals\.resolve|files\.applyApprovedPatch|models\.load/);
  assert.match(app, /Ctrl\+Shift\+L/);
  assert.match(app, /proto:decision-lab/);
  assert.match(app, /id="decision-lab-trigger"/);
});
