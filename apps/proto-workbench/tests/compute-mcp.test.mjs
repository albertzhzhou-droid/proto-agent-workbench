import { ManagedMcpTestClient } from "./helpers/managed-mcp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpClient } from "../src/main/services/mcp-client.ts";
import { classifyTool, isToolExposedToModel } from "../src/main/services/permissions.ts";
import { minimalChildEnvironment } from "../src/main/services/process-security.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const python = process.env.PROTO_AGENT_PYTHON || join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
// Point at a verified resources tree to exercise its bundled sidecar instead.
// An explicitly requested missing/broken package fails; it is never skipped.
const packagedResources = process.env.PROTO_COMPUTE_PACKAGED_RESOURCES;
const sha256 = value => createHash("sha256").update(value).digest("hex");

function optionalDependencyStatus() {
  const probe = spawnSync(python, ["-c", "import importlib.util,json; print(json.dumps([n for n in ['numpy','scipy'] if importlib.util.find_spec(n) is None]))"], {
    encoding: "utf8", timeout: 10_000, windowsHide: true, env: minimalChildEnvironment(),
  });
  if (probe.error?.code === "ENOENT") return "Project Python interpreter is not installed.";
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  const missing = JSON.parse(probe.stdout);
  return missing.length ? `Optional compute dependencies are not installed: ${missing.join(", ")}.` : false;
}

