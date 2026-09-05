import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { minimalChildEnvironment, terminateOwnedProcessTree } from "./process-security.ts";
import { RuntimeFailure, cancelled } from "./runtime-control.ts";

const MAX_PENDING_REQUESTS = 32;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDOUT_LINES = 10_000;
const MAX_STDERR_BYTES = 64 * 1024;
export const MCP_MAX_TOOL_TIMEOUT_MS = 630_000;
const DEFAULT_REQUEST_TIMEOUT_MS = MCP_MAX_TOOL_TIMEOUT_MS;
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_CANCELLATION_GRACE_MS = 10_000;
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
  networkPathPolicy?: {fixtures: string; cache: string; ca: string};
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

export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpCallOptions {
  timeoutMs?: number;
  onProgress?: (progress: McpProgress) => void;
}

export interface McpClientOptions {
  cancellationGraceMs?: number;
  controlTimeoutMs?: number;
  startupTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
  onProgress?: (progress: McpProgress) => void;
  lastProgress?: number;
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
  private readonly options: McpClientOptions;
  private readonly cancelledRequests = new Map<number, NodeJS.Timeout>();
  private readonly terminatingChildren = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  private cleanupFailure?: Error;

  constructor(paths: McpPaths, options: McpClientOptions = {}) {
    this.paths = paths;
    for (const [key, value] of Object.entries(options)) {
      if (!Number.isSafeInteger(value) || value! < 1 || value! > MCP_MAX_TOOL_TIMEOUT_MS) throw new Error(`Invalid MCP ${key}.`);
    }
    this.options = options;
  }

  /** Dedicated per-run stdio process and pending-request namespace. */
  fork(): McpClient { return new McpClient({ ...this.paths }, this.options); }
  createSession(): McpClient { return this.fork(); }

  async tools(refresh = false): Promise<McpTool[]> {
    if (!refresh && this.toolsCache) return this.toolsCache;
    await this.start();
    const response = (await this.request("tools/list", {}, undefined, this.options.controlTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS)) as { tools?: McpTool[] };
    this.toolsCache = response.tools ?? [];
    return this.toolsCache;
  }

  async capabilities(refresh = false): Promise<McpCapabilities> {
    if (!refresh && this.capabilitiesCache) return this.capabilitiesCache;
    await this.start();
    const response = await this.request("proto/capabilities", {}, undefined, this.options.controlTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS);
    this.capabilitiesCache = parseCapabilities(response);
    return this.capabilitiesCache;
  }

