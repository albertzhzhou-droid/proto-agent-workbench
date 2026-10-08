import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CredentialVault, CredentialVaultError } from "../src/main/services/credential-vault.ts";
import { API_KEY_SHAPE, GatewayEndpointError, PROVIDER_PINNED_HOST, parseGatewayEndpoint } from "../src/shared/provider-setup.ts";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "..", "..");
const python = process.env.PROTO_AGENT_PYTHON || join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const KEY = `sk-ant-api03-${"A1b2C3d4".repeat(6)}`;
const OTHER = `sk-proj-${"Z9y8X7w6".repeat(5)}`;

/** A reversible stand-in for the OS facility; the real one is exercised on the desktop. */
function fakeSafeStorage({ available = true, backend } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: text => Buffer.from(`enc:${[...text].reverse().join("")}`, "utf8"),
    decryptString: buffer => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
      return [...text.slice(4)].reverse().join("");
    },
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
  };
}
async function withVault(options, body) {
  const directory = await mkdtemp(join(tmpdir(), "proto-vault-"));
  const filePath = join(directory, "nested", "provider-credentials.json");
  try {
    const vault = new CredentialVault({ filePath, safeStorage: fakeSafeStorage(options), now: () => new Date("2026-10-09T12:00:00Z") });
    await body(vault, filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const rejectsWith = (promise, code) => assert.rejects(promise, error => error instanceof CredentialVaultError && error.code === code, code);

test("a stored key is encrypted at rest and the file never holds it in the clear", async () => {
  await withVault({}, async (vault, filePath) => {
    const summary = await vault.store({ provider: "anthropic-api", key: KEY });
    assert.deepEqual(summary, { provider: "anthropic-api", host: "api.anthropic.com", storedAt: "2026-10-09T12:00:00.000Z" });
    const raw = await readFile(filePath, "utf8");
    assert.ok(!raw.includes(KEY), "the key must not appear in the file");
    for (const fragment of [KEY.slice(0, 12), KEY.slice(-12)]) assert.ok(!raw.includes(fragment));
    assert.ok(raw.includes("enc:") === false, "the stored value is base64 of the ciphertext");
    if (process.platform !== "win32") assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await vault.read("anthropic-api")).key, KEY);
  });
});

test("listing and status expose where a key is bound, never the key", async () => {
  await withVault({}, async vault => {
    await vault.store({ provider: "anthropic-api", key: KEY });
    await vault.store({ provider: "custom-gateway", key: OTHER, baseUrl: "https://Gateway.Example.com/v1/", protocol: "chat-completions" });
    const status = await vault.status();
    assert.equal(status.available, true);
    assert.deepEqual(status.stored.map(entry => entry.provider).sort(), ["anthropic-api", "custom-gateway"]);
    const gateway = status.stored.find(entry => entry.provider === "custom-gateway");
    assert.deepEqual({ host: gateway.host, baseUrl: gateway.baseUrl, protocol: gateway.protocol }, { host: "gateway.example.com", baseUrl: "https://gateway.example.com/v1", protocol: "chat-completions" });
    const serialized = JSON.stringify(status);
    for (const secret of [KEY, OTHER, KEY.slice(0, 10), OTHER.slice(-10)]) assert.ok(!serialized.includes(secret));
  });
});

test("official providers are bound to hosts pinned in code, and gateways to the typed address", async () => {
  await withVault({}, async vault => {
    assert.equal((await vault.store({ provider: "openai-api", key: OTHER })).host, PROVIDER_PINNED_HOST["openai-api"]);
    await rejectsWith(vault.store({ provider: "anthropic-api", key: KEY, baseUrl: "https://evil.example.com" }), "GATEWAY_OPTION_NOT_APPLICABLE");
    await rejectsWith(vault.store({ provider: "custom-gateway", key: KEY }), "GATEWAY_BASE_URL_REQUIRED");
    await rejectsWith(vault.store({ provider: "custom-gateway", key: KEY, baseUrl: "https://gw.example.com" }), "GATEWAY_PROTOCOL_REQUIRED");
    await rejectsWith(vault.store({ provider: "custom-gateway", key: KEY, baseUrl: "http://gw.example.com", protocol: "messages" }), "GATEWAY_REQUIRES_HTTPS");
    await rejectsWith(vault.store({ provider: "custom-gateway", key: KEY, baseUrl: "https://169.254.169.254/latest", protocol: "messages" }), "GATEWAY_IP_LITERAL");
    const local = await vault.store({ provider: "custom-gateway", key: KEY, baseUrl: "http://127.0.0.1:11434/v1", protocol: "chat-completions" });
    assert.equal(local.host, "127.0.0.1");
  });
});

test("malformed keys are refused without echoing them", async () => {
  await withVault({}, async (vault, filePath) => {
    for (const bad of ["short", `${KEY} extra`, `${KEY}\n`, "x".repeat(600), "tab\there-and-more-chars"]) {
      await assert.rejects(vault.store({ provider: "anthropic-api", key: bad }), error => {
        assert.equal(error.code, "INVALID_KEY");
        assert.ok(!String(error.message).includes(bad.trim()) || bad.trim().length < 6);
        return true;
      });
    }
    assert.equal(existsSync(filePath), false, "a refused key writes nothing");
  });
});

test("an unavailable or unencrypted backend refuses to store anything", async () => {
  for (const options of [{ available: false }, { available: true, backend: "basic_text" }, { available: true, backend: "unknown" }]) {
    await withVault(options, async (vault, filePath) => {
      assert.equal(vault.availability().available, false);
      assert.match(vault.availability().reason, /\S/);
      await rejectsWith(vault.store({ provider: "anthropic-api", key: KEY }), "VAULT_UNAVAILABLE");
      assert.equal(existsSync(filePath), false);
      assert.equal((await vault.status()).available, false);
    });
  }
  await withVault({ available: true, backend: "gnome_libsecret" }, async vault => {
    assert.equal(vault.availability().available, true);
  });
});

test("reading fails closed when the ciphertext is damaged or the account cannot decrypt it", async () => {
  await withVault({}, async (vault, filePath) => {
    await vault.store({ provider: "anthropic-api", key: KEY });
    const file = JSON.parse(await readFile(filePath, "utf8"));
    file.entries["anthropic-api"].ciphertext = Buffer.from("not-ours").toString("base64");
    await writeFile(filePath, JSON.stringify(file));
    await rejectsWith(vault.read("anthropic-api"), "UNREADABLE");
    assert.equal((await vault.list()).length, 1, "listing still works without decrypting");
    // Decrypts to something that is not a key: also unreadable, never returned.
    file.entries["anthropic-api"].ciphertext = Buffer.from("enc:short").toString("base64");
    await writeFile(filePath, JSON.stringify(file));
    await rejectsWith(vault.read("anthropic-api"), "UNREADABLE");
  });
});

test("a damaged or tampered credential file is refused rather than trusted", async () => {
  await withVault({}, async (vault, filePath) => {
    await vault.store({ provider: "anthropic-api", key: KEY });
    await writeFile(filePath, "{ not json");
    await rejectsWith(vault.list(), "VAULT_DAMAGED");
    await writeFile(filePath, JSON.stringify({ format: 1, entries: { "anthropic-api": { ciphertext: "AAAA", host: "api.anthropic.com", storedAt: "t", extra: true } } }));
    await rejectsWith(vault.list(), "VAULT_DAMAGED");
    await writeFile(filePath, JSON.stringify({ format: 2, entries: {} }));
    await rejectsWith(vault.list(), "VAULT_DAMAGED");
    await writeFile(filePath, "x".repeat(300 * 1024));
    await rejectsWith(vault.list(), "VAULT_DAMAGED");
    await rejectsWith(vault.store({ provider: "openai-api", key: OTHER }), "VAULT_DAMAGED");
  });
});

test("remove deletes one entry and reports whether anything was there", async () => {
  await withVault({}, async vault => {
    await vault.store({ provider: "anthropic-api", key: KEY });
    await vault.store({ provider: "openai-api", key: OTHER });
    assert.equal(await vault.remove("anthropic-api"), true);
    assert.equal(await vault.remove("anthropic-api"), false);
    assert.equal(await vault.read("anthropic-api"), undefined);
    assert.equal((await vault.read("openai-api")).key, OTHER);
  });
});

test("concurrent stores are serialized and none is lost", async () => {
  await withVault({}, async vault => {
    await Promise.all([
      vault.store({ provider: "anthropic-api", key: KEY }),
      vault.store({ provider: "openai-api", key: OTHER }),
      vault.store({ provider: "custom-gateway", key: KEY, baseUrl: "https://gw.example.com", protocol: "messages" }),
    ]);
    assert.deepEqual((await vault.list()).map(entry => entry.provider).sort(), ["anthropic-api", "custom-gateway", "openai-api"]);
  });
});

test("API key shape accepts real-looking keys and rejects anything that could inject a header", () => {
  for (const good of [KEY, OTHER, "a".repeat(16), "Bearer-less_token.value-1234"]) assert.ok(API_KEY_SHAPE.test(good), good);
  for (const bad of ["", "short", "has space inside the key", "line\nbreak-in-the-key", "nul\u0000byte-in-the-key", "ünïcode-in-the-key-value", "a".repeat(513)]) assert.ok(!API_KEY_SHAPE.test(bad), JSON.stringify(bad));
});

const PARITY_CASES = [
  "https://gateway.example.com/v1", "https://Gateway.Example.com/v1/", "https://gateway.example.com", "https://gateway.example.com:8443/x",
  "https://gateway.example.com:443/v1", "http://localhost:11434/v1", "http://127.0.0.1:8000", "http://127.8.8.8/v1", "http://[::1]:8000", "http://foo.localhost",
  "http://gateway.example.com", "https://203.0.113.9/v1", "https://169.254.169.254/latest", "https://[2001:db8::1]/v1",
  "https://user:pw@gateway.example.com", "https://gateway.example.com/v1?x=1", "https://gateway.example.com/#frag", "https://gateway.example.com/../etc",
  "https://gateway.example.com/a b", "ftp://gateway.example.com", "not a url", "https://", "https://bad_host.example.com", "https://gateway.example.com//v1", "",
  "https://gateway.example.com/./v1", "https://gateway.example.com/%2e%2e/etc", "https://gateway.example.com/v1/../v2", "https://gateway.example.com/v1/.", "https://gateway.example.com/a/b/c",
  "https://gateway.example.com\\@evil.example.com", "https://evil.example.com#@gateway.example.com", "https://gateway.example.com:99999", "https://gateway.example.com:0",
];

test("the gateway rules in TypeScript and Python accept and refuse the same addresses", t => {
  if (!existsSync(python) && !process.env.PROTO_AGENT_PYTHON) return t.skip(`No Python at ${python}; set PROTO_AGENT_PYTHON.`);
  const script = [
    "import json, sys",
    "from proto_agent.workspace_init import InitError, gateway_origin, parse_gateway_url",
    "out = []",
    "for value in json.loads(sys.argv[1]):",
    "    try:",
    "        e = parse_gateway_url(value)",
    "        out.append({'ok': True, 'host': e['host'], 'loopback': e['loopback'], 'origin': gateway_origin(value)})",
    "    except InitError as error:",
    "        out.append({'ok': False, 'code': error.code})",
    "print(json.dumps(out))",
  ].join("\n");
  const run = spawnSync(python, ["-c", script, JSON.stringify(PARITY_CASES)], { env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", PYTHONUTF8: "1", PYTHONPATH: join(repo, "src") }, encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  PARITY_CASES.forEach((value, index) => {
    let actual;
    try {
      const endpoint = parseGatewayEndpoint(value);
      actual = { ok: true, host: endpoint.host, loopback: endpoint.loopback, origin: endpoint.origin };
    } catch (error) {
      assert.ok(error instanceof GatewayEndpointError, `${JSON.stringify(value)} threw ${error}`);
      actual = { ok: false };
    }
    const wanted = expected[index];
    assert.equal(actual.ok, wanted.ok, `${JSON.stringify(value)}: TypeScript ${actual.ok ? "accepts" : "refuses"}, Python ${wanted.ok ? "accepts" : "refuses"}`);
    if (wanted.ok) {
      assert.equal(actual.host, wanted.host, value);
      assert.equal(actual.loopback, wanted.loopback, value);
      assert.equal(actual.origin, wanted.origin, `${value} origin`);
    }
  });
});
