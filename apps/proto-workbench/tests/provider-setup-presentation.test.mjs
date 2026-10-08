import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createProviderSetupPreview } from "../src/renderer/provider-setup-preview.ts";
import {
  buildRequest,
  categorySentence,
  custodyLine,
  defaultProvider,
  detectionLabel,
  formFromStatus,
  gatewayAddressProblem,
  isDirty,
  nextActionText,
  providerName,
  rankLabel,
  validateForm,
  verificationSummary,
  verifyTarget,
} from "../src/renderer/provider-setup-presentation.ts";
import { PROVIDER_IDS, VALIDATION_CATEGORIES } from "../src/shared/provider-setup.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const METRICS = { elapsed_ms: 0, files_written: 0, network_requests: 0 };
const { catalog, detection } = await createProviderSetupPreview().overview();
const form = (change = {}) => ({ provider: "anthropic-api", model: "", baseUrl: "", protocol: "", credentialMode: "isolated", pythonProfile: "analysis", rProfile: "none", ...change });
const status = (configuration, extra = {}) => ({ ok: true, ready: false, initialized: true, directory: ".proto/workspace", next: [], issues: [], metrics: METRICS, configuration, ...extra });

test("an empty workspace starts on the preferred API provider, never the local fallback", () => {
  assert.equal(detection.recommended_provider, "local-lm-studio");
  assert.equal(defaultProvider(catalog, detection), "anthropic-api");
  assert.equal(defaultProvider(catalog, { ...detection, recommended_provider: "openai-api" }), "openai-api");
  assert.equal(defaultProvider(catalog, { ...detection, recommended_provider: "claude-subscription" }), "claude-subscription");
});

test("every provider has a name, a custody sentence and a rank label", () => {
  for (const entry of catalog.providers) {
    assert.ok(providerName(entry.id).length > 0);
    assert.ok(custodyLine(entry).length > 20, entry.id);
    assert.ok(rankLabel(entry).length > 0);
  }
  assert.equal(rankLabel(catalog.providers.find(entry => entry.id === "local-lm-studio")), "Fallback · local only");
  assert.deepEqual(PROVIDER_IDS.map(providerName).filter(name => !name), []);
  assert.match(custodyLine(catalog.providers.find(entry => entry.id === "anthropic-api")), /ANTHROPIC_API_KEY.*api\.anthropic\.com/);
});

test("detection wording reports presence only", () => {
  const entry = id => catalog.providers.find(candidate => candidate.id === id);
  const found = { ...detection, providers: { "anthropic-api": { kind: "api_key_env", security_rank: 1, credential_present: true }, "claude-subscription": { kind: "subscription_cli", security_rank: 2, cli_found: false } } };
  assert.equal(detectionLabel(entry("anthropic-api"), found), "ANTHROPIC_API_KEY found");
  assert.equal(detectionLabel(entry("claude-subscription"), found), "claude not found");
  assert.equal(detectionLabel(entry("openai-api"), found), undefined);
  assert.equal(detectionLabel(entry("local-lm-studio"), found), undefined);
});

test("gateway addresses follow the helper's rules before anything is sent", () => {
  const ok = ["https://gateway.example.com/v1", "https://gateway.example.com", "http://localhost:11434/v1", "http://127.0.0.1:8000", "http://[::1]:8000"];
  for (const value of ok) assert.equal(gatewayAddressProblem(value), undefined, value);
  const bad = {
    "http://gateway.example.com": /https/,
    "https://169.254.169.254/latest": /DNS name/,
    "https://203.0.113.9": /DNS name/,
    "https://user:pw@gateway.example.com": /credentials/,
    "https://gateway.example.com/v1?x=1": /query/,
    "https://gateway.example.com/#frag": /fragment/,
    "ftp://gateway.example.com": /https/,
    "not a url": /full address/,
  };
  for (const [value, pattern] of Object.entries(bad)) assert.match(gatewayAddressProblem(value) ?? "", pattern, value);
});

test("form validation names the first fixable problem", () => {
  assert.equal(validateForm(form(), catalog), undefined);
  assert.match(validateForm(form({ model: "has space" }), catalog), /model ID/i);
  const gateway = { provider: "custom-gateway" };
  assert.match(validateForm(form({ ...gateway, model: "" }), catalog), /model ID is required/i);
  assert.match(validateForm(form({ ...gateway, model: "m" }), catalog), /gateway address/i);
  assert.match(validateForm(form({ ...gateway, model: "m", baseUrl: "http://gw.example.com", protocol: "messages" }), catalog), /https/);
  assert.match(validateForm(form({ ...gateway, model: "m", baseUrl: "https://gw.example.com" }), catalog), /protocol/i);
  assert.equal(validateForm(form({ ...gateway, model: "m", baseUrl: "https://gw.example.com", protocol: "messages" }), catalog), undefined);
});

test("requests carry only the fields that apply to the chosen provider", () => {
  const stale = { model: " claude-sonnet-5-5 ", baseUrl: "https://old.example.com", protocol: "messages", credentialMode: "shared" };
  assert.deepEqual(buildRequest(form(stale), catalog, false), { provider: "anthropic-api", model: "claude-sonnet-5-5", pythonProfile: "analysis", rProfile: "none" });
  assert.deepEqual(buildRequest(form({ ...stale, provider: "custom-gateway", baseUrl: " https://gw.example.com/v1 " }), catalog, true),
    { provider: "custom-gateway", model: "claude-sonnet-5-5", baseUrl: "https://gw.example.com/v1", protocol: "messages", pythonProfile: "analysis", rProfile: "none", force: true });
  assert.deepEqual(buildRequest(form({ provider: "claude-subscription", credentialMode: "shared" }), catalog, false),
    { provider: "claude-subscription", credentialMode: "shared", pythonProfile: "analysis", rProfile: "none" });
  assert.ok(!JSON.stringify(buildRequest(form(stale), catalog, false)).includes("apiKey"));
});

