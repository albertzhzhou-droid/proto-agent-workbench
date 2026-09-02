import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OwnedProcessError,
  assertDisposableWorkspace,
  revalidateDisposableWorkspace,
  runJsonOwned,
  spawnOwned,
  terminateOwned,
} from "./owned-process.mjs";

const SIDECAR_CONFIRMATION = "YES_START_OWNED_SIDECARS";
const SIDECAR_CONFIRMATION_FLAG = `--confirm-owned-execution=${SIDECAR_CONFIRMATION}`;

if (isMainModule()) await runMain();

async function runMain() {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error instanceof OwnedProcessError ? error.code : "SIDECAR_VERIFICATION_FAILED",
      message: "Verification failed; sensitive details were suppressed.",
    }));
    process.exitCode = 1;
  }
}

export async function main() {
const invocationArgs = process.argv.slice(2);
if (
  process.env.PROTO_AGENT_ALLOW_SIDECAR_TESTS !== SIDECAR_CONFIRMATION ||
  invocationArgs.at(-1) !== SIDECAR_CONFIRMATION_FLAG ||
  invocationArgs.filter((value) => value === SIDECAR_CONFIRMATION_FLAG).length !== 1
) {
  console.error(JSON.stringify({
    ok: false,
    code: "SIDECAR_TEST_DISABLED",
    message: "Packaged-sidecar verification requires matching environment and final command-line confirmations.",
    requiredEnvironment: `PROTO_AGENT_ALLOW_SIDECAR_TESTS=${SIDECAR_CONFIRMATION}`,
    requiredArgument: SIDECAR_CONFIRMATION_FLAG,
  }));
  process.exit(2);
}
const args = invocationArgs.slice(0, -1);

if (!args[0]) {
  console.error(JSON.stringify({
    ok: false,
    code: "EXPLICIT_ROOTS_REQUIRED",
    message: "Pass an explicit disposable workspace root; implicit profile access and source-repository writes are forbidden.",
    usage: `verify-sidecars.mjs <disposable-workspace-root> [runtime-root] ${SIDECAR_CONFIRMATION_FLAG}`,
  }));
  process.exit(2);
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..", "..");
const workspaceRoot = await assertDisposableWorkspace(args[0], [appRoot, repoRoot]);
const runtimeRoot = args[1] ? requireAbsoluteArgument(args[1], "runtime root") : appRoot;
await createWorkspaceDirectory(workspaceRoot, ["build"]);
await revalidateDisposableWorkspace(workspaceRoot);

const adminCliPath = join(
  runtimeRoot,
  "runtime",
  "proto-agent",
  "proto-agent",
  "proto-agent.exe",
);
const mcpPath = join(
  runtimeRoot,
  "runtime",
  "proto-agent",
  "proto-agent-mcp",
  "proto-agent-mcp.exe",
);
const sidecarsBefore = await captureSidecarTree(runtimeRoot, adminCliPath, mcpPath);

const adminCapabilities = await runJsonOwned(
  adminCliPath,
  ["capabilities", "--json"],
  {
    cwd: workspaceRoot,
    timeoutMs: 30_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 128 * 1024,
  },
);
if (
  !adminCapabilities.ok ||
  !Array.isArray(adminCapabilities.mcp_tools) ||
  !adminCapabilities.mcp_tools.includes("proto_materials_search") ||
  !adminCapabilities.mcp_tools.includes("proto_skills_list") ||
  !adminCapabilities.mcp_tools.includes("proto_skills_resolve")
) {
  throw new Error("Packaged admin CLI did not expose the governed materials capability set.");
}
const adminSkillAudit = await runJsonOwned(
  adminCliPath,
  ["skills", "audit"],
  {
    cwd: workspaceRoot,
    timeoutMs: 30_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 128 * 1024,
  },
);
assertSkillAudit(adminSkillAudit);

const mcp = await createMcpClient(mcpPath, workspaceRoot);
let verificationResult;
try {
  await mcp.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "proto-workbench-verifier", version: "0.1.2" },
  });
  await mcp.notify("notifications/initialized", {});
  const toolsResult = await mcp.request("tools/list", {});
  const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
  const requiredTools = [
    "proto_check",
    "proto_europe_pmc_search",
    "proto_crossref_search",
    "proto_uniprot_search",
    "proto_rhea_search",
    "proto_skills_list",
    "proto_skills_resolve",
  ];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const missingTools = requiredTools.filter((tool) => !toolNames.has(tool));
  if (missingTools.length) {
    throw new Error(`Packaged MCP sidecar is missing required tools: ${missingTools.join(", ")}`);
  }
  const skillListResult = await mcp.request("tools/call", {
    name: "proto_skills_list",
    arguments: {},
  });
  const skillCatalog = skillListResult?.structuredContent;
  if (
    !skillCatalog?.ok ||
    skillCatalog.adapter_count !== 7 ||
    skillCatalog.status_counts?.available !== 7 ||
    skillCatalog.status_counts?.partial !== 0 ||
    skillCatalog.status_counts?.unavailable !== 0 ||
    skillCatalog.catalog_sha256 !== adminSkillAudit.catalog_sha256 ||
    skillCatalog.connector_registry_sha256 !== adminSkillAudit.connector_registry_sha256
  ) {
    throw new Error("Packaged MCP Skill catalogue does not match the admin CLI's verified 7/7 catalogue.");
  }
  const skillResolveResult = await mcp.request("tools/call", {
    name: "proto_skills_resolve",
    arguments: { skill_id: "proto-science-workflow" },
  });
  const skillResolution = skillResolveResult?.structuredContent;
  if (
    !skillResolution?.ok ||
    skillResolution.catalog_sha256 !== adminSkillAudit.catalog_sha256 ||
    skillResolution.connector_registry_sha256 !== adminSkillAudit.connector_registry_sha256 ||
    skillResolution.adapter?.id !== "proto-science-workflow" ||
    skillResolution.adapter?.status !== "available"
  ) {
    throw new Error("Packaged MCP Skill resolution was not bound to the audited catalogue and connector hashes.");
  }
  const multiSourceFixtures = [
    ["proto_europe_pmc_search", "tests/fixtures/europe_pmc_search.json", "PMID:34181032"],
    ["proto_crossref_search", "tests/fixtures/crossref_search.json", "DOI:10.1000/example-crossref"],
    ["proto_uniprot_search", "tests/fixtures/uniprot_search.json", "UniProt:P00001"],
    ["proto_rhea_search", "tests/fixtures/rhea_search.tsv", "RHEA:12345"],
  ];
  const verifiedSources = [];
  for (const [name, fixture, expectedId] of multiSourceFixtures) {
    const result = await mcp.request("tools/call", {
      name,
      arguments: { query: "levodopa", limit: 1, offline: true, fixture },
    });
    const payload = result?.structuredContent;
    if (!payload?.ok || payload.matches?.[0]?.source_id !== expectedId) {
      throw new Error(`Packaged MCP ${name} did not normalize ${expectedId}.`);
    }
    verifiedSources.push(expectedId);
  }
  const checkResult = await mcp.request("tools/call", {
    name: "proto_check",
    arguments: { path: "designs/toggle_switch.proto" },
  });
  if (!checkResult?.structuredContent?.ok) {
    throw new Error("Packaged MCP proto_check did not succeed on the fixture design.");
  }
  const workflowResult = await mcp.request("tools/call", {
    name: "proto_workflow_run",
    arguments: {
      path: "designs/toggle_switch.proto",
      out_dir: "build/runs/sidecar-verification",
    },
  });
  const workflow = workflowResult?.structuredContent;
  if (!workflow?.ok || !workflow.manifest_path) {
    throw new Error("Packaged MCP proto_workflow_run did not produce a successful manifest.");
  }
  await assertBuildArtifact(workspaceRoot, workflow.manifest_path);

  const reviewResult = await mcp.request("tools/call", {
    name: "proto_review_packet",
    arguments: {
      path: "designs/toggle_switch.proto",
      manifest_path: workflow.manifest_path,
      out_dir: "build/reviews/sidecar-verification",
      literature_query: "synthetic biology design automation",
    },
  });
  const review = reviewResult?.structuredContent;
  if (!review?.ok || review.review_status !== "human_review_required" || !review.packet_path) {
    throw new Error("Packaged MCP proto_review_packet did not produce a human-review packet.");
  }
  await assertBuildArtifact(workspaceRoot, review.packet_path);

  verificationResult = {
    ok: true,
    adminCli: true,
    toolCount: tools.length,
    skillAudit: {
      available: adminSkillAudit.status_counts.available,
      checked: adminSkillAudit.passes.local_schema_and_integrity.checked,
      passCount: adminSkillAudit.pass_count,
      catalogSha256: adminSkillAudit.catalog_sha256,
      connectorRegistrySha256: adminSkillAudit.connector_registry_sha256,
    },
    skillTools: ["proto_skills_list", "proto_skills_resolve"],
    verifiedSources,
    protoCheck: true,
    workflowManifest: true,
    reviewPacket: true,
  };
} finally {
  await mcp.close();
}
const sidecarsAfter = await captureSidecarTree(runtimeRoot, adminCliPath, mcpPath);
if (
  sidecarsAfter.catalogSha256 !== sidecarsBefore.catalogSha256 ||
  sidecarsAfter.adminExeSha256 !== sidecarsBefore.adminExeSha256 ||
  sidecarsAfter.mcpExeSha256 !== sidecarsBefore.mcpExeSha256 ||
  sidecarsAfter.fileCount !== sidecarsBefore.fileCount ||
  sidecarsAfter.totalBytes !== sidecarsBefore.totalBytes
) {
  throw new Error("Packaged sidecar bytes changed during verification.");
}
console.log(JSON.stringify({
  ...verificationResult,
  hashesVerified: true,
  sidecars: sidecarsAfter,
}));
}

