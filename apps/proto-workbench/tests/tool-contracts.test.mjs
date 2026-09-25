import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {join} from "node:path";

import {TOOL_CONTRACTS, toolContract, resolveToolContract, toolNamesForSurface, contractDeadlineMs, evaluateToolDispatch, toolsProducing} from "../src/shared/tool-contracts.ts";
import {CORE_MODULES, OPTIONAL_MODULES} from "../src/shared/modules.ts";
import {declaredMcpToolEffect, isKnownWriteMcpTool, isUnregisteredTool} from "../src/main/services/tool-effects.ts";
import {classifyTool, classifyToolCall, isToolExposedToModel, isNetworkTool} from "../src/main/services/permissions.ts";
import {canonicalScienceTools, canonicalScienceName, unregisteredScienceTools} from "../src/shared/research-tool-registry.ts";
import {cacheableResearchCall} from "../src/main/services/research-tools.ts";

const repoFile = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Tool names the Python MCP server actually dispatches, read from its handler table. */
function pythonMcpToolNames() {
  const source = repoFile("../../../src/proto_agent/mcp_server.py");
  const table = source.slice(source.indexOf('"proto_data_read": self._tool_data_read'));
  const end = table.indexOf("\n        }");
  assert.ok(end > 0, "the MCP handler table must be delimited");
  return [...table.slice(0, end).matchAll(/^\s*"(proto_[a-z0-9_]+)":/gmu)].map((match) => match[1]);
}

function pythonNetworkToolNames() {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const python = process.env.PROTO_AGENT_PYTHON || join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const probe = spawnSync(python,["-c","import json; from proto_agent.mcp_server import NETWORK_TOOLS; print(json.dumps(sorted(NETWORK_TOOLS)))"],{cwd:repo,encoding:"utf8",timeout:30_000,env:{...process.env,PYTHONPATH:join(repo,"src")}});
  assert.equal(probe.status,0,probe.stderr || String(probe.error));
  return JSON.parse(probe.stdout);
}

test("every dispatched MCP tool has a contract row and no row names a missing tool", () => {
  const dispatched = pythonMcpToolNames();
  assert.equal(dispatched.length, 43, "the handler table parse must find every tool");
  const missing = dispatched.filter((name) => !toolContract(name));
  assert.deepEqual(missing, [], "MCP tools without a contract would fail closed as writes");
  const phantom = toolNamesForSurface("mcp").filter((name) => !dispatched.includes(name));
  assert.deepEqual(phantom, [], "contract rows must not describe tools the backend does not dispatch");
});

test("network classification agrees with the Python network gate", () => {
  const declared = pythonNetworkToolNames();
  assert.ok(declared.length > 0);
  for (const name of declared) assert.equal(isNetworkTool(name), true, `${name} must be a network tool on both sides`);
  const tsOnly = toolNamesForSurface("mcp").filter((name) => isNetworkTool(name) && !declared.includes(name));
  // proto_remote_run reaches a configured remote executor rather than a public
  // database, so it is gated by the host but not by the Python database gate.
  assert.deepEqual(tsOnly, ["proto_remote_run"]);
});

test("read-only lookups are journalled as reads, not fail-closed writes", () => {
  for (const name of [
    "proto_pubmed_search", "proto_europe_pmc_search", "proto_crossref_search", "proto_uniprot_search",
    "proto_rhea_search", "proto_literature_search", "proto_connectors_check", "proto_language_reference",
    "proto_protein_validate", "proto_r_status", "proto_remote_catalog", "proto_skills_list", "proto_skills_resolve",
  ]) {
    assert.equal(declaredMcpToolEffect(name), "read", `${name} must not be replayed as a write on recovery`);
    assert.equal(isKnownWriteMcpTool(name), false);
  }
});

test("unregistered names are rejected instead of inheriting an effect", () => {
  assert.equal(isUnregisteredTool("proto_not_a_tool"), true);
  assert.throws(() => declaredMcpToolEffect("proto_not_a_tool"), /UNKNOWN_CAPABILITY/);
  assert.deepEqual(classifyTool("proto_not_a_tool"), {
    allowed: false, risk: "code-execution", reason: "Unknown tools are denied by default.",
  });
});

test("authorization classes are unchanged by the contract table", () => {
  assert.deepEqual(classifyTool("proto_compute_run"), {allowed: true, risk: "none"});
  assert.equal(classifyTool("proto_pubmed_search").risk, "network");
  assert.equal(classifyTool("proto_run_r").risk, "code-execution");
  assert.equal(classifyTool("workspace_apply_patch").risk, "write");
  // A patch is applied by the reviewer, so it stays out of the model's tool list.
  assert.equal(isToolExposedToModel("workspace_apply_patch"), false);
  assert.equal(isToolExposedToModel("proto_pubmed_search"), true);
  assert.equal(isToolExposedToModel("proto_run_analysis"), true);
  assert.deepEqual(classifyToolCall("proto_pubmed_search", {offline: true}), {allowed: true, risk: "none"});
  assert.equal(classifyToolCall("proto_pubmed_search", {}).risk, "network");
});

