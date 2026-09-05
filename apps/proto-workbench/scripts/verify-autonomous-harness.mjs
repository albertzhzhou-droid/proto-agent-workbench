/** Actual AgentService + durable DB + workspace CAS + Python MCP + local model.
 * Default: write a 12-family / 5-repeat plan across three fresh workspace groups.
 * --smoke executes ONE real artifact roundtrip. --run-matrix executes the plan.
 * Every response/artifact is model-authored; no host completion fallback exists.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, writeFile, readFile, copyFile, cp } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentService } from "../src/main/services/agent-service.ts";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";
import { McpClient } from "../src/main/services/mcp-client.ts";
import { ModelService } from "../src/main/services/model-service.ts";
import { LmStudioProvider } from "../src/main/services/lm-studio-provider.ts";
import { RuntimeFailure } from "../src/main/services/runtime-control.ts";
import { HarnessStore } from "../src/main/services/harness-store.ts";
import { HARNESS_DEFAULTS } from "../src/shared/harness.ts";
import { parseDesignIr } from "../src/renderer/design-visualization.ts";
import {checkProviderCitations,checkRecordEvidence,classifyAcceptanceOutcome,evaluateMatrixAcceptance} from "./harness-acceptance-checks.mjs";
import {captureImplementationInventory,verifyImplementationInventory} from "./harness-input-inventory.mjs";
import {AcceptanceWatchdog,ACCEPTANCE_WATCHDOG,boundedSettlement} from "./harness-acceptance-watchdog.mjs";
import {waitBetweenAcceptanceCases} from "./harness-case-controls.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const MATERIALS_ROOT = resolve(process.env.PROTO_AGENT_MATERIALS_ROOT || resolve(REPO, "../Proto CLI Materials"));
const PYTHON = process.env.PROTO_AGENT_PYTHON || join(REPO, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const argv = process.argv.slice(2);
const smoke = argv.includes("--smoke"), matrix = argv.includes("--run-matrix"), faults = argv.includes("--run-faults");
if ([smoke, matrix, faults].filter(Boolean).length > 1) throw new Error("Choose one execution mode.");
const option = key => {const index = argv.indexOf(key); return index < 0 ? undefined : argv[index + 1];};
const selectedFamily = option("--family");
const probeMinutes = option("--probe-minutes") === undefined ? undefined : Number(option("--probe-minutes"));
if (probeMinutes !== undefined && (!Number.isFinite(probeMinutes) || probeMinutes < 1 || probeMinutes > 120 || matrix)) throw new Error("--probe-minutes must be 1..120 and is only for development probes, not the frozen matrix.");
const requestedKey = option("--model-key") ?? "qwen3.8-27b@q4_k_m";
const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const outputRoot = resolve(process.env.PROTO_HARNESS_EVIDENCE_ROOT || resolve(REPO,"build/upgrade-20260904/model-runs"), sessionId);
await mkdir(outputRoot, {recursive: true});
const artifactTask = "Read inputs/brief.md. Create build/mission-result.md with a concise summary of its facts and copy its exact Evidence token. Declare the deliverable with harness_plan, use workspace_propose_patch to save it, and call harness_finish only after the saved result is verified.";
const faultFamilies = [
  {id: "artifact_roundtrip", prompt: artifactTask, requiredTools: ["workspace_read", "workspace_propose_patch"]},
  {id: "multiple_deliverables", prompt: artifactTask + " Also create build/second-result.md with the same Evidence token and verify both outputs.", requiredOutputs: ["build/second-result.md"]},
  {id: "large_result_paging", prompt: artifactTask + " The Evidence token is near the end of a long input. Follow durable result handles with harness_read_result until you reach it.", large: true, requiredTools: ["harness_read_result"]},
  {id: "repeated_tool_use", prompt: artifactTask + " Discover proto_connectors_check and invoke it in three distinct tool rounds, rereading inputs/brief.md between checks to make each observation explicit, before finishing.", requiredTools: ["proto_connectors_check"], minimumToolCalls: {proto_connectors_check: 3}},
  {id: "schema_repair", prompt: artifactTask + " First exercise argument validation by calling workspace_read once with an extra unknown field named intentional_invalid_field. Then use the returned structured diagnostics to repair the call.", requiredCodes: ["INVALID_TOOL_ARGUMENTS"]},
  {id: "prefill_recovery", prompt: artifactTask, fault: "prefill", requiredRecovery: true},
  {id: "stream_disconnect_recovery", prompt: artifactTask, fault: "truncate", resume: true, requiredRecovery: true},
  {id: "pause_resume", prompt: artifactTask, fault: "pause", resume: true, requiredRecovery: true},
  {id: "stale_read_rebase", prompt: "Read build/mission-result.md and inputs/brief.md. Modify build/mission-result.md to include a concise summary and the exact Evidence token. If a baseline conflict is reported, reread and preserve the concurrent edit marker before retrying. Finish only after verification.", fault: "stale", requiredCodes: ["BASELINE_CHANGED"]},
  {id: "model_lifecycle", prompt: artifactTask, reload: true},
  {id: "governed_dna", prompt: "Search governed DESIGN_ELIGIBLE DNA materials and materialize an exact eligible selection. Search the resulting parts snapshot before using any existing part IDs. Create designs/mission.proto as a bounded software-only design, perform check/workflow/provenance/review, and then create build/mission-result.md explaining the validation and unresolved review boundaries. Read inputs/brief.md and copy its Evidence token into the report. Never invent IDs or use the bundled toy library. If eligible parts cannot support a design, preserve the structured failure instead of fabricating a result.", requiredTools: ["proto_materials_search", "proto_materials_materialize", "proto_search_parts", "workspace_propose_patch"]},
  {id: "governed_protein", prompt: "Search governed DESIGN_ELIGIBLE protein materials, materialize a protein selection, validate and compile it, then export the compiled protein IR to build/protein.fasta. Read inputs/brief.md and create build/mission-result.md with its exact Evidence token and a short record of the selection, provenance and software-only validation boundaries. Never invent resource IDs. Use harness_plan and finish only after all actual artifacts and compile/export evidence exist.", requiredTools: ["proto_materials_search", "proto_materials_materialize_proteins", "proto_protein_validate", "proto_protein_compile", "proto_export"], requiredOutputs: ["build/protein.fasta"]},
];
const scientificReport = " Read inputs/brief.md and create build/mission-result.md with its exact Evidence token, tool-returned identifiers and validation gaps. Use harness_plan and call harness_finish only after independent artifact verification.";
const bindInputDna = "Read inputs/fixture-bindings.json. Materialize the exact listed eligible resource_ids with its declared chassis and snapshot, and search the returned parts snapshot before using the fixture IDs. ";
const families = [
  {id: "file_synthesis", prompt: artifactTask, requiredTools: ["workspace_read", "workspace_propose_patch"]},
  {id: "paginated_materials", prompt: "Search the active DESIGN_ELIGIBLE materials catalogue with limit=1, then follow at least two returned cursors. Record three distinct exact resource IDs, sequence hashes, source and rights fields without inventing any biological conclusion." + scientificReport, minimumToolCalls: {proto_materials_search: 3}, check: "material-cursors"},
  faultFamilies.find(family => family.id === "governed_dna"),
  {id: "dna_modification", fixture: "dna", editTarget: true, prompt: bindInputDna + "Read designs/mission.proto, use proto_design_edit to preview reversing only occurrence c1, then save the candidate to that same file using workspace_propose_patch. Preserve every occurrence ID and source part identity. Perform check/workflow/provenance/review." + scientificReport, requiredTools: ["proto_design_edit", "workspace_propose_patch"], requiredOutputs: ["designs/mission.proto"], check: "dna-reversed"},
  {id: "dna_validation_repair", fixture: "dna-invalid", editTarget: true, prompt: bindInputDna + "Read designs/mission.proto and run proto_check before editing to capture its deliberate syntax diagnostic. Repair only the invalid topology declaration to linear while preserving every part and instance ID. Save and repeat check/workflow/provenance/review." + scientificReport, requiredTools: ["proto_check", "workspace_propose_patch"], failedTools: ["proto_check"], check: "dna-repaired"},
  faultFamilies.find(family => family.id === "governed_protein"),
  {id: "structure_association", fixture: "protein", prompt: "Read inputs/fixture-bindings.json and inspect its verified protein IR with proto_protein_inspect. Use live network access to search only official PDB or AlphaFold metadata for that protein and fetch one appropriate coordinate attachment with proto_structure_fetch. Preserve the exact artifact and sequence digests, source URL, experimental/predicted label and rights. Read back the attachment; binding alone does not establish residue alignment." + scientificReport, requiredTools: ["proto_protein_inspect", "proto_structure_search", "proto_structure_fetch", "proto_structure_read"], check: "structure"},
  {id: "literature_evidence", prompt: "Use live network PubMed and Crossref searches to find publication metadata on green fluorescent protein chromophore structure. Create a concise evidence table quoting only tool-returned PMID/DOI identifiers and source links, explicitly separating bibliographic identity from support for a scientific claim." + scientificReport, requiredTools: ["proto_pubmed_search", "proto_crossref_search"], check: "literature-identifiers"},
  {id: "provenance_review", fixture: "dna", prompt: bindInputDna + "Run check, workflow, provenance verification and review packet for build/fixtures/base.proto. Inspect the returned manifests and report their exact paths and SHA-256 values, failed checks and outstanding human-review boundaries. Do not edit the source." + scientificReport, requiredTools: ["proto_check", "proto_workflow_run", "proto_provenance_verify", "proto_review_packet"], check: "provenance"},
  {id: "scientific_export", fixture: "dna", prompt: bindInputDna + "Compile build/fixtures/base.proto with the returned materialized parts snapshot. Export that compiled IR to build/export.fasta and build/export.gb through proto_export. Reopen the exports and verify their sequences match the compiled IR; preserve source provenance." + scientificReport, requiredTools: ["proto_compile", "proto_export"], minimumToolCalls: {proto_export: 2}, requiredOutputs: ["build/export.fasta", "build/export.gb"], check: "scientific-exports"},
  {id: "multiartifact_report", fixture: "protein", prompt: "Read inputs/fixture-bindings.json and inspect its protein IR with proto_protein_inspect. Create build/protein-summary.json with one record for each exact protein ID, length and sequence_sha256 returned by the tool. Create build/evidence-table.md mapping each ID to its tool-returned source and license. Preserve the fixture unchanged." + scientificReport, requiredTools: ["proto_protein_inspect", "workspace_propose_patch"], requiredOutputs: ["build/protein-summary.json", "build/evidence-table.md"], check: "protein-report"},
  {id: "checkpoint_resume_science", fixture: "protein", fault: "pause_after_compile", resume: true, requiredRecovery: true, prompt: "Read inputs/fixture-bindings.json. Validate its materialized protein selection, compile it to build/resumed-protein.ir.json and export that newly compiled IR to build/resumed-protein.fasta. Continue from saved tool receipts if paused; do not repeat a committed write blindly." + scientificReport, requiredTools: ["proto_protein_validate", "proto_protein_compile", "proto_export"], requiredOutputs: ["build/resumed-protein.ir.json", "build/resumed-protein.fasta"]},
];
const cases = families.flatMap(family => Array.from({length: 5}, (_, index) => ({...family, repeat: index + 1, workspaceGroup: index % 3 + 1})));
const faultCases = faultFamilies.filter(family => !["governed_dna", "governed_protein"].includes(family.id)).map(family => ({...family, repeat: 1, workspaceGroup: 1, scenarioKind:family.fault||family.id==="schema_repair"?"controlled-fault":"coverage"}));
const allCases = [...cases, ...faultCases];
const plan = {schema: "proto-workbench.live-matrix.v1", createdAt: new Date().toISOString(), modelKey: requestedKey,
  executionMode:matrix?"scientific-matrix":faults?"live-fault-and-coverage-suite":smoke?"development-smoke":selectedFamily?"development-family-probe":"plan-only",
  contextTokens: 32768, families: 12, repetitions: 5, cases: 60, workspaceGroups: 3,
  budgets: HARNESS_DEFAULTS, scenarios: cases, faultScenarios: faultCases, status: smoke || matrix || faults || selectedFamily ? "execution-requested" : "not-run"};
plan.acceptance = evaluateMatrixAcceptance([],cases);
await writeFile(join(outputRoot, "matrix-plan.json"), JSON.stringify(plan, null, 2) + "\n");
if (!smoke && !matrix && !faults && !selectedFamily) {console.log(JSON.stringify({status: "plan-only", outputRoot, cases: 60})); process.exit(0);}
if (selectedFamily && !allCases.some(family => family.id === selectedFamily)) throw new Error("Unknown matrix or fault family.");
const implementation = await captureImplementationInventory(REPO, fileURLToPath(import.meta.url));
await writeFile(join(outputRoot,"implementation-inventory.json"),JSON.stringify(implementation,null,2));
const materialIdentity = await observeMaterialsIdentity();
await writeFile(join(outputRoot,"materials-runtime-binding.json"),JSON.stringify(materialIdentity,null,2));
plan.implementationSha256 = implementation.sha256;
plan.materials = {snapshotId:materialIdentity.snapshot_id,manifestSha256:materialIdentity.manifest_sha256};
plan.sampling = {temperature:0.2,toolChoice:"auto",normalMaxTokens:HARNESS_DEFAULTS.outputTokens,repairMaxTokens:HARNESS_DEFAULTS.maxOutputTokens,seed:null,seedMeaning:"No explicit seed was sent; backend sampling seed is not controlled."};
plan.falseCompletionPolicy = "Preserve the completed case and stop the campaign after any false_completion. A corrected implementation requires a new immutable campaign; failed cases are never replaced.";
plan.watchdog = {...ACCEPTANCE_WATCHDOG,taskClock:"Persisted activeTimeMs and immutable mission budget; queued heartbeats have no total wall-clock limit. Paused segments end only on a new terminal event after owned teardown. Liveness and cleanup failures are separately reported."};
await writeFile(join(outputRoot,"matrix-plan.json"),JSON.stringify(plan,null,2));

let activeAgent, stopRequested = false;
const requestStop = reason => {
  if (stopRequested) return;
  stopRequested = true;
  appendFileSync(join(outputRoot, "stop-events.jsonl"), JSON.stringify({at: new Date().toISOString(), reason}) + "\n");
  if (activeAgent) void activeAgent.cancelAll();
};
const stopFile = join(outputRoot, "STOP");
const pauseBetweenCasesFile = join(outputRoot,"PAUSE_BETWEEN_CASES");
const runnerState={pid: process.pid,stopFile,pauseBetweenCasesFile,phase:"starting",method:"Create STOP to cancel the owned AgentService, checkpoint, and unload only the owned model instance. Create PAUSE_BETWEEN_CASES to finish the current case and wait before constructing the next mission; remove it to continue. The owned model remains loaded but idle during that hold.",developmentProbeMinutes:probeMinutes};
const runnerStatus=async(phase,details={})=>{Object.assign(runnerState,{phase,updatedAt:new Date().toISOString()},details);await writeFile(join(outputRoot,"runner.json"),JSON.stringify(runnerState,null,2));};
await runnerStatus("starting");
const stopPoll = setInterval(() => {if (existsSync(stopFile)) requestStop("STOP file requested cooperative cancellation");}, 1000);
stopPoll.unref();
process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

let activeFault;
const injections = [];
const provider = new LmStudioProvider({fetchImpl: async (url, init) => {
  if (String(url).endsWith("/v1/chat/completions") && activeFault === "prefill") {
    activeFault = undefined; injections.push({type: "prefill", at: new Date().toISOString(), mechanism: "controlled pre-request transport failure"});
    throw new RuntimeFailure("PREFILL_TIMEOUT", "prefill", "Acceptance-injected prefill transport interruption", {retryable: true, effectState: "none"});
  }
  const response = await fetch(url, init);
  if (String(url).endsWith("/v1/chat/completions") && activeFault === "truncate") {
    activeFault = undefined; injections.push({type: "truncate", at: new Date().toISOString(), mechanism: "controlled stream terminator removal; model process remains untouched"});
    const decoder = new TextDecoder(), encoder = new TextEncoder(); let pending = "";
    const transform = new TransformStream({
      transform(chunk, controller) {pending += decoder.decode(chunk, {stream: true}); if (pending.length > 64) {controller.enqueue(encoder.encode(pending.slice(0, -64).replace(/data:\s*\[DONE\]/g, ""))); pending = pending.slice(-64);}},
      flush(controller) {controller.enqueue(encoder.encode((pending + decoder.decode()).replace(/data:\s*\[DONE\]/g, "")));},
    });
    return new Response(response.body.pipeThrough(transform), {status: response.status, headers: response.headers});
  }
  return response;
}});
const modelDb = new AppDatabase(join(outputRoot, "models.sqlite"));
const models = new ModelService(modelDb, provider, provider, async () => ({totalBytes: 0, usedBytes: 0, freeBytes: 0}));
const results = [];
let identity;
let ownedUnloadVerified = false;
try {
  const catalog = await models.scan("");
  const selected = catalog.find(model => model.providerModelId === requestedKey && /q4/i.test(model.quantization));
  if (!selected) throw new Error("The exact requested Qwen Q4 key is not available in the live LM Studio catalog.");
  await writeFile(join(outputRoot, "discovery.json"), JSON.stringify({key: selected.providerModelId, id: selected.id, quantization: selected.quantization, loadedInstances: selected.loadedInstances, observedAt: new Date().toISOString()}, null, 2));
  console.log(JSON.stringify({phase: "loading", key: selected.providerModelId, contextTokens: 32768}));
  const loaded = await models.load(selected.id, {contextLength: 32768});
  identity = {key: selected.providerModelId, modelId: selected.id, quantization: selected.quantization, ...(await models.getExecutionBinding(selected.id))};
  if (identity.contextLength !== 32768) throw new Error("Existing model context does not equal 32768; external instances are never unloaded or silently reconfigured.");
  await writeFile(join(outputRoot, "execution-binding.json"), JSON.stringify({...identity, lifecycle: loaded}, null, 2));
  console.log(JSON.stringify({phase: "model-ready", ...identity}));
  for (const scenario of smoke ? [faultCases[0]] : selectedFamily ? [allCases.find(item => item.id === selectedFamily)] : faults ? faultCases : cases) {
    if (stopRequested) break;
    const released=await waitBetweenAcceptanceCases({pauseFile:pauseBetweenCasesFile,shouldStop:()=>stopRequested,
      onHold:async()=>{const held={phase:"held-between-cases",at:new Date().toISOString(),nextFamily:scenario.id,nextRepeat:scenario.repeat,completedCases:results.length,modelResident:true,generationActive:false};appendFileSync(join(outputRoot,"case-control-events.jsonl"),JSON.stringify(held)+"\n");await runnerStatus(held.phase,held);console.log(JSON.stringify(held));},
      onRelease:async({stopped})=>{const released={phase:stopped?"held-stop-requested":"between-cases-released",at:new Date().toISOString(),nextFamily:scenario.id,nextRepeat:scenario.repeat};appendFileSync(join(outputRoot,"case-control-events.jsonl"),JSON.stringify(released)+"\n");await runnerStatus(released.phase,released);},
    });
    if(!released)break;
    await runnerStatus("running-case",{family:scenario.id,repeat:scenario.repeat,completedCases:results.length,modelResident:true,caseActive:true,generationActive:undefined});
    await assertFrozenInputs(`before:${scenario.id}:${scenario.repeat}`);
    if (scenario.reload) {
      await models.unload(selected.id);
      await models.load(selected.id, {contextLength: 32768});
    }
    let result;
    try {result = await runCase(scenario, selected.id);}
    catch (error) {
      result = {family: scenario.id, repeat: scenario.repeat, status: "failed", outcome: "incomplete", stage: "input-preparation", error: String(error), workspace: `workspace-${scenario.workspaceGroup}/${scenario.id}-${scenario.repeat}`};
      await writeFile(join(outputRoot, `preparation-failure-${scenario.id}-${scenario.repeat}.json`), JSON.stringify(result, null, 2));
    }
    results.push(result);
    await assertFrozenInputs(`after:${scenario.id}:${scenario.repeat}`);
    const outcomes = Object.fromEntries(["direct_success", "success_after_retry_or_repair", "host_recovery", "incomplete", "false_completion"].map(outcome => [outcome, results.filter(item => item.outcome === outcome).length]));
    const acceptanceGate = matrix ? evaluateMatrixAcceptance(results,cases) : undefined;
    await writeFile(join(outputRoot, "results.json"), JSON.stringify({schema: "proto-workbench.live-acceptance.v1", executionMode:plan.executionMode, identity, implementationSha256:implementation.sha256, materials:plan.materials, measuredInputsUnchanged:true, acceptanceGate, outcomes, results}, null, 2) + "\n");
    console.log(JSON.stringify({phase: "case-finished", family: scenario.id, repeat: scenario.repeat, status: result.status, checks: result.checks}));
    if (result.status !== "passed") process.exitCode = 1;
    if (result.outcome === "false_completion") {
      await writeFile(join(outputRoot,"false-completion-stop.json"),JSON.stringify({at:new Date().toISOString(),family:scenario.id,repeat:scenario.repeat,completedCases:results.length,reason:plan.falseCompletionPolicy},null,2));
      break;
    }
  }
} catch (error) {
  process.exitCode = 1;
  const failure = {status: "failed", code: error.code, message: String(error), identity, results};
  await writeFile(join(outputRoot, "failure.json"), JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure));
} finally {
  clearInterval(stopPoll);
  try {
    await models.shutdown();
    const after = await provider.scan("");
    ownedUnloadVerified = !identity?.ownedByWorkbench || !after.some(model=>model.loadedInstances?.some(instance=>instance.id===identity.instanceId));
    await writeFile(join(outputRoot, "owned-unload-observation.json"), JSON.stringify({observedAt: new Date().toISOString(), before: identity, models: after.filter(model => model.providerModelId === requestedKey).map(model => ({key: model.providerModelId, instances: model.loadedInstances}))}, null, 2));
    if(!ownedUnloadVerified)throw new Error("The owned model instance remains present after shutdown.");
  } catch (error) {process.exitCode = 1; await writeFile(join(outputRoot, "cleanup-failure.json"), JSON.stringify({message: String(error)}));}
  if(matrix) await writeFile(join(outputRoot,"acceptance-gate.json"),JSON.stringify(evaluateMatrixAcceptance(results,cases,!existsSync(join(outputRoot,"invalid-inputs.json"))),null,2));
  models.dispose(); modelDb.close();
  await runnerStatus("finished",{completedCases:results.length,modelResident:ownedUnloadVerified?false:"unverified",ownedUnloadVerified,caseActive:false,generationActive:false,status:process.exitCode?"failed":"passed"});
  console.log(JSON.stringify({phase: "finished", outputRoot, status: process.exitCode ? "failed" : "passed"}));
}

async function runCase(scenario, modelId) {
  const root = join(outputRoot, `workspace-${scenario.workspaceGroup}`, `${scenario.id}-${scenario.repeat}`);
  for (const dir of ["inputs", "build", "designs", "connectors", "workflows", "literature", ".codex"]) await mkdir(join(root, dir), {recursive: true});
  const evidence = randomBytes(12).toString("hex");
  const padding = scenario.large ? "Bounded local fixture paragraph; this line does not carry the evidence token.\n".repeat(1200) : "";
  await writeFile(join(root, "inputs/brief.md"), `# Mission fixture\nProject: ORBIT\nDomain: software verification only\nDeliverable: an auditable local Markdown file\n${padding}\nEvidence token: ${evidence}\n`);
  const connectors = JSON.parse(await readFile(join(REPO, "connectors/proto_workbench.json"), "utf8"));
  for (const connector of connectors.connectors) if (connector.id === "parts_library") {
    connector.status = "local_configuration_required";
    connector.purpose = "Bundled toy parts are intentionally absent from this fresh governed-materials acceptance workspace. Use the explicitly materialized eligible selection.";
  }
  await writeFile(join(root, "connectors/proto_workbench.json"), JSON.stringify(connectors, null, 2) + "\n");
  await copyFile(join(REPO, "workflows/design_review.json"), join(root, "workflows/design_review.json"));
  await copyFile(join(REPO, "literature/seed_sources.json"), join(root, "literature/seed_sources.json"));
  await copyFile(join(REPO, "AGENTS.md"), join(root, "AGENTS.md"));
  await cp(join(REPO, ".codex/skills"), join(root, ".codex/skills"), {recursive: true, force: false, errorOnExist: true});
  let fixture;
  if (scenario.fixture) {
    const {stdout} = await promisify(execFile)(PYTHON,
      [join(REPO, "scripts/prepare_harness_inputs.py"), "--workspace", root, "--materials-root", MATERIALS_ROOT, "--kind", scenario.fixture],
      {cwd: REPO, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024, env: {...process.env, PYTHONPATH: join(REPO, "src")}});
    fixture = JSON.parse(stdout);
    if (scenario.editTarget) await copyFile(join(root, fixture.source_path), join(root, "designs/mission.proto"));
    await writeFile(join(root, "inputs/fixture-bindings.json"), JSON.stringify(fixture, null, 2));
  }
  if (scenario.fault === "stale") await writeFile(join(root, "build/mission-result.md"), "# Original draft\nPreserve existing context.\n");
  const database = new AppDatabase(join(root, "execution.sqlite"));
  const workspace = new WorkspaceFiles(root, database);
  const mcp = new McpClient({packaged: false, resourcesPath: "", repoRoot: REPO, workspacePath: root,
    workspaceCapability: randomBytes(32).toString("hex"), materialsRoot: MATERIALS_ROOT,
    pythonExecutable: PYTHON});
  let complete, rejectComplete;
  const freshCompletion = () => new Promise((resolveCompletion, reject) => {complete = resolveCompletion; rejectComplete = reject;});
  let completion = freshCompletion();
  let injected = false, thread;
  const agent = new AgentService(database, models, workspace, mcp, event => {
    if (event.type !== "message-delta") appendFileSync(join(root, "events.jsonl"), JSON.stringify(event) + "\n");
    if (event.type === "run-event" && event.harness) console.log(JSON.stringify({family: scenario.id, state: event.harness.state, round: event.harness.round, activeTimeMs: event.harness.activeTimeMs, summary: event.runEvent.summary}));
    if (scenario.fault === "stale" && !injected && event.runEvent?.tool === "workspace_read" && event.runEvent.status === "completed" && event.runEvent.inputs?.some(path => path.endsWith("mission-result.md"))) {
      injected = true; appendFileSync(join(root, "build/mission-result.md"), "\nConcurrent edit marker: PRESERVE-CONCURRENT-CONTEXT\n");
    }
    if (!injected && ((scenario.fault === "pause" && event.harness?.state === "generating") || (scenario.fault === "pause_after_compile" && event.runEvent?.tool === "proto_protein_compile" && event.runEvent.status === "completed"))) {
      injected = true;
      const runId = event.harness?.runId ?? event.runEvent.runId;
      setTimeout(() => {if (typeof agent.pauseExecution === "function") void agent.pauseExecution(runId); else rejectComplete(new Error("Public pause API is not available; pause coverage is not claimed."));}, 250);
    }
    if (event.type === "message-complete") complete(event);
    if (event.type === "error") rejectComplete(new Error(event.error));
  }, undefined, root);
  activeAgent = agent;
  let watchdog, cleanupPromise, cleanupDiagnostic, caseResult;
  const cleanup = () => {
    if (!cleanupPromise) {
      const owned = (async()=>{await agent.cancelAll();await mcp.stop();await waitForIdle(agent);})();
      // Keep the DB usable until owned callbacks settle, even if an outer
      // liveness failure is reported. Never close it beneath an active write.
      void owned.then(()=>database.close(),()=>database.close());
      cleanupPromise = boundedSettlement(owned).catch(error=>{cleanupDiagnostic={code:error.code,message:String(error)};requestStop("Owned cleanup did not settle; no further matrix cases will start.");throw error;});
    }
    return cleanupPromise;
  };
  const beforeInjections = injections.length;
  try {
    const setup = await mcp.call("proto_connectors_check", {}, new AbortController().signal);
    await writeFile(join(root, "preparation-check.json"), JSON.stringify({inputOnly: true, connectorsOk: setup.ok, issues: setup.issues, fixture}, null, 2));
    if (!setup.ok) throw new Error("Fresh acceptance workspace connector preparation failed before model execution.");
    activeFault = ["prefill", "truncate"].includes(scenario.fault) ? scenario.fault : undefined;
    thread = agent.createThread({workspacePath: root, title: `Acceptance ${scenario.id} ${scenario.repeat}`, mode: "act", modelId});
    const timed = () => {
      const monitor = new AcceptanceWatchdog(), startedAt=performance.now();
      return new Promise((resolveCompletion,reject)=>{
        const finish=(fn,value)=>{clearInterval(watchdog);fn(value);};
        completion.then(value=>finish(resolveCompletion,value),error=>finish(reject,error));
        const inspect=()=>{
          let diagnostic;
          try {
            const checkpoint=new HarnessStore(database.db).latest(thread.id);
            diagnostic=probeMinutes&&performance.now()-startedAt>=probeMinutes*60000
              ? {code:"DEVELOPMENT_PROBE_WALL_BOUND",message:"The explicitly bounded development probe reached its wall-clock limit."}
              : monitor.observe(checkpoint,{active:agent.hasActiveRuns()});
          } catch(error){diagnostic={code:"CHECKPOINT_OBSERVATION_FAILED",message:String(error)};}
          if(!diagnostic)return;
          clearInterval(watchdog);
          appendFileSync(join(root,"watchdog-events.jsonl"),JSON.stringify({at:new Date().toISOString(),...diagnostic})+"\n");
          requestStop(diagnostic.message);
          reject(Object.assign(new Error(diagnostic.message),diagnostic));
        };
        watchdog=setInterval(inspect,ACCEPTANCE_WATCHDOG.pollMs);inspect();
      });
    };
    await agent.send(thread.id, scenario.prompt);
    let end = await timed(); clearTimeout(watchdog);
    await waitForIdle(agent);
    let checkpoint = new HarnessStore(database.db).latest(thread.id);
    const interruptedState = checkpoint?.state;
    const resumeBefore = checkpoint ? {runId:checkpoint.contract.runId,budgets:checkpoint.contract.budgets,generatedTokens:checkpoint.generatedTokens,activeTimeMs:checkpoint.activeTimeMs} : undefined;
    if (scenario.resume && checkpoint && checkpoint.state !== "completed") {
      completion = freshCompletion();
      await agent.resumeExecution(checkpoint.contract.runId);
      end = await timed(); clearTimeout(watchdog);
      await waitForIdle(agent);
      checkpoint = new HarnessStore(database.db).latest(thread.id);
    }
    const store = new HarnessStore(database.db);
    const receipts = checkpoint?.resultHandles.map(handle => store.read(checkpoint.contract.runId, handle)) ?? [];
    const output = await readFile(join(root, "build/mission-result.md"), "utf8").catch(() => "");
    const checks = {completed: checkpoint?.state === "completed", evidenceToken: output.includes(evidence), noHostFallback: checkpoint?.hostRecovered === false, notStopped: !stopRequested,
      expectedContext: checkpoint?.contract.contextTokens === 32768, tools: (scenario.requiredTools ?? []).every(tool => receipts.some(result => result.tool === tool && result.ok)),
      expectedFailedTools: (scenario.failedTools ?? []).every(tool => receipts.some(result => result.tool === tool && !result.ok)),
      diagnosticsExercised: (scenario.requiredCodes ?? []).every(code => receipts.some(result => result.data.code === code)),
      repetitions: Object.entries(scenario.minimumToolCalls ?? {}).every(([tool, count]) => receipts.filter(result => result.tool === tool).length >= count),
      recoveryExercised: !scenario.requiredRecovery || (scenario.fault?.startsWith("pause")
        ? interruptedState === "paused" && (checkpoint?.recoveryCounters?.resumes ?? 0) > 0
        : injected || injections.length > beforeInjections),
      staleEditPreserved: scenario.fault !== "stale" || output.includes("PRESERVE-CONCURRENT-CONTEXT")};
    for (const path of scenario.requiredOutputs ?? []) checks[`output:${path}`] = (await readFile(join(root, path)).catch(() => Buffer.alloc(0))).length > 0;
    Object.assign(checks, await scientificChecks(scenario, root, fixture, receipts, output, workspace));
    await writeFile(join(root, "final-checkpoint.json"), JSON.stringify(checkpoint, null, 2));
    const passed = Object.values(checks).every(Boolean), recoveryCounters = checkpoint?.recoveryCounters ?? {};
    const resumeAudit = resumeBefore && scenario.resume ? {before:resumeBefore,after:{runId:checkpoint.contract.runId,budgets:checkpoint.contract.budgets,generatedTokens:checkpoint.generatedTokens,activeTimeMs:checkpoint.activeTimeMs},sameRun:resumeBefore.runId===checkpoint.contract.runId,budgetsPreserved:JSON.stringify(resumeBefore.budgets)===JSON.stringify(checkpoint.contract.budgets),usageNotRefunded:checkpoint.generatedTokens>=resumeBefore.generatedTokens&&checkpoint.activeTimeMs>=resumeBefore.activeTimeMs} : undefined;
    const intentionalCheckpointResume = scenario.fault === "pause_after_compile" && injected && interruptedState === "paused" && recoveryCounters.resumes === 1
      && !checkpoint.hostRecovered && !recoveryCounters.instanceRebinds && !recoveryCounters.journalReconciliations && resumeAudit?.sameRun && resumeAudit.budgetsPreserved && resumeAudit.usageNotRefunded;
    const outcome = classifyAcceptanceOutcome({passed,finalState:checkpoint?.state,hostRecovered:checkpoint?.hostRecovered,recoveryCounters,failedTool:receipts.some(result=>!result.ok),intentionalCheckpointResume});
    return caseResult = {family: scenario.id, repeat: scenario.repeat, scenarioKind:scenario.scenarioKind??"scientific", workspace: relative(outputRoot, root), status: passed ? "passed" : "failed", outcome, recoveryCounters, intentionalCheckpointResume:Boolean(intentionalCheckpointResume), resumeAudit,
      recoveryMeaning: intentionalCheckpointResume ? "Intentional public pause/resume in the same AgentService; model-authored continuation with preserved budgets. This is not app-restart evidence." : outcome === "host_recovery" ? "Explicit checkpoint, journal, or exact-instance reconnection; model-authored content only. No static task completion fallback." : undefined, checks,
      interruptedState, finalState: checkpoint?.state, error: checkpoint?.error, runId: checkpoint?.contract.runId, instanceId: checkpoint?.instanceId,
      round: checkpoint?.round, generatedTokens: checkpoint?.generatedTokens, activeTimeMs: checkpoint?.activeTimeMs, outputSha256: createHash("sha256").update(output).digest("hex"), tokenCountMethod: checkpoint?.tokenCountMethod,
      injections: injections.slice(beforeInjections), message: end.message?.content};
  } catch (error) {
    // Settlement is bounded independently of task/queue time. Read the final
    // checkpoint before cleanup closes this case's SQLite connection.
    await boundedSettlement(agent.cancelAll()).catch(cleanupError=>{cleanupDiagnostic={code:cleanupError.code,message:String(cleanupError)};requestStop("Owned task cleanup exceeded its bound.");});
    const checkpoint = thread ? new HarnessStore(database.db).latest(thread.id) : undefined;
    await writeFile(join(root, "final-checkpoint.json"), JSON.stringify(checkpoint ?? null, null, 2));
    return caseResult = {family: scenario.id, repeat: scenario.repeat, workspace: relative(outputRoot, root), status: "failed", outcome: checkpoint?.state === "completed" ? "false_completion" : "incomplete", stopped: stopRequested, finalState: checkpoint?.state, error: String(error), code:error.code, cleanupDiagnostic};
  }
  finally {
    clearInterval(watchdog);activeFault=undefined;
    await cleanup().catch(async error=>{process.exitCode=1;await writeFile(join(root,"owned-cleanup-failure.json"),JSON.stringify({code:error.code,message:String(error)},null,2));});
    if(caseResult){
      caseResult.checks??={};caseResult.checks.ownedCleanup=!cleanupDiagnostic;
      if(cleanupDiagnostic){caseResult.status="failed";caseResult.outcome=caseResult.finalState==="completed"?"false_completion":"incomplete";caseResult.cleanupDiagnostic=cleanupDiagnostic;}
    }
    activeAgent=undefined;
  }
}

async function waitForIdle(agent) {
  const deadline = Date.now() + 15000;
  while (agent.hasActiveRuns()) {
    if (Date.now() >= deadline) throw new Error("Agent did not finish owned sidecar cleanup within 15 seconds.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function observeMaterialsIdentity() {
  const {stdout} = await promisify(execFile)(PYTHON,[join(REPO,"scripts/prepare_harness_inputs.py"),"--workspace",outputRoot,"--materials-root",MATERIALS_ROOT,"--kind","identity"],
    {cwd:REPO,windowsHide:true,timeout:180000,maxBuffer:1024*1024,env:{...process.env,PYTHONPATH:join(REPO,"src")}});
  return JSON.parse(stdout);
}

async function assertFrozenInputs(stage) {
  const source = await verifyImplementationInventory(implementation), current = await observeMaterialsIdentity();
  const materialsUnchanged = current.snapshot_id === materialIdentity.snapshot_id && current.manifest_sha256 === materialIdentity.manifest_sha256;
  const pythonUnchanged = JSON.stringify(current.python) === JSON.stringify(materialIdentity.python);
  const observation = {stage,source,materialsUnchanged,pythonUnchanged,valid:source.ok&&materialsUnchanged&&pythonUnchanged};
  appendFileSync(join(outputRoot,"input-observations.jsonl"),JSON.stringify(observation)+"\n");
  if(!observation.valid){await writeFile(join(outputRoot,"invalid-inputs.json"),JSON.stringify(observation,null,2));throw Object.assign(new Error("Measured implementation, installed dependency, Python runtime or active materials identity changed; this matrix is invalid."),{code:"MATRIX_INPUT_DRIFT"});}
}

async function scientificChecks(scenario, root, fixture, receipts, output, workspace) {
  const checks = {};
  const successful = name => receipts.filter(item => item.tool === name && item.ok);
  // Compare the most recent receipt per path: a prior committed revision may
  // legitimately have been replaced by a later checked edit.
  const latestArtifacts = new Map();
  for (const result of receipts.filter(item => item.ok)) for (const artifact of result.data._harnessArtifacts ?? []) latestArtifacts.set(resolve(root, artifact.path).toLowerCase(), artifact);
  for (const artifact of latestArtifacts.values()) {
    const current = await workspace.artifactFingerprint(artifact.path).catch(() => undefined);
    checks[`digest:${artifact.path}`] = current?.sha256 === artifact.sha256;
  }
  if (scenario.check === "material-cursors") {
    const searches = successful("proto_materials_search");
    const cursors = searches.map(item => item.data._harnessArguments?.cursor).filter(Boolean);
    const records = searches.flatMap(item => item.data.matches ?? []);
    const ids = [...new Set(records.map(item => item.resource_id))].slice(0, 3);
    checks.cursorTraversal = new Set(cursors).size >= 2 && ids.length === 3;
    checks.citedResourceIds = ids.every(id => output.includes(id));
    checks.citedMaterialEvidence = checkRecordEvidence(ids.map(id=>records.find(record=>record.resource_id===id)),output,true);
  }
  if (["dna-reversed", "dna-repaired"].includes(scenario.check)) {
    const source = await readFile(join(root, "designs/mission.proto"), "utf8").catch(() => "");
    const ids = [...source.matchAll(/^\s*(?:promoter|rbs|cds|terminator)\s+(\S+)/gm)].map(match => match[1]);
    checks.sourceIdsPreserved = JSON.stringify(ids.slice().sort()) === JSON.stringify(fixture.resource_ids.slice().sort());
    checks.instanceIdsPreserved = ["p1", "r1", "c1", "t1"].every(id => source.includes(`instance=${id}`));
    checks.sourceChanged = createHash("sha256").update(source).digest("hex") !== fixture.source_sha256;
    checks.requestedEdit = scenario.check === "dna-reversed" ? /^\s*cds\s+\S+\s+instance=c1\s+orientation=reverse\s*$/m.test(source) : /^\s*topology linear\s*$/m.test(source) && !source.includes("invalid_fixture_value");
  }
  if (scenario.check === "structure") {
    const fetched = successful("proto_structure_fetch");
    checks.savedOfficialCoordinates = fetched.some(item => ["pdb", "alphafold"].includes(item.data.attachment?.source?.provider)
      && item.data.attachment?.reviewStatus === "human_review_required" && item.data._harnessArtifacts?.length === 2 && item.data.mapping_status === "unverified");
    checks.coordinateReopened = successful("proto_structure_read").some(item => fetched.some(fetch => item.data.attachment?.contentSha256 === fetch.data.attachment?.contentSha256));
  }
  if (scenario.check === "literature-identifiers") {
    checks.providerIdentifierCitations = checkProviderCitations(receipts, output);
  }
  if (scenario.check === "provenance") {
    const workflows = successful("proto_workflow_run");
    checks.provenanceTrace = workflows.some(item => typeof item.data.provenance_path === "string" && output.includes(item.data.provenance_path)) && successful("proto_provenance_verify").length > 0;
    checks.provenanceDigestReported = workflows.some(item => typeof item.data.provenance_path === "string" && item.data._harnessArtifacts?.some(artifact=>resolve(root,artifact.path).toLowerCase()===resolve(root,item.data.provenance_path).toLowerCase()&&output.toLowerCase().includes(artifact.sha256)));
  }
  if (scenario.check === "scientific-exports") {
    const compiled = successful("proto_compile").at(-1), path = compiled?.data._harnessArguments?.out ?? compiled?.data._harnessArtifacts?.find(artifact => /\.ir\.json$/i.test(artifact.path))?.path;
    const ir = path ? parseDesignIr(await readFile(resolve(root, path), "utf8")) : undefined;
    const fasta = await readFile(join(root, "build/export.fasta"), "utf8").catch(() => "");
    const genbank = await readFile(join(root, "build/export.gb"), "utf8").catch(() => "");
    const fastaSequence = fasta.split(/\r?\n/).filter(line => !line.startsWith(">")).join("").replace(/\s/g, "").toUpperCase();
    const genbankSequence = genbank.split(/\bORIGIN\b/)[1]?.split("//")[0].replace(/[^A-Za-z]/g, "").toUpperCase();
    checks.compiledExportSequences = Boolean(ir?.ok && ir.design?.sequence && fasta.startsWith(">") && genbank.startsWith("LOCUS") && fastaSequence === ir.design.sequence && genbankSequence === ir.design.sequence);
  }
  if (scenario.check === "protein-report") {
    let report;
    try { report = JSON.parse(await readFile(join(root, "build/protein-summary.json"), "utf8")); } catch {report = null;}
    const rows = Array.isArray(report) ? report : report?.proteins;
    const expected = successful("proto_protein_inspect").at(-1)?.data.proteins ?? [];
    checks.proteinSummaryMatches = Boolean(Array.isArray(rows) && rows.length === expected.length && expected.length && expected.every(protein => rows.some(row => row.id === protein.id && row.length === protein.length && row.sequence_sha256 === protein.sequence_sha256)));
    // This report explicitly maps the output-facing protein ID. A catalogue
    // resource_id is separate provenance and cannot replace that requested ID.
    checks.proteinEvidenceTable = checkRecordEvidence(expected.map(protein=>({...protein,resource_id:protein.id})),await readFile(join(root,"build/evidence-table.md"),"utf8").catch(()=>""));
  }
  return checks;
}