function assertSkillAudit(audit) {
  const passNames = ["local_schema_and_integrity", "vendor_neutrality", "capability_and_risk"];
  if (
    !audit?.ok ||
    audit.schema_version !== "proto-agent.skill-audit.v1" ||
    audit.pass_count !== 3 ||
    audit.status_counts?.available !== 7 ||
    audit.status_counts?.partial !== 0 ||
    audit.status_counts?.unavailable !== 0 ||
    !Array.isArray(audit.findings) ||
    audit.findings.length !== 0 ||
    !/^[a-f0-9]{64}$/.test(audit.catalog_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(audit.connector_registry_sha256 ?? "") ||
    passNames.some((name) => audit.passes?.[name]?.ok !== true || audit.passes?.[name]?.checked !== 7)
  ) {
    throw new Error("Packaged admin CLI did not pass the exact 7/7 three-pass Skill audit.");
  }
}

async function captureSidecarTree(runtimeRoot, adminCliPath, mcpPath) {
  const root = join(runtimeRoot, "runtime", "proto-agent");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(root, await realpath(root))) {
    throw new Error("Packaged sidecar root must be a real directory.");
  }
  const topLevel = await readdir(root, { withFileTypes: true });
  const actualNames = topLevel.map((entry) => entry.name).sort();
  const expectedNames = ["README.md", "proto-agent", "proto-agent-mcp"].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Packaged sidecar root must contain exactly two sidecars and README.md.");
  }

  const files = [];
  let totalBytes = 0;
  async function visit(directory) {
    if (!samePath(directory, await realpath(directory))) {
      throw new Error("Packaged sidecar tree contains a linked directory.");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new Error("Packaged sidecar tree contains a symbolic link.");
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !info.isFile() || info.nlink !== 1) {
        throw new Error("Packaged sidecar tree contains a non-regular or multiply-linked file.");
      }
      const contained = relative(root, await realpath(absolute));
      if (contained === "" || contained.startsWith("..") || isAbsolute(contained)) {
        throw new Error("Packaged sidecar file escaped its runtime root.");
      }
      totalBytes += info.size;
      if (totalBytes > 2 * 1024 * 1024 * 1024) {
        throw new Error("Packaged sidecar tree exceeded the 2 GiB verification limit.");
      }
      files.push({
        path: relative(root, absolute).replaceAll("\\", "/"),
        sizeBytes: info.size,
        sha256: await sha256File(absolute),
      });
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));

  const digest = createHash("sha256");
  digest.update("proto-workbench.sidecars.v1\0");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.sizeBytes));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\n");
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const adminRelative = relative(root, adminCliPath).replaceAll("\\", "/");
  const mcpRelative = relative(root, mcpPath).replaceAll("\\", "/");
  if (!byPath.has(adminRelative) || !byPath.has(mcpRelative)) {
    throw new Error("Packaged sidecar executables were not included in the verified tree.");
  }
  return {
    fileCount: files.length,
    totalBytes,
    catalogSha256: digest.digest("hex"),
    adminExeSha256: byPath.get(adminRelative).sha256,
    mcpExeSha256: byPath.get(mcpRelative).sha256,
  };
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(digest.digest("hex")));
  });
}