test("main-process structure tools keep their own surface", () => {
  assert.equal(toolContract("proto_protein_inspect").surface, "harness");
  assert.equal(toolContract("proto_structure_fetch").effect, "write");
  assert.equal(toolContract("proto_structure_read").effect, "read");
  assert.equal(isNetworkTool("proto_structure_search"), true);
});

test("discovery drops unregistered names instead of inventing a design capability", () => {
  const offered = [{name: "proto_compute_run"}, {name: "proto_check"}, {name: "proto_not_a_tool"}];
  const tools = canonicalScienceTools(offered);
  assert.deepEqual(tools.map((tool) => tool.id), ["compute.run", "design.check"]);
  assert.deepEqual(unregisteredScienceTools(offered), ["proto_not_a_tool"]);
  assert.equal(canonicalScienceName("biomni.run"), "compute.run");
  assert.equal(canonicalScienceName("proto_not_a_tool"), "proto_not_a_tool");
  assert.equal(resolveToolContract("query_pubmed").name, "proto_pubmed_search");
});

test("only external reads are cached, so a local lookup is not mistaken for one", () => {
  assert.equal(cacheableResearchCall("science_run", {name: "literature.pubmed"}), true);
  assert.equal(cacheableResearchCall("science_run", {name: "database.uniprot"}), true);
  assert.equal(cacheableResearchCall("science_run", {name: "literature.local"}), false);
  assert.equal(cacheableResearchCall("science_run", {name: "compute.run"}), false);
  assert.equal(cacheableResearchCall("science_catalog", {name: "literature.pubmed"}), false);
});

test("every contract row is internally consistent", () => {
  const capabilities = new Set();
  const modules = [...CORE_MODULES, ...OPTIONAL_MODULES];
  for (const contract of TOOL_CONTRACTS.values()) {
    assert.ok(contract.capabilityId, `${contract.name} needs a capability id`);
    assert.equal(capabilities.has(contract.capabilityId), false, `duplicate capability id ${contract.capabilityId}`);
    capabilities.add(contract.capabilityId);
    assert.equal(modules.filter(module => module.tools.includes(contract.name)).length, 1);
    assert.equal(modules.find(module => module.id === contract.module).tools.includes(contract.name), true);
    assert.ok(contract.deadline.defaultMs > 0);
    assert.ok(contract.outputBudget.maxBytes >= contract.outputBudget.projectedBytes);
    assert.ok(contract.maturityRef);
    assert.ok(contract.produces.length > 0);
    assert.deepEqual(contract.preconditions.slice(0, 2), ["schema-validated", "within-run-budget"]);
    assert.equal(contract.idempotent, contract.effect === "read");
    assert.ok(["cheap", "metered", "external"].includes(contract.costClass));
    assert.ok(Number.isSafeInteger(contract.maxCallsPerRun) && contract.maxCallsPerRun > 0);
    assert.ok(["none", "network", "code-execution", "write"].includes(contract.risk));
    if (contract.network) {
      assert.notEqual(contract.access, "auto", `${contract.name} reaches the network and must need a grant`);
    }
  }
});

test("live Python tools/list and chemistry catalog agree bidirectionally with contracts", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const python = process.env.PROTO_AGENT_PYTHON || join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const probe = spawnSync(python, ["-c", `
import json, tempfile
from proto_agent.mcp_server import McpServer
from proto_agent.tool_contracts import export_contracts
with tempfile.TemporaryDirectory(prefix="proto-contract-parity-") as workspace:
    response = McpServer(workspace).handle_message({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}})
    print(json.dumps({"names":[tool["name"] for tool in response["result"]["tools"]], "contracts":export_contracts()["tools"]}))
`], {cwd:repo, encoding:"utf8", timeout:30_000, env:{...process.env, PYTHONPATH:join(repo,"src")}});
  assert.equal(probe.status, 0, probe.stderr || String(probe.error));
  const pythonSurface = JSON.parse(probe.stdout);
  assert.deepEqual(pythonSurface.names.sort(), toolNamesForSurface("mcp").sort());
  for (const row of pythonSurface.contracts) {
    const host = toolContract(row.name);
    assert.deepEqual({effect:host.effect,network:host.network,access:host.access,capability_id:host.capabilityId,
      preconditions:host.preconditions,produces:host.produces,idempotent:host.idempotent,cost_class:host.costClass,max_calls_per_run:host.maxCallsPerRun},
      {effect:row.effect,network:row.network,access:row.access,capability_id:row.capability_id,
        preconditions:row.preconditions,produces:row.produces,idempotent:row.idempotent,cost_class:row.cost_class,max_calls_per_run:row.max_calls_per_run}, row.name);
  }
  const chem = spawnSync(python, [join(repo,"apps/proto-workbench/runtime/chem-integration/chem_science.py")], {
    cwd:repo, encoding:"utf8", timeout:30_000, input:JSON.stringify({operator:"catalog",input:{}}),
  });
  assert.equal(chem.status, 0, chem.stderr || String(chem.error));
  const catalog = JSON.parse(chem.stdout);
  assert.equal(catalog.ok, true, JSON.stringify(catalog.error));
  const names = catalog.result.operators.map(operator => `chemistry.${operator.id}`).sort();
  assert.deepEqual(names, toolNamesForSurface("chemistry").filter(name => toolContract(name).effect === "write").sort());
});

