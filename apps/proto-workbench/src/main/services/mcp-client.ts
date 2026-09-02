import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { minimalChildEnvironment, terminateOwnedProcessTree } from "./process-security.ts";

const MAX_PENDING_REQUESTS = 32;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDOUT_LINES = 10_000;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
const NETWORK_CAPABILITY_MAX_TTL_MS = 60_000;
const NETWORK_CAPABILITY_VERSION = "proto-workbench.network-capability.v1";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCapabilities {
  workspace: string;
  execution: {
    mode: "unsafe-host" | "oci" | "disabled";
    available: boolean;
    configured: boolean;
    provider_visible: boolean;
    smoke_verified: boolean;
    provider?: string;
    image?: string;
    image_digest_pinned: boolean;
    reason?: string;
  };
  networkPaths: string[];
  networkEnabled: boolean;
  networkAuthorization: "per-call-hmac-capability";
  filesystemSafety: {
    relativePathsOnly: boolean;
    reparsePointsAllowed: boolean;
    atomicReplace: boolean;
    windowsResidualSameUserRenameRace: boolean;
  };
}

export interface McpPaths {
  packaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  workspacePath: string;
  workspaceCapability: string;
  materialsRoot?: string;
  pythonExecutable?: string;
}

export interface McpCallAuthorization {
  runId: string;
  approvalId: string;
  expiresAt: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private nextId = 1;
  private readonly paths: McpPaths;
  private readonly pending = new Map<number, PendingRequest>();
  private toolsCache?: McpTool[];
  private capabilitiesCache?: McpCapabilities;
  private stdoutBuffer = "";
  private stdoutLines = 0;
  private stderrBuffer = "";
  private stopped = false;

  constructor(paths: McpPaths) {
    this.paths = paths;
  }

  async tools(refresh = false): Promise<McpTool[]> {
    if (!refresh && this.toolsCache) return this.toolsCache;
    await this.start();
    const response = (await this.request("tools/list", {}, undefined, CONTROL_REQUEST_TIMEOUT_MS)) as { tools?: McpTool[] };
    this.toolsCache = response.tools ?? [];
    return this.toolsCache;
  }

  async capabilities(refresh = false): Promise<McpCapabilities> {
    if (!refresh && this.capabilitiesCache) return this.capabilitiesCache;
    await this.start();
    const response = await this.request("proto/capabilities", {}, undefined, CONTROL_REQUEST_TIMEOUT_MS);
    this.capabilitiesCache = parseCapabilities(response);
    return this.capabilitiesCache;
  }

  async call(
    name: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: McpCallAuthorization,
  ): Promise<Record<string, unknown>> {
    await this.start();
    const capability = authorization
      ? this.createNetworkCapability(name, arguments_, authorization)
      : undefined;
    const result = (await this.request(
      "tools/call",
      { name, arguments: arguments_, ...(capability ? { capability } : {}) },
      signal,
      DEFAULT_REQUEST_TIMEOUT_MS,
    )) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    return result.structuredContent ?? { ok: !result.isError };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.toolsCache = undefined;
    this.capabilitiesCache = undefined;
    this.startPromise = undefined;
    await this.terminateCurrent(new Error("MCP sidecar stopped before the request completed."));
  }