async function assertBuildArtifact(workspaceRoot, path) {
  await revalidateDisposableWorkspace(workspaceRoot);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
  const buildRoot = resolve(workspaceRoot, "build");
  const lexical = relative(buildRoot, absolute);
  if (lexical === "" || lexical === ".." || lexical.startsWith(`..${pathSeparator()}`) || isAbsolute(lexical)) {
    throw new Error("Sidecar artifact escaped build/.");
  }
  const canonicalBuild = await realpath(buildRoot);
  if (!samePath(buildRoot, canonicalBuild)) {
    throw new Error("Disposable build root must not be a symlink or junction.");
  }
  await assertDirectoryChain(canonicalBuild, dirname(absolute));
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) {
    throw new Error("Sidecar artifact is not a bounded regular single-link file.");
  }
  const canonicalArtifact = await realpath(absolute);
  const contained = relative(canonicalBuild, canonicalArtifact);
  if (contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error("Sidecar artifact escaped build/.");
  }
  await revalidateDisposableWorkspace(workspaceRoot);
}

export async function createMcpClient(command, cwd, options = {}) {
  const child = await spawnOwned(command, options.args ?? [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const writeWaiters = new Set();
  let nextId = 1;
  let closed = false;
  let closing;
  let stdoutBuffer = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let queuedStdinBytes = 0;
  const requestTimeoutMs = boundedOption(options.requestTimeoutMs, 30_000, 100, 120_000);
  const writeTimeoutMs = boundedOption(options.writeTimeoutMs, 5_000, 100, 30_000);
  const maxFrameBytes = boundedOption(options.maxFrameBytes, 1024 * 1024, 64, 4 * 1024 * 1024);
  const maxStdoutBytes = boundedOption(options.maxStdoutBytes, 16 * 1024 * 1024, maxFrameBytes, 32 * 1024 * 1024);
  const maxStderrBytes = boundedOption(options.maxStderrBytes, 128 * 1024, 1, 1024 * 1024);
  const maxQueuedStdinBytes = boundedOption(options.maxQueuedStdinBytes, 256 * 1024, 64, 2 * 1024 * 1024);
  child.stdout.on("data", (chunk) => {
    if (closed) return;
    const bytes = Buffer.from(chunk);
    stdoutBytes += bytes.byteLength;
    if (stdoutBytes > maxStdoutBytes) {
      void shutdown(new OwnedProcessError("MCP_OUTPUT_LIMIT", "MCP output exceeded its byte limit."));
      return;
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, bytes]);
    while (true) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const frame = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (frame.byteLength > maxFrameBytes) {
        void shutdown(new OwnedProcessError("MCP_FRAME_LIMIT", "MCP frame exceeded its byte limit."));
        return;
      }
      if (frame.byteLength === 0) continue;
      handleFrame(frame);
    }
    if (stdoutBuffer.byteLength > maxFrameBytes) {
      void shutdown(new OwnedProcessError("MCP_FRAME_LIMIT", "MCP frame exceeded its byte limit."));
    }
  });
  child.stderr.on("data", (chunk) => {
    if (closed) return;
    const bytes = Buffer.from(chunk);
    stderrBytes += bytes.byteLength;
    if (stderrBytes > maxStderrBytes) {
      void shutdown(new OwnedProcessError("MCP_STDERR_LIMIT", "MCP stderr exceeded its byte limit."));
      return;
    }
  });
  child.once("error", () => void shutdown(new OwnedProcessError("MCP_PROCESS_ERROR", "MCP sidecar process failed.")));
  child.once("close", (code, signal) => {
    void shutdown(new OwnedProcessError(
      "MCP_EXITED",
      "MCP sidecar exited; captured stderr was suppressed.",
      { code, signal, stderrBytes },
    ));
  });

  function handleFrame(frame) {
    let message;
    try {
      message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
    } catch {
      void shutdown(new OwnedProcessError("INVALID_MCP_FRAME", "MCP frame is not valid UTF-8 JSON."));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      void shutdown(new OwnedProcessError("INVALID_MCP_FRAME", "MCP frame has an invalid envelope."));
      return;
    }
    if (message.id !== undefined && (!Number.isSafeInteger(message.id) || message.id <= 0)) {
      void shutdown(new OwnedProcessError("INVALID_MCP_FRAME", "MCP response id is invalid."));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    if (("result" in message) === ("error" in message)) {
      void shutdown(new OwnedProcessError("INVALID_MCP_FRAME", "MCP response must contain one result or error."));
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if ("error" in message) {
      request.reject(new OwnedProcessError("MCP_REMOTE_ERROR", "MCP sidecar returned an error; remote text was suppressed."));
    }
    else request.resolve(message.result);
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  function shutdown(error) {
    if (closing) return closing;
    closed = true;
    rejectPending(error);
    for (const rejectWrite of [...writeWaiters]) rejectWrite(error);
    child.stdin.destroy();
    closing = terminateOwned(child).catch(() => undefined);
    return closing;
  }

  function send(message) {
    if (closed || !child.stdin.writable) {
      return Promise.reject(new Error("MCP sidecar is closed."));
    }
    let encoded;
    try {
      encoded = `${JSON.stringify(message)}\n`;
    } catch {
      return Promise.reject(new OwnedProcessError("INVALID_MCP_REQUEST", "MCP request is not JSON serializable."));
    }
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    if (encodedBytes > 64 * 1024) {
      return Promise.reject(new OwnedProcessError("MCP_REQUEST_LIMIT", "MCP request exceeded 64 KiB."));
    }
    if (queuedStdinBytes + encodedBytes > maxQueuedStdinBytes) {
      const error = new OwnedProcessError("MCP_STDIN_LIMIT", "MCP queued stdin exceeded its byte limit.");
      void shutdown(error);
      return Promise.reject(error);
    }
    queuedStdinBytes += encodedBytes;
    return new Promise((resolvePromise, rejectPromise) => {
      let finished = false;
      let timer;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        writeWaiters.delete(finish);
        queuedStdinBytes -= encodedBytes;
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      writeWaiters.add(finish);
      timer = setTimeout(() => {
        const error = new OwnedProcessError("MCP_STDIN_TIMEOUT", "MCP stdin write exceeded its deadline.");
        finish(error);
        void shutdown(error);
      }, writeTimeoutMs);
      try {
        child.stdin.write(encoded, "utf8", (error) => {
          if (error) {
            const safeError = new OwnedProcessError("MCP_STDIN_FAILED", "MCP stdin write failed.");
            finish(safeError);
            void shutdown(safeError);
          } else {
            finish();
          }
        });
      } catch {
        const error = new OwnedProcessError("MCP_STDIN_FAILED", "MCP stdin write failed.");
        finish(error);
        void shutdown(error);
      }
    });
  }

  return {
    request(method, params) {
      const validationError = validateMcpCall(method, params);
      if (validationError) return Promise.reject(validationError);
      if (closed || pending.size >= 4) {
        return Promise.reject(new OwnedProcessError("MCP_PENDING_LIMIT", "MCP client is closed or at its pending-request limit."));
      }
      if (!Number.isSafeInteger(nextId) || nextId <= 0) {
        const error = new OwnedProcessError("MCP_ID_LIMIT", "MCP request id budget was exhausted.");
        void shutdown(error);
        return Promise.reject(error);
      }
      const id = nextId++;
      return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          const error = new OwnedProcessError("MCP_REQUEST_TIMEOUT", "MCP request exceeded its deadline.");
          rejectPromise(error);
          void shutdown(error);
        }, requestTimeoutMs);
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
        void send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          clearTimeout(request.timeout);
          request.reject(error);
          void shutdown(error);
        });
      });
    },
    notify(method, params) {
      const validationError = validateMcpCall(method, params);
      if (validationError) return Promise.reject(validationError);
      return send({ jsonrpc: "2.0", method, params });
    },
    async close() {
      await shutdown(new Error("MCP client closed."));
    },
  };
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function isMainModule() {
  return Boolean(process.argv[1]) && samePath(fileURLToPath(import.meta.url), process.argv[1]);
}