test("verification wording is history, never a live connection claim", () => {
  const at = value => `at ${value}`;
  assert.deepEqual(verificationSummary(undefined, at), { label: "Not verified", tone: "neutral" });
  assert.deepEqual(verificationSummary({ state: "never" }, at), { label: "Not verified", tone: "neutral" });
  assert.deepEqual(verificationSummary({ state: "verified", verified_at: "2026-10-08T01:00:00Z" }, at), { label: "Verified at 2026-10-08T01:00:00Z", tone: "ok" });
  assert.deepEqual(verificationSummary({ state: "failed", category: "auth" }, at), { label: "Check failed · auth", tone: "fail" });
  assert.equal(verificationSummary({ state: "stale" }, at).tone, "warn");
  assert.equal(verificationSummary({ state: "unknown" }, at).tone, "warn");
  for (const state of ["never", "verified", "failed", "stale", "unknown"]) assert.doesNotMatch(verificationSummary({ state, verified_at: "x" }, at).label, /connected|online|live/i);
  for (const category of VALIDATION_CATEGORIES) assert.ok(categorySentence(category).length > 10, category);
});

test("the saved configuration round-trips into the form and clears the dirty flag", () => {
  const saved = status({ provider: { id: "custom-gateway", kind: "api_gateway", model: "team/m-1", base_url: "https://gw.example.com/v1", host: "gw.example.com", protocol: "responses", loopback: false, credential_environment: "PROTO_GATEWAY_API_KEY" }, python_profile: "sequence", r_profile: "rnaseq" });
  const loaded = formFromStatus(saved, "anthropic-api");
  assert.deepEqual(loaded, { provider: "custom-gateway", model: "team/m-1", baseUrl: "https://gw.example.com/v1", protocol: "responses", credentialMode: "isolated", pythonProfile: "sequence", rProfile: "rnaseq" });
  assert.equal(isDirty(loaded, saved), false);
  assert.equal(isDirty({ ...loaded, model: "other" }, saved), true);
  assert.equal(isDirty(form(), undefined), true);
  assert.equal(isDirty(form(), status(undefined, { initialized: false })), true);
});

test("verify targets come from saved configuration and pinned hosts, never typed text", () => {
  const anthropic = status({ provider: { id: "anthropic-api", kind: "api_key_env", credential_environment: "ANTHROPIC_API_KEY" }, python_profile: "analysis", r_profile: "none" });
  assert.deepEqual(verifyTarget(anthropic, catalog), { provider: "anthropic-api", host: "api.anthropic.com", variable: "ANTHROPIC_API_KEY", viaApp: true });
  const remote = status({ provider: { id: "custom-gateway", kind: "api_gateway", host: "gw.example.com", loopback: false, credential_environment: "PROTO_GATEWAY_API_KEY" }, python_profile: "core", r_profile: "none" });
  assert.deepEqual(verifyTarget(remote, catalog), { provider: "custom-gateway", host: "gw.example.com", variable: "PROTO_GATEWAY_API_KEY", approveHost: "gw.example.com", viaApp: true });
  const local = status({ provider: { id: "custom-gateway", kind: "api_gateway", host: "127.0.0.1", loopback: true }, python_profile: "core", r_profile: "none" });
  assert.equal(verifyTarget(local, catalog)?.approveHost, undefined);
  const custom = status({ provider: { id: "anthropic-api", kind: "api_key_env", credential_environment: "MY_TEAM_KEY" }, python_profile: "core", r_profile: "none" });
  assert.equal(verifyTarget(custom, catalog)?.viaApp, false, "a custom variable name is never handed to the helper");
  assert.equal(verifyTarget(status({ provider: { id: "claude-subscription", kind: "subscription_cli" }, python_profile: "core", r_profile: "none" }), catalog), undefined);
  assert.equal(verifyTarget(status(undefined, { initialized: false }), catalog), undefined);
  assert.equal(verifyTarget(undefined, catalog), undefined);
});

test("every next-action code the Python helper can emit has wording", () => {
  const source = readFileSync(join(repo, "src", "proto_agent", "workspace_init.py"), "utf8");
  const codes = new Set([...source.matchAll(/"code":\s*"([a-z][a-z_]+)"/g)].map(match => match[1]));
  assert.ok(codes.size >= 10, `expected to find the next-action codes, found ${[...codes].join(",")}`);
  for (const code of codes) {
    const text = nextActionText({ code, variable: "KEY_VAR", executable: "tool" });
    assert.notEqual(text, "Review the setup status.", `${code} has no dedicated wording`);
  }
  assert.match(nextActionText({ code: "set_environment", variable: "ANTHROPIC_API_KEY" }), /ANTHROPIC_API_KEY.*restart/);
  assert.equal(nextActionText({ code: "something_new" }), "Review the setup status.");
});

test("the preview never claims a write, a key, or a live check", async () => {
  const preview = createProviderSetupPreview();
  const result = await preview.apply({ provider: "anthropic-api", model: "claude-sonnet-5-5", pythonProfile: "core", rProfile: "none" });
  assert.deepEqual(result.apply.written, []);
  assert.match(result.apply.warnings.join(" "), /Preview mode: nothing was written/);
  assert.equal(result.status.credential_present, undefined);
  assert.equal(result.status.configuration.provider.model, "claude-sonnet-5-5");
  assert.equal(isDirty(formFromStatus(result.status, "anthropic-api"), result.status), false);
  await assert.rejects(() => preview.verify({ provider: "anthropic-api", approveNetwork: true }), /preview mode/i);
});
