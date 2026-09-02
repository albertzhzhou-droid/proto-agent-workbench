import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { McpClient } from "../src/main/services/mcp-client.ts";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

test("network capability is short-lived and bound to exact approved arguments", () => {
  const key = "42".repeat(32);
  const client = new McpClient({
    packaged: false,
    resourcesPath: "C:\\fixture",
    repoRoot: "C:\\fixture",
    workspacePath: "C:\\workspace",
    workspaceCapability: key,
    pythonExecutable: "unused",
  });
  const arguments_ = {
    query: "synthetic biology",
    offline: false,
    nested: { z: 2, a: "value" },
  };
  const before = Date.now();
  const capability = client.createNetworkCapability(
    "proto_pubmed_search",
    arguments_,
    {
      runId: "run-test",
      approvalId: "approval-test",
      expiresAt: new Date(before + 10 * 60_000).toISOString(),
    },
  );
  const { mac, ...unsigned } = capability;

  assert.equal(capability.version, "proto-workbench.network-capability.v1");
  assert.equal(capability.tool, "proto_pubmed_search");
  assert.equal(
    capability.argumentsSha256,
    createHash("sha256").update(stableJson(arguments_)).digest("hex"),
  );
  assert.ok(capability.issuedAtMs >= before);
  assert.ok(capability.expiresAtMs <= capability.issuedAtMs + 60_000);
  assert.match(capability.nonce, /^[a-f0-9]{32}$/);
  assert.equal(
    mac,
    createHmac("sha256", Buffer.from(key, "hex")).update(stableJson(unsigned)).digest("hex"),
  );
  assert.equal(JSON.stringify(capability).includes(key), false);
});

test("network capability refuses an expired approval", () => {
  const client = new McpClient({
    packaged: false,
    resourcesPath: "C:\\fixture",
    repoRoot: "C:\\fixture",
    workspacePath: "C:\\workspace",
    workspaceCapability: "24".repeat(32),
  });
  assert.throws(
    () => client.createNetworkCapability(
      "proto_pubmed_search",
      { query: "expired", offline: false },
      {
        runId: "run-test",
        approvalId: "approval-test",
        expiresAt: new Date(Date.now() - 1).toISOString(),
      },
    ),
    /expired/,
  );
});