function requireAbsoluteArgument(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new OwnedProcessError("INVALID_PATH", `${label} must be an absolute path.`);
  }
  return resolve(value);
}

async function createWorkspaceDirectory(workspace, segments) {
  let current = workspace;
  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(segment)) {
      throw new Error("Unsafe disposable workspace directory segment.");
    }
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(current, await realpath(current))) {
      throw new Error("Disposable workspace directory traverses a link or junction.");
    }
  }
  await revalidateDisposableWorkspace(workspace);
  return current;
}

async function assertDirectoryChain(root, target) {
  const delta = relative(root, target);
  if (delta === "") return;
  if (delta === ".." || delta.startsWith(`..${pathSeparator()}`) || isAbsolute(delta)) {
    throw new Error("Artifact parent escaped build/.");
  }
  let current = root;
  for (const segment of delta.split(pathSeparator())) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(current, await realpath(current))) {
      throw new Error("Artifact parent traverses a link or junction.");
    }
  }
}

function pathSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}

function validateMcpCall(method, params) {
  if (typeof method !== "string" || !/^[a-z][a-z0-9_/-]{0,63}$/.test(method)) {
    return new OwnedProcessError("INVALID_MCP_METHOD", "MCP method is invalid.");
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return new OwnedProcessError("INVALID_MCP_PARAMS", "MCP params must be an object.");
  }
  return undefined;
}

function boundedOption(value, fallback, minimum, maximum) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new OwnedProcessError("INVALID_LIMIT", `MCP limit must be an integer from ${minimum} to ${maximum}.`);
  }
  return selected;
}
