import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { IPC } from "../src/shared/ipc.ts";
import { IPC_CHANNEL_CONTRACTS, validateChannelArguments, validateChannelResult } from "../src/shared/ipc-channel-contracts.ts";
import {
  CREDENTIAL_MODES,
  GATEWAY_PROTOCOLS,
  PRESENCE_SENTINEL,
  PROVIDER_CREDENTIAL_ENVIRONMENT,
  PROVIDER_IDS,
  PYTHON_PROFILE_IDS,
  R_PROFILE_IDS,
  VALIDATION_CATEGORIES,
} from "../src/shared/provider-setup.ts";
import {
  ProviderSetupError,
  ProviderSetupService,
  presenceEnvironment,
  setupArguments,
  verifyArguments,
  verifyEnvironment,
} from "../src/main/services/provider-setup.ts";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "..", "..");
const python = process.env.PROTO_AGENT_PYTHON || join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const FAKE_KEY = `sk-ant-api03-${"A1b2C3d4".repeat(6)}`;
const METRICS = { elapsed_ms: 1, files_written: 0, network_requests: 0 };

const STATUS = { ok: true, ready: false, initialized: true, next: [], issues: [], metrics: METRICS };
const VERDICT = { provider: "anthropic-api", ok: false, category: "auth", code: "CREDENTIAL_MISSING", message: "ANTHROPIC_API_KEY is not set.", metrics: METRICS };

function service(handler, { environment = {}, workspace = true } = {}) {
  const calls = [];
  const svc = new ProviderSetupService({
    run: async (args, env, timeout) => { calls.push({ args, env, timeout }); return handler(args, env); },
    environment: () => environment,
    hasWorkspace: () => workspace,
  });
  return { svc, calls };
}

test("presence-only commands see a sentinel, never a key", () => {
  const env = presenceEnvironment({ ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: "   ", PATH: "/bin", AWS_SECRET_ACCESS_KEY: "secret" });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: PRESENCE_SENTINEL });
  assert.ok(!JSON.stringify(env).includes(FAKE_KEY));
});

test("verify receives exactly one real credential, chosen by the provider the user verifies", () => {
  const source = { ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: "tok_other", PROTO_GATEWAY_API_KEY: "tok_gw", AWS_SECRET_ACCESS_KEY: "secret" };
  assert.deepEqual(verifyEnvironment("anthropic-api", source), { ANTHROPIC_API_KEY: FAKE_KEY });
  assert.deepEqual(verifyEnvironment("openai-api", source), { OPENAI_API_KEY: "tok_other" });
  assert.deepEqual(verifyEnvironment("custom-gateway", source), { PROTO_GATEWAY_API_KEY: "tok_gw" });
  assert.deepEqual(verifyEnvironment("anthropic-api", {}), {});
  assert.deepEqual(verifyEnvironment("anthropic-api", { ANTHROPIC_API_KEY: "  " }), {});
});

test("argument values cannot become flags", () => {
  const args = setupArguments({ provider: "custom-gateway", model: "m-1", baseUrl: "--force", protocol: "messages", force: false });
  assert.deepEqual(args, ["start", "--provider=custom-gateway", "--model=m-1", "--base-url=--force", "--protocol=messages"]);
  assert.ok(!args.includes("--force"));
  assert.deepEqual(setupArguments({ provider: "openai-api", force: true }), ["start", "--provider=openai-api", "--force"]);
  assert.deepEqual(verifyArguments({ provider: "custom-gateway", approveNetwork: true, approveHost: "gw.example.com" }),
    ["verify", "--provider=custom-gateway", "--approve-network", "--approve-host=gw.example.com"]);
  assert.deepEqual(verifyArguments({ provider: "anthropic-api", approveNetwork: true }), ["verify", "--provider=anthropic-api", "--approve-network"]);
});