test(`Workbench MCP transport discovers and executes offline computations in a real owned ${packagedResources ? "packaged sidecar" : "source Python process"}`, {
  skip: packagedResources ? false : optionalDependencyStatus(), timeout: 30_000,
}, async t => {
  const owned = resolve("build/test-compute-mcp");
  await mkdir(owned, { recursive: true });
  const workspace = await mkdtemp(join(owned, "actual-"));
  const outside = join(owned, `${basename(workspace)}-outside.json`);
  const client = new ManagedMcpTestClient({
    packaged: Boolean(packagedResources), resourcesPath: packagedResources ? resolve(packagedResources) : "", repoRoot: repo, workspacePath: workspace,
    workspaceCapability: randomBytes(32).toString("hex"), materialsRoot: join(workspace, "isolated-materials"), pythonExecutable: python,
  }, { startupTimeoutMs: 10_000, controlTimeoutMs: 10_000 });
  const successfulRuns = [];
  try {
    await t.test("tool discovery and schemas work with network and arbitrary execution disabled", async () => {
      const tools = await client.tools();
      const capabilities = await client.capabilities();
      assert.equal(capabilities.execution.mode, "disabled");
      assert.equal(capabilities.execution.available, false);
      assert.equal(capabilities.networkEnabled, false);
      for (const name of ["proto_compute_catalog", "proto_compute_run"]) {
        assert.ok(tools.some(tool => tool.name === name), `${name} is discoverable over stdio`);
        assert.deepEqual(classifyTool(name), { allowed: true, risk: "none" });
        assert.equal(isToolExposedToModel(name), true);
      }
      const catalog = await client.call("proto_compute_catalog", {});
      assert.equal(catalog.ok, true);
      for (const id of ["compare_two_groups", "analyze_rna_secondary_structure_features"]) {
        assert.equal(catalog.tools.find(tool => tool.id === id)?.available, true);
        const detail = await client.call("proto_compute_catalog", { tool: id });
        assert.equal(detail.ok, true);
        assert.equal(detail.tools.length, 1);
        assert.equal(detail.tools[0].id, id);
        assert.equal(detail.tools[0].input_schema.type, "object");
        assert.ok(detail.tools[0].example);
      }
    });

    await t.test("native statistics and ported RNA topology return real source-bound artifacts", async () => {
      const requests = [
        {
          tool: "compare_two_groups", arguments: { group_a: [1, 1, 1], group_b: [1, 2, 3], method: "welch_t" },
          verify: result => {
            assert.ok(Math.abs(result.statistic + Math.sqrt(3)) < 1e-12);
            assert.ok(Math.abs(result.p_value - (1-Math.sqrt(3/5))) < 1e-12);
            assert.equal(result.degrees_of_freedom, 2);
          },
        },
        {
          tool: "analyze_rna_secondary_structure_features", arguments: { dot_bracket_structure: "(((...)))", sequence: "GGGAAACCC" },
          verify: result => {
            assert.equal(result.base_pair_count, 3);
            assert.equal(result.stem_count, 1);
            assert.equal(result.longest_stem_length, 3);
            assert.equal(result.loop_counts.hairpin, 1);
            assert.equal(result.pair_types.canonical, 3);
          },
        },
      ];
      for (const { tool, arguments: arguments_, verify } of requests) {
        const path = `${tool}.json`;
        const requestBytes = Buffer.from(`${JSON.stringify({ tool, arguments: arguments_ }, null, 2)}\n`);
        await writeFile(join(workspace, path), requestBytes);
        // No network capability, approval token, sandbox, or execution grant.
        let response;
        try {
          response = await client.call("proto_compute_run", { path }, undefined, undefined, { timeoutMs: 15_000 });
        } catch (error) {
          t.diagnostic(`Compute transport failure: ${error.message}; sidecar stderr: ${client.stderrBuffer}`);
          throw error;
        }
        assert.equal(response.ok, true, JSON.stringify(response));
        assert.equal(response.tool, tool);
        assert.equal(response.review_status, "human_review_required");
        assert.equal(response.source.sha256, sha256(requestBytes));
        assert.match(response.manifest_path, /^build\/compute\/[a-f0-9]{32}\/manifest\.json$/);
        const directory = response.manifest_path.slice(0, -"manifest.json".length);
        const resultBytes = await readFile(join(workspace, directory, "result.json"));
        const snapshotBytes = await readFile(join(workspace, directory, "input.json"));
        const manifest = JSON.parse(await readFile(join(workspace, response.manifest_path), "utf8"));
        assert.deepEqual(snapshotBytes, requestBytes);
        assert.equal(manifest.result_sha256, sha256(resultBytes));
        assert.deepEqual(JSON.parse(resultBytes.toString("utf8")), response.result);
        verify(response.result);
        for (const artifact of response.artifacts) {
          assert.ok(artifact.startsWith(directory));
          assert.ok((await readFile(join(workspace, artifact))).byteLength > 0);
        }
        const verification = await client.call("proto_provenance_verify", { path: `${directory}provenance.json` });
        assert.equal(verification.ok, true, JSON.stringify(verification));
        successfulRuns.push(directory);
      }
      assert.notEqual(successfulRuns[0], successfulRuns[1], "each computation has its own run directory");
    });

    await t.test("nonfinite, unreviewed-operation and out-of-root requests fail without new artifacts", async () => {
      const runDirectory = join(workspace, "build/compute");
      const before = (await readdir(runDirectory)).sort();
      await writeFile(join(workspace, "nonfinite.json"), '{"tool":"descriptive_statistics","arguments":{"values":[1,NaN]}}');
      const nonfinite = await client.call("proto_compute_run", { path: "nonfinite.json" });
      assert.equal(nonfinite.ok, false);
      assert.equal(nonfinite.diagnostics[0].code, "COMPUTE_INVALID_JSON");
      await writeFile(join(workspace, "arbitrary.json"), JSON.stringify({ tool: "execute_python", arguments: { code: "print('unreviewed')" } }));
      const arbitrary = await client.call("proto_compute_run", { path: "arbitrary.json" });
      assert.equal(arbitrary.ok, false);
      assert.equal(arbitrary.diagnostics[0].code, "COMPUTE_UNKNOWN_TOOL");
      await writeFile(outside, JSON.stringify({ tool: "descriptive_statistics", arguments: { values: [1, 2, 3] } }));
      for (const path of [`../${basename(outside)}`, outside]) {
        const escaped = await client.call("proto_compute_run", { path });
        assert.equal(escaped.ok, false, JSON.stringify(escaped));
        assert.match(escaped.diagnostics[0].code, /PATH|ABSOLUTE/);
      }
      assert.deepEqual((await readdir(runDirectory)).sort(), before);
      assert.equal((await client.call("proto_compute_catalog", {})).ok, true, "rejections leave the session usable");
    });

    await t.test("provenance detects a result altered after the successful receipt", async () => {
      assert.ok(successfulRuns.length > 0);
      const directory = successfulRuns[0];
      await writeFile(join(workspace, directory, "result.json"), '{"tampered":true}\n');
      const verification = await client.call("proto_provenance_verify", { path: `${directory}provenance.json` });
      assert.equal(verification.ok, false);
    });
  } finally {
    const child = client.child;
    await client.stop();
    if (child) assert.ok(child.exitCode !== null || child.signalCode !== null, "the owned Python process exits before cleanup");
    const local = relative(owned, workspace);
    assert.ok(local && !local.startsWith("..") && !isAbsolute(local));
    const externalFixture = relative(owned, outside);
    assert.ok(externalFixture && !externalFixture.startsWith("..") && !isAbsolute(externalFixture));
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