test("tool deadlines are registered and validate execution timeout overrides", () => {
  assert.equal(contractDeadlineMs("proto_compute_run", {}), 630_000);
  assert.equal(contractDeadlineMs("proto_run_analysis", {timeout: 30}), 60_000);
  assert.throws(() => contractDeadlineMs("proto_run_analysis", {timeout: 601}), /between 1 and 600/);
  assert.throws(() => contractDeadlineMs("unknown", {}), /UNKNOWN_CAPABILITY/);
});

test("the packaged Python snapshot is generated exactly from the canonical host rows", () => {
  const expected={schema_version:"proto-agent.tool-contract.v1",tools:[...TOOL_CONTRACTS.values()]
    .filter(contract=>contract.surface==="mcp")
    .map(contract=>({name:contract.name,effect:contract.effect,network:contract.network,access:contract.access,capability_id:contract.capabilityId,
      preconditions:contract.preconditions,produces:contract.produces,idempotent:contract.idempotent,cost_class:contract.costClass,max_calls_per_run:contract.maxCallsPerRun}))};
  assert.equal(repoFile("../../../src/proto_agent/data/tool-contracts.json"),`${JSON.stringify(expected,null,2)}\n`);
});

test("dispatch guards require positive host facts before any effect and retain canonical alias caps", () => {
  const facts = {"schema-validated": true, "within-run-budget": true};
  assert.deepEqual(evaluateToolDispatch("biomni.run", {calls: 0, facts}), {allowed: true, tool: "proto_compute_run"});
  const exhausted = evaluateToolDispatch("science.compute.run", {calls: toolContract("proto_compute_run").maxCallsPerRun, facts});
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.code, "TOOL_CALL_LIMIT_EXCEEDED");
  assert.equal(exhausted.tool, "proto_compute_run");
  assert.equal(exhausted.effect_state, "none");
  const binding = evaluateToolDispatch("design.compile", {calls: 0, facts});
  assert.equal(binding.code, "TOOL_PRECONDITION_FAILED");
  assert.deepEqual(binding.missing, ["material-binding"]);
  assert.equal(evaluateToolDispatch("design.compile", {calls: 0, facts: {...facts, "material-binding": true}}).allowed, true);
  assert.equal(evaluateToolDispatch("workspace_read", {calls: 0, facts: {...facts, "within-run-budget": false}}).code, "TOOL_PRECONDITION_FAILED");
  assert.equal(evaluateToolDispatch("workspace_read", {calls: 0, facts: {}}).allowed, false);
  for (const calls of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.equal(evaluateToolDispatch("workspace_read", {calls, facts}).allowed, false, `corrupt persisted call count ${calls}`);
  }
  assert.equal(evaluateToolDispatch("invented.read", {calls: 0, facts}).code, "UNKNOWN_CAPABILITY");
});

test("remedies only name available receipt producers without expanding policy or inventing renderer authority", () => {
  const offered = ["proto_materials_search", "proto_materials_materialize_proteins", "materials.materialize_proteins", "unknown"];
  assert.deepEqual(toolsProducing("protein-materialization", offered).map(row => row.name), ["proto_materials_materialize_proteins"]);
  assert.deepEqual(toolsProducing("protein-materialization", ["proto_materials_search"]), []);
  assert.deepEqual(toolsProducing("workspace-read", ["workspace_search", "workspace_list"]), []);
  assert.deepEqual(toolsProducing("scientific-export", ["proto_remote_run"]), [], "denied tools cannot become remedies");
  assert.equal(toolsProducing("scientific-export", ["proto_research_figure_render"])[0].effect, "write", "fixed local figure rendering retains its journalled write boundary");
  assert.deepEqual(toolsProducing("rendered-binary", TOOL_CONTRACTS.keys()), [], "a raw export is not a trusted renderer receipt");
  assert.equal(toolContract("workspace_propose_patch").idempotent, false, "CAS proof recovery must never become write replay");
  assert.equal(toolContract("harness_report_blocked").maxCallsPerRun, Number.MAX_SAFE_INTEGER);
});