test("request schemas bound every field and make network approval explicit", () => {
  assert.throws(() => validateChannelArguments(IPC.providerSetupVerify, [{ provider: "anthropic-api", approveNetwork: false }]), /Invalid arguments/);
  assert.throws(() => validateChannelArguments(IPC.providerSetupVerify, [{ provider: "anthropic-api" }]), /Invalid arguments/);
  assert.throws(() => validateChannelArguments(IPC.providerSetupVerify, [{ provider: "anthropic-api", approveNetwork: true, approveHost: "evil.com/x" }]), /Invalid arguments/);
  assert.throws(() => validateChannelArguments(IPC.providerSetupVerify, [{ provider: "anthropic-api", approveNetwork: true, apiKey: FAKE_KEY }]), /Invalid arguments/);
  assert.doesNotThrow(() => validateChannelArguments(IPC.providerSetupVerify, [{ provider: "custom-gateway", approveNetwork: true, approveHost: "gw.example.com" }]));
  for (const bad of [{ provider: "evil" }, { provider: "anthropic-api", model: "has space" }, { provider: "anthropic-api", model: "../x" },
    { provider: "anthropic-api", keyEnv: "X" }, { provider: "anthropic-api", apiKey: FAKE_KEY }, { provider: "custom-gateway", baseUrl: "x".repeat(300) },
    { provider: "anthropic-api", pythonProfile: "everything" }, { provider: "anthropic-api", credentialMode: "open" }]) {
    assert.throws(() => validateChannelArguments(IPC.providerSetupApply, [bad]), /Invalid arguments/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => validateChannelArguments(IPC.providerSetupApply, [{ provider: "anthropic-api", model: "claude-sonnet-5-5", pythonProfile: "analysis", rProfile: "rnaseq", force: true }]));
  assert.throws(() => validateChannelArguments(IPC.providerSetupOverview, [{}]), /Invalid arguments/);
});

test("setup results are validated field by field at the bridge", () => {
  for (const channel of [IPC.providerSetupOverview, IPC.providerSetupApply, IPC.providerSetupVerify]) {
    assert.equal(IPC_CHANNEL_CONTRACTS[channel].resultValidation, "fields");
  }
  assert.throws(() => validateChannelResult(IPC.providerSetupVerify, { provider: "anthropic-api", ok: true, category: "maybe", metrics: METRICS }));
  assert.throws(() => validateChannelResult(IPC.providerSetupApply, { ok: true }));
  assert.equal(validateChannelResult(IPC.providerSetupVerify, VERDICT).category, "auth");
});

test("the service never starts without a workspace", async () => {
  const { svc, calls } = service(async () => ({ code: 0, stdout: "{}", stderr: "" }), { workspace: false });
  for (const call of [() => svc.overview(), () => svc.apply({ provider: "anthropic-api" }), () => svc.verify({ provider: "anthropic-api", approveNetwork: true })]) {
    await assert.rejects(call, error => error instanceof ProviderSetupError && error.code === "WORKSPACE_REQUIRED");
  }
  assert.equal(calls.length, 0);
});

test("overview and apply pass only sentinels to the sidecar", async () => {
  const environment = { ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: "tok_other" };
  const result = { ok: true, apply: { ok: true, changed: true, provider: "anthropic-api", written: [], unchanged: [], warnings: [], next_steps: [], metrics: METRICS }, verify: null, status: STATUS, metrics: METRICS };
  const { svc, calls } = service(async () => ({ code: 0, stdout: JSON.stringify(result), stderr: "" }), { environment });
  await svc.apply({ provider: "anthropic-api", model: "claude-sonnet-5-5" });
  assert.deepEqual(calls[0].env, { ANTHROPIC_API_KEY: PRESENCE_SENTINEL, OPENAI_API_KEY: PRESENCE_SENTINEL });
  assert.ok(!JSON.stringify(calls).includes(FAKE_KEY));
});

test("verify passes the one real key and tolerates exit 1 as an answer", async () => {
  const environment = { ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: "tok_other" };
  const { svc, calls } = service(async () => ({ code: 1, stdout: JSON.stringify({ ...VERDICT, status: STATUS }), stderr: "" }), { environment });
  const verdict = await svc.verify({ provider: "anthropic-api", approveNetwork: true });
  assert.equal(verdict.category, "auth");
  assert.deepEqual(calls[0].env, { ANTHROPIC_API_KEY: FAKE_KEY });
  assert.deepEqual(calls[0].args, ["verify", "--provider=anthropic-api", "--approve-network"]);
  assert.ok(calls[0].timeout >= 25_000, "verify allows for the provider's own timeout");
});

test("subscription and local providers have no live check", async () => {
  const { svc, calls } = service(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  for (const provider of ["claude-subscription", "codex-subscription", "local-lm-studio"]) {
    await assert.rejects(() => svc.verify({ provider, approveNetwork: true }), error => error.code === "VERIFY_NOT_APPLICABLE");
  }
  assert.equal(calls.length, 0);
});

test("sidecar failures surface as typed errors without leaking raw output", async () => {
  const diagnostic = JSON.stringify({ ok: false, diagnostics: [{ severity: "error", code: "GATEWAY_REQUIRES_HTTPS", message: "Remote gateways must use https://." }], artifacts: [] });
  const cases = [
    [{ code: 2, stdout: "", stderr: diagnostic }, "GATEWAY_REQUIRES_HTTPS"],
    [{ code: 2, stdout: "", stderr: "Traceback ..." }, "SIDECAR_FAILED"],
    [{ code: 0, stdout: "not json", stderr: "" }, "SIDECAR_INVALID_JSON"],
    [{ code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" }, "SIDECAR_CONTRACT_MISMATCH"],
    [{ code: 0, stdout: "x".repeat(1024 * 1024 + 1), stderr: "" }, "SIDECAR_OUTPUT_TOO_LARGE"],
    [{ code: null, stdout: "", stderr: "" }, "SIDECAR_FAILED"],
  ];
  for (const [result, code] of cases) {
    const { svc } = service(async () => result);
    await assert.rejects(() => svc.overview(), error => error instanceof ProviderSetupError && error.code === code, code);
  }
});

test("the shared constants agree with the Python catalog", async t => {
  const outcome = await runSidecar(["catalog"], {}, repo);
  if (outcome.skipped) return t.skip(outcome.skipped);
  assert.equal(outcome.code, 0, outcome.stderr);
  const catalog = JSON.parse(outcome.stdout);
  assert.deepEqual(catalog.providers.map(entry => entry.id).sort(), [...PROVIDER_IDS].sort());
  for (const entry of catalog.providers) {
    if (entry.id in PROVIDER_CREDENTIAL_ENVIRONMENT) assert.equal(entry.credential_environment, PROVIDER_CREDENTIAL_ENVIRONMENT[entry.id], entry.id);
    else assert.equal(entry.credential_environment, undefined, entry.id);
  }
  assert.deepEqual(catalog.python_profiles.map(entry => entry.id).sort(), [...PYTHON_PROFILE_IDS].sort());
  assert.deepEqual(catalog.r_profiles.map(entry => entry.id).sort(), [...R_PROFILE_IDS].sort());
  assert.deepEqual([...catalog.gateway_protocols].sort(), [...GATEWAY_PROTOCOLS].sort());
  assert.deepEqual([...catalog.credential_modes].sort(), [...CREDENTIAL_MODES].sort());
  assert.deepEqual([...catalog.validation_categories].sort(), [...VALIDATION_CATEGORIES].sort());
});

test("the real sidecar round-trips through the service offline", async t => {
  const probe = await runSidecar(["catalog"], {}, repo);
  if (probe.skipped) return t.skip(probe.skipped);
  const workspace = await mkdtemp(join(tmpdir(), "proto-provider-setup-"));
  try {
    const svc = new ProviderSetupService({
      run: (args, env) => runSidecar(args, env, workspace),
      environment: () => ({ ANTHROPIC_API_KEY: FAKE_KEY }),
      hasWorkspace: () => true,
    });
    const overview = await svc.overview();
    assert.equal(overview.status.initialized, false);
    assert.equal(overview.detection.providers["anthropic-api"].credential_present, true, "the sentinel proves presence");
    assert.equal(overview.detection.recommended_provider, "anthropic-api");
    assert.ok(!JSON.stringify(overview).includes(FAKE_KEY));

    const applied = await svc.apply({ provider: "anthropic-api", model: "claude-sonnet-5-5", pythonProfile: "analysis", rProfile: "none" });
    assert.equal(applied.apply.changed, true);
    assert.equal(applied.status.initialized, true);
    assert.equal(applied.status.verification?.state, "never");
    assert.equal(applied.status.ready, true, "a present key with an unverified provider is ready to verify, not blocked");
    for (const file of ["workspace.json", "python.json", "r.json", "workspace.proto"]) {
      const text = await readFile(join(workspace, ".proto", "workspace", file), "utf8");
      assert.ok(!text.includes(FAKE_KEY) && !text.includes(PRESENCE_SENTINEL), file);
    }

    const again = await svc.apply({ provider: "anthropic-api", model: "claude-sonnet-5-5", pythonProfile: "analysis", rProfile: "none" });
    assert.equal(again.apply.changed, false, "an identical repeat is a no-op");

    await assert.rejects(() => svc.apply({ provider: "openai-api" }), error => error.code === "WORKSPACE_ALREADY_INITIALIZED");

    // With no key in the environment the sidecar refuses before any request is made.
    const keyless = new ProviderSetupService({ run: (args, env) => runSidecar(args, env, workspace), environment: () => ({}), hasWorkspace: () => true });
    const verdict = await keyless.verify({ provider: "anthropic-api", approveNetwork: true });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "CREDENTIAL_MISSING");
    assert.equal(verdict.metrics.network_requests, 0);
    assert.equal(verdict.status?.provider, "anthropic-api");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function runSidecar(args, extraEnv, cwd) {
  if (!existsSync(python) && !process.env.PROTO_AGENT_PYTHON) return Promise.resolve({ skipped: `No Python at ${python}; set PROTO_AGENT_PYTHON.` });
  const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", PYTHONUTF8: "1", PYTHONPATH: join(repo, "src"), ...extraEnv };
  return new Promise(resolvePromise => {
    const child = spawn(python, ["-m", "proto_agent.workspace_init", ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", error => resolvePromise({ skipped: `Python could not start: ${error.message}` }));
    child.once("close", code => resolvePromise({ code, stdout, stderr }));
  });
}