  private async start(): Promise<void> {
    if (this.stopped) throw new Error("MCP sidecar has been shut down.");
    if (this.child && this.child.exitCode === null) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startChild().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startChild(): Promise<void> {
    const { command, args, env } = this.command();
    const child = spawn(command, args, {
      cwd: this.paths.workspacePath,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stdoutLines = 0;
    this.stderrBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-MAX_STDERR_BYTES);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      if (this.child === child) this.child = undefined;
      throw error;
    }
    child.on("error", (error) => this.rejectAll(error));
    child.once("exit", (code) => {
      if (this.child === child) this.child = undefined;
      this.toolsCache = undefined;
      this.capabilitiesCache = undefined;
      this.rejectAll(new Error(`proto-agent MCP exited with code ${code}. ${this.stderrBuffer.trim()}`.trim()));
    });
    try {
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "proto-workbench", version: "0.1.2" },
      }, undefined, CONTROL_REQUEST_TIMEOUT_MS);
    } catch (error) {
      await this.terminateCurrent(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private createNetworkCapability(
    tool: string,
    arguments_: Record<string, unknown>,
    authorization: McpCallAuthorization,
  ): Record<string, unknown> {
    if (!/^[a-f0-9]{64}$/i.test(this.paths.workspaceCapability)) {
      throw new Error("MCP workspace capability key is invalid.");
    }
    const now = Date.now();
    const approvalExpiry = Date.parse(authorization.expiresAt);
    if (!Number.isFinite(approvalExpiry) || approvalExpiry <= now) {
      throw new Error("Network approval expired before capability issuance.");
    }
    const unsigned = {
      version: NETWORK_CAPABILITY_VERSION,
      tool,
      argumentsSha256: createHash("sha256").update(stableJson(arguments_)).digest("hex"),
      runId: authorization.runId,
      approvalId: authorization.approvalId,
      issuedAtMs: now,
      expiresAtMs: Math.min(approvalExpiry, now + NETWORK_CAPABILITY_MAX_TTL_MS),
      nonce: randomBytes(16).toString("hex"),
    };
    const mac = createHmac("sha256", Buffer.from(this.paths.workspaceCapability, "hex"))
      .update(stableJson(unsigned))
      .digest("hex");
    return { ...unsigned, mac };
  }

  private command(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    const workspaceEnvironment = {
      PROTO_WORKBENCH_WORKSPACE_ROOT: this.paths.workspacePath,
      PROTO_WORKBENCH_WORKSPACE_CAPABILITY: this.paths.workspaceCapability,
      PROTO_WORKBENCH_ALLOWED_OUTPUT_ROOT: join(this.paths.workspacePath, "build"),
      ...(this.paths.materialsRoot ? { PROTO_AGENT_MATERIALS_ROOT: this.paths.materialsRoot } : {}),
    };
    if (this.paths.packaged) {
      return {
        command: join(
          this.paths.resourcesPath,
          "runtime",
          "proto-agent",
          "proto-agent-mcp",
          "proto-agent-mcp.exe",
        ),
        args: [],
        env: minimalChildEnvironment(workspaceEnvironment),
      };
    }
    const sourceRoot = join(this.paths.repoRoot, "src");
    return {
      command: this.paths.pythonExecutable || process.env.PROTO_AGENT_PYTHON || "python",
      args: ["-m", "proto_agent.mcp_server"],
      env: minimalChildEnvironment({
        ...workspaceEnvironment,
        PYTHONPATH: sourceRoot,
      }),
    };
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error("MCP sidecar is not running."));
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("MCP pending-request limit exceeded."));
    if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) {
      return Promise.reject(new Error("MCP request exceeds the 512 KiB payload limit."));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removePending(id);
        reject(new Error(`MCP request ${method} exceeded its ${timeoutMs} ms deadline.`));
        void this.terminateCurrent(new Error(`MCP request ${method} timed out.`));
      }, timeoutMs);
      timer.unref?.();
      const pending: PendingRequest = { resolve, reject, timer, signal };
      if (signal) {
        pending.abort = () => {
          this.removePending(id);
          reject(new DOMException("Cancelled", "AbortError"));
          this.writeCancellation(id);
          void this.terminateCurrent(new Error("MCP request was cancelled."));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      child.stdin.write(payload, (error) => {
        if (!error) return;
        this.removePending(id);
        reject(error);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_RESPONSE_LINE_BYTES) {
      void this.terminateCurrent(new Error("MCP response exceeded the 4 MiB line limit."));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (++this.stdoutLines > MAX_STDOUT_LINES) {
        void this.terminateCurrent(new Error("MCP stdout exceeded the per-session line limit."));
        return;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_LINE_BYTES) {
        void this.terminateCurrent(new Error("MCP response exceeded the 4 MiB line limit."));
        return;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (!Number.isSafeInteger(message.id)) return;
      const id = message.id as number;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.removePending(id);
      if (message.error) pending.reject(new Error(message.error.message || "MCP request failed."));
      else pending.resolve(message.result);
    } catch {
      // Non-protocol stdout is ignored, but it remains subject to the strict line-size limit.
    }
  }

  private writeCancellation(id: number): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const notification = `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id, reason: "Cancelled by the workbench." },
    })}\n`;
    child.stdin.write(notification, () => undefined);
  }

  private removePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    return pending;
  }

  private async terminateCurrent(error: Error): Promise<void> {
    const child = this.child;
    if (this.child === child) this.child = undefined;
    this.toolsCache = undefined;
    this.capabilitiesCache = undefined;
    this.rejectAll(error);
    if (child && child.exitCode === null) await terminateOwnedProcessTree(child);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.removePending(id);
      pending?.reject(error);
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function parseCapabilities(value: unknown): McpCapabilities {
  const root = objectValue(value, "MCP capabilities");
  const execution = objectValue(root.execution, "MCP execution capability");
  const filesystemSafety = objectValue(root.filesystemSafety, "MCP filesystem safety");
  const mode = stringValue(execution.mode, "execution.mode");
  if (mode !== "unsafe-host" && mode !== "oci" && mode !== "disabled") {
    throw new Error("MCP capability execution.mode is invalid.");
  }
  const networkAuthorization = stringValue(root.networkAuthorization, "networkAuthorization");
  if (networkAuthorization !== "per-call-hmac-capability") {
    throw new Error("MCP capability networkAuthorization is invalid.");
  }
  if (!Array.isArray(root.networkPaths) || !root.networkPaths.every((entry) => typeof entry === "string")) {
    throw new Error("MCP capability networkPaths is invalid.");
  }
  return {
    workspace: stringValue(root.workspace, "workspace"),
    execution: {
      mode,
      available: booleanValue(execution.available, "execution.available"),
      configured: booleanValue(execution.configured, "execution.configured"),
      provider_visible: booleanValue(execution.provider_visible, "execution.provider_visible"),
      smoke_verified: booleanValue(execution.smoke_verified, "execution.smoke_verified"),
      provider: optionalString(execution.provider, "execution.provider"),
      image: optionalString(execution.image, "execution.image"),
      image_digest_pinned: booleanValue(execution.image_digest_pinned, "execution.image_digest_pinned"),
      reason: optionalString(execution.reason, "execution.reason"),
    },
    networkPaths: [...root.networkPaths],
    networkEnabled: booleanValue(root.networkEnabled, "networkEnabled"),
    networkAuthorization,
    filesystemSafety: {
      relativePathsOnly: booleanValue(filesystemSafety.relativePathsOnly, "filesystemSafety.relativePathsOnly"),
      reparsePointsAllowed: booleanValue(filesystemSafety.reparsePointsAllowed, "filesystemSafety.reparsePointsAllowed"),
      atomicReplace: booleanValue(filesystemSafety.atomicReplace, "filesystemSafety.atomicReplace"),
      windowsResidualSameUserRenameRace: booleanValue(
        filesystemSafety.windowsResidualSameUserRenameRace,
        "filesystemSafety.windowsResidualSameUserRenameRace",
      ),
    },
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`MCP capability ${label} is invalid.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return stringValue(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`MCP capability ${label} is invalid.`);
  return value;
}