  async call(
    name: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: McpCallAuthorization,
    options: McpCallOptions = {},
  ): Promise<Record<string, unknown>> {
    await this.start();
    const capability = authorization
      ? this.createNetworkCapability(name, arguments_, authorization)
      : undefined;
    const result = (await this.request(
      "tools/call",
      { name, arguments: arguments_, ...(capability ? { capability } : {}) },
      signal,
      options.timeoutMs ?? toolDeadlineMs(name, arguments_),
      options.onProgress,
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
    await Promise.all(this.terminatingChildren.values());
    if (this.cleanupFailure) throw this.cleanupFailure;
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
    child.stdout.on("data", (chunk: string) => { if (this.child === child) this.handleStdout(chunk); });
    child.stderr.on("data", (chunk: string) => {
      if (this.child === child) this.stderrBuffer = (this.stderrBuffer + chunk).slice(-MAX_STDERR_BYTES);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new RuntimeFailure("TOOL_TIMEOUT", "mcp-startup", "MCP process startup exceeded its deadline.")), this.options.startupTimeoutMs ?? 45_000);
        child.once("spawn", () => { clearTimeout(timer); resolve(); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
    } catch (error) {
      if (this.child === child) this.child = undefined;
      if (child.exitCode === null) await this.terminateChild(child);
      throw error;
    }
    child.on("error", (error) => { if (this.child === child) this.rejectAll(error); });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      // Unexpected exit also precedes stdio close. Reuse the cleanup barrier
      // without targeting an already exited process.
      void this.terminateChild(child);
      this.toolsCache = undefined;
      this.capabilitiesCache = undefined;
      this.rejectAll(new RuntimeFailure("TOOL_SESSION_INTERRUPTED", "mcp-process", `proto-agent MCP exited with code ${code}. ${this.stderrBuffer.trim()}`.trim(), {effectState:"unknown"}));
      for (const id of [...this.cancelledRequests.keys()]) this.clearCancelledRequest(id);
    });
    try {
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "proto-workbench", version: "0.2.0-rc.1" },
    }, undefined, this.options.controlTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS);
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
    onProgress?: (progress: McpProgress) => void,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error("MCP sidecar is not running."));
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("MCP pending-request limit exceeded."));
    if (signal?.aborted) return Promise.reject(cancelled());
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MCP_MAX_TOOL_TIMEOUT_MS) return Promise.reject(new Error("MCP timeout must be between 1 and 630000 milliseconds."));
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params: onProgress ? { ...params, _meta: { progressToken: id } } : params })}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) {
      return Promise.reject(new Error("MCP request exceeds the 512 KiB payload limit."));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removePending(id);
        reject(new RuntimeFailure("TOOL_TIMEOUT", method, `MCP request ${method} exceeded its ${timeoutMs} ms deadline.`, { budgetMs: timeoutMs, effectState: method === "tools/call" ? "unknown" : "none" }));
        this.cancelWithGrace(id, child);
      }, timeoutMs);
      timer.unref?.();
      const pending: PendingRequest = { resolve, reject, timer, signal, onProgress };
      if (signal) {
        pending.abort = () => {
          this.removePending(id);
          reject(cancelled());
          this.cancelWithGrace(id, child);
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
      void this.terminateCurrent(new Error("MCP response exceeded the 4 MiB line limit.")).catch(() => {}); // retained by cleanupFailure; stop reports it
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (++this.stdoutLines > MAX_STDOUT_LINES) {
        void this.terminateCurrent(new Error("MCP stdout exceeded the per-session line limit.")).catch(() => {});
        return;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_LINE_BYTES) {
        void this.terminateCurrent(new Error("MCP response exceeded the 4 MiB line limit.")).catch(() => {});
        return;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      if (message.method === "notifications/progress") {
        const params = message.params;
        const token = params?.progressToken;
        const pending = typeof token === "number" ? this.pending.get(token) : undefined;
        const progress = params?.progress;
        const total = params?.total;
        if (!pending?.onProgress || typeof progress !== "number" || !Number.isFinite(progress) || progress < 0
          || progress < (pending.lastProgress ?? 0) || (total !== undefined && (typeof total !== "number" || !Number.isFinite(total) || total < progress))) return;
        pending.lastProgress = progress;
        pending.onProgress({ progress, ...(typeof total === "number" ? { total } : {}),
          ...(typeof params?.message === "string" ? { message: params.message.slice(0, 1024) } : {}) });
        return;
      }
      if (message.method === "notifications/proto-request-finished" && typeof message.params?.requestId === "number") {
        this.clearCancelledRequest(message.params.requestId);
        return;
      }
      if (!Number.isSafeInteger(message.id)) return;
      const id = message.id as number;
      this.clearCancelledRequest(id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.removePending(id);
      if (message.error) pending.reject(new Error(message.error.message || "MCP request failed."));
      else pending.resolve(message.result);
    } catch {
      // Non-protocol stdout is ignored, but it remains subject to the strict line-size limit.
    }
  }

  private cancelWithGrace(id: number, child: ChildProcessWithoutNullStreams): void {
    this.writeCancellation(id);
    const timer = setTimeout(() => {
      this.cancelledRequests.delete(id);
      if (this.child !== child) return;
      void this.terminateCurrent(new RuntimeFailure("TOOL_SESSION_INTERRUPTED", "mcp-cancellation", "The run's MCP worker did not acknowledge cancellation before its grace deadline.", { effectState: "unknown" })).catch(() => {});
    }, this.options.cancellationGraceMs ?? MCP_CANCELLATION_GRACE_MS);
    timer.unref?.();
    this.cancelledRequests.set(id, timer);
  }

  private clearCancelledRequest(id: number): void {
    const timer = this.cancelledRequests.get(id);
    if (timer) clearTimeout(timer);
    this.cancelledRequests.delete(id);
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
    for (const id of [...this.cancelledRequests.keys()]) this.clearCancelledRequest(id);
    if (child && child.exitCode === null) this.terminateChild(child);
    // A protocol/cancellation failure may already have detached this.child
    // while its owned process tree is still stopping. All callers share that
    // barrier, including a later session.stop() during AgentService teardown.
    await Promise.all(this.terminatingChildren.values());
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const pending = this.terminatingChildren.get(child);
    if (pending) return pending;
    const termination = terminateOwnedProcessTree(child);
    this.terminatingChildren.set(child, termination);
    const release = () => {if (this.terminatingChildren.get(child) === termination) this.terminatingChildren.delete(child);};
    void termination.then(release, error => {this.cleanupFailure = error instanceof Error ? error : new Error(String(error));release();});
    return termination;
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.removePending(id);
      pending?.reject(error);
    }
  }
}

export function toolDeadlineMs(name: string, args: Record<string, unknown>): number {
  if (["proto_run_analysis", "proto_run_notebook", "proto_run_r"].includes(name)) {
    const fallback = name === "proto_run_analysis" ? 60 : 120;
    const seconds = args.timeout === undefined ? fallback : args.timeout;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 600) throw new Error("Execution timeout must be between 1 and 600 seconds.");
    return seconds * 1000 + 30_000;
  }
  if (["proto_workflow_run", "proto_review_packet"].includes(name)) return MCP_MAX_TOOL_TIMEOUT_MS;
  if (/materialize|compile/.test(name)) return 210_000;
  if (/search/.test(name)) return 150_000;
  return 90_000;
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
  // The Python sidecar advertises named local-input policy, not network grants.
  // Preserve it explicitly while retaining legacy array snapshots for readers.
  let networkPaths: string[], networkPathPolicy: McpCapabilities["networkPathPolicy"];
  if (Array.isArray(root.networkPaths) && root.networkPaths.every(entry => typeof entry === "string")) networkPaths = [...root.networkPaths];
  else {
    const policy = objectValue(root.networkPaths, "MCP capability networkPaths");
    if (Object.keys(policy).sort().join(",") !== "ca,cache,fixtures") throw new Error("MCP capability networkPaths is invalid.");
    networkPathPolicy = {fixtures:stringValue(policy.fixtures,"networkPaths.fixtures"),cache:stringValue(policy.cache,"networkPaths.cache"),ca:stringValue(policy.ca,"networkPaths.ca")};
    networkPaths = Object.entries(networkPathPolicy).map(([name,value]) => `${name}: ${value}`);
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
    networkPaths,
    ...(networkPathPolicy ? {networkPathPolicy} : {}),
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
