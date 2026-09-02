import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { access, chmod, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type {
  KvCachePlacement,
  KvCacheType,
  ModelDescriptor,
  ModelInstance,
  RuntimeStatus,
} from "../../shared/contracts.ts";
import { revalidateRuntimeExecutable, type RuntimeExecutableTrust } from "./path-security.ts";
import { minimalChildEnvironment, terminateOwnedProcessTree } from "./process-security.ts";
import { nvidiaSmiExecutable } from "./nvidia-smi.ts";
import type { ChatCompletionChunk } from "./inference-provider.ts";

export type { ChatCompletionChunk } from "./inference-provider.ts";

const execFileAsync = promisify(execFile);

export interface LlamaRuntimePaths {
  packaged: boolean;
  resourcesPath: string;
  projectRoot: string;
  overrideTrust?: RuntimeExecutableTrust;
}

interface LlamaLoadOptions {
  contextLength: number;
  gpuLayers: number;
  cacheType?: KvCacheType;
  kvCachePlacement?: KvCachePlacement;
}

interface RunningServer {
  instance: ModelInstance;
  process: LlamaServerProcess;
  token: string;
  credential?: EphemeralLlamaCredential;
  credentialCleanup?: Promise<void>;
  boundListener?: boolean;
  stderr: string;
  allocationLog: string;
}

type LlamaServerProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface EphemeralLlamaCredential {
  path: string;
  dispose(): Promise<void>;
}

export class LlamaServerManager {
  private readonly servers = new Map<string, RunningServer>();
  private readonly paths: LlamaRuntimePaths;

  constructor(paths: LlamaRuntimePaths) {
    this.paths = paths;
  }

  setOverrideTrust(trust?: RuntimeExecutableTrust): void {
    this.paths.overrideTrust = trust;
  }

  async runtimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
    const candidates = await this.runtimeCandidates();
    let cudaUnavailable = false;
    for (const candidate of candidates) {
      try {
        signal?.throwIfAborted();
        await access(candidate);
        const devices = await listDevices(candidate, signal);
        const expectsCuda = /[\\/]cuda[\\/]/i.test(candidate);
        if (expectsCuda && devices.length === 0) {
          cudaUnavailable = true;
          continue;
        }
        const backend = devices.length > 0 ? "cuda" : "cpu";
        return {
          available: true,
          path: candidate,
          backend,
          degraded: backend === "cpu" && cudaUnavailable,
          detail: backend === "cuda"
            ? `Independent upstream llama.cpp CUDA runtime is available (${devices.join(", ")}).`
            : cudaUnavailable
              ? "CUDA runtime is present but registered no GPU device. Explicit CPU fallback is selected."
              : "Independent upstream llama.cpp CPU runtime is available.",
        };
      } catch {
        // Try the next packaged CPU/CUDA candidate.
      }
    }
    return {
      available: false,
      detail:
        "Independent llama-server.exe is not installed. Add an upstream llama.cpp Windows build under runtime/llama.cpp.",
    };
  }

  async load(
    model: ModelDescriptor,
    options: LlamaLoadOptions,
    signal?: AbortSignal,
  ): Promise<ModelInstance> {
    signal?.throwIfAborted();
    await this.unload(model.id);
    const status = await this.runtimeStatus(signal);
    if (!status.available || !status.path || !status.backend) throw new Error(status.detail);
    const runtimePath = status.path;
    const backend = status.backend;
    const gpuUsedBefore = backend === "cuda" ? await queryNvidiaUsedVramBytes() : 0;

    const attemptedPorts = new Set<number>();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal?.throwIfAborted();
      const port = chooseLoopbackPort(attemptedPorts);
      attemptedPorts.add(port);
      try {
        return await this.launchServerAttempt(
          model,
          options,
          runtimePath,
          backend,
          gpuUsedBefore,
          port,
          signal,
        );
      } catch (error) {
        if (attempt === 3 || !isLlamaLoopbackBindConflict(error)) throw error;
      }
    }
    throw new Error("llama-server exhausted its bounded loopback bind attempts.");
  }

  private async launchServerAttempt(
    model: ModelDescriptor,
    options: LlamaLoadOptions,
    runtimePath: string,
    backend: "cuda" | "cpu",
    gpuUsedBefore: number,
    port: number,
    signal?: AbortSignal,
  ): Promise<ModelInstance> {
    const token = randomBytes(24).toString("hex");
    const credential = await createEphemeralLlamaCredential(token);
    const gpuLayers = backend === "cuda" ? options.gpuLayers : 0;

    let child: LlamaServerProcess;
    try {
      const args = buildLlamaServerArgs(model, {
        ...options,
        gpuLayers,
        port,
        apiKeyFile: credential.path,
      });
      child = spawn(runtimePath, args, {
        // app.getAppPath() points at app.asar in packaged builds, which is a
        // file rather than a valid Windows working directory. Launch beside the
        // runtime so portable extraction paths and dependent DLLs stay valid.
        cwd: dirname(runtimePath),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: minimalChildEnvironment(),
      });
    } catch (error) {
      try {
        await credential.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Unable to start llama-server.exe and remove its temporary credential.",
        );
      }
      throw error;
    }
    const instance: ModelInstance = {
      modelId: model.id,
      state: "loading",
      contextLength: options.contextLength,
      gpuLayers,
      cacheType: options.cacheType ?? "f16",
      kvCachePlacement: options.kvCachePlacement ?? "gpu",
      processId: child.pid,
      startedAt: new Date().toISOString(),
    };
    const running: RunningServer = {
      instance,
      process: child,
      token,
      credential,
      stderr: "",
      allocationLog: "",
    };
    let spawnError: Error | undefined;
    this.servers.set(model.id, running);
    child.once("error", (error) => {
      spawnError = error;
      instance.state = "error";
      instance.error = `Unable to start llama-server.exe: ${error.message}`;
      running.stderr = instance.error;
    });
    const observeBoundListener = () => {
      if (running.boundListener || !hasLlamaServerStartedModelLoad(running.allocationLog)) return;
      running.boundListener = true;
      // Argument parsing and HTTP bind are complete before this b9970 marker,
      // so the server has already copied the key and no longer needs the file.
      running.credentialCleanup = credential.dispose().then(
        () => {
          running.credential = undefined;
        },
        (error: unknown) => {
          spawnError = new Error(`Unable to remove llama-server's temporary credential: ${String(error)}`);
        },
      );
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      running.stderr = (running.stderr + chunk).slice(-32_768);
      // Allocation lines are emitted early during model loading. Keep them in a
      // separate bounded buffer so later HTTP/server logs cannot evict them.
      running.allocationLog = (running.allocationLog + chunk).slice(-262_144);
      observeBoundListener();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Newer llama.cpp builds may route startup diagnostics to stdout.
      running.allocationLog = (running.allocationLog + chunk).slice(-262_144);
      observeBoundListener();
    });
    child.once("exit", (code) => {
      if (this.servers.get(model.id)?.process === child) {
        instance.state = code === 0 ? "unloaded" : "error";
        instance.error = code === 0 ? undefined : running.stderr.trim() || `llama-server exited ${code}`;
        this.servers.delete(model.id);
      }
    });

    try {
      await waitForHealth(
        port,
        () => running.boundListener === true,
        child,
        () => `${running.stderr}\n${running.allocationLog}`,
        () => spawnError,
        options.contextLength >= 262_144 ? 600_000 : 180_000,
        signal,
      );
      instance.port = port;
      await running.credentialCleanup;
      if (spawnError) throw new Error(`Unable to start llama-server.exe: ${spawnError.message}`);
      await credential.dispose();
      running.credential = undefined;
      if (backend === "cuda") {
        const gpuUsedAfter = await queryNvidiaUsedVramBytes();
        const sampledDelta = Math.max(0, gpuUsedAfter - gpuUsedBefore);
        const loggedAllocation = parseCudaBufferBytes(running.allocationLog);
        const measured = Math.max(sampledDelta, loggedAllocation);
        if (measured > 0) instance.measuredVramBytes = measured;
      }
      instance.state = "active";
      instance.lastUsedAt = new Date().toISOString();
      return { ...instance };
    } catch (error) {
      this.servers.delete(model.id);
      const cleanupErrors: unknown[] = [];
      try {
        await terminateOwnedProcessTree(child);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await credential.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "llama-server launch failed and owned-resource cleanup was incomplete.",
        );
      }
      throw error;
    }
  }

  async unload(modelId: string): Promise<void> {
    const running = this.servers.get(modelId);
    if (!running) return;
    this.servers.delete(modelId);
    const cleanupErrors: unknown[] = [];
    try {
      if (running.process.exitCode === null) {
        await terminateOwnedProcessTree(running.process, 3_000);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await running.credential?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    running.credential = undefined;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "llama-server owned-resource cleanup was incomplete.");
    }
  }

  async unloadAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((modelId) => this.unload(modelId)));
  }

  has(modelId: string): boolean {
    return this.servers.has(modelId);
  }

  processId(modelId: string): number | undefined {
    return this.servers.get(modelId)?.process.pid;
  }

  gpuAllocationBytes(modelId: string): number | undefined {
    const running = this.servers.get(modelId);
    if (running?.instance.measuredVramBytes) return running.instance.measuredVramBytes;
    const bytes = parseCudaBufferBytes(running?.allocationLog ?? "");
    return bytes > 0 ? bytes : undefined;
  }

  async chat(
    modelId: string,
    payload: Record<string, unknown>,
    onChunk: (chunk: ChatCompletionChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const running = this.servers.get(modelId);
    if (
      !running?.instance.port
      || running.process.exitCode != null
      || running.process.signalCode != null
    ) {
      throw new Error("The selected model is not loaded.");
    }
    running.instance.lastUsedAt = new Date().toISOString();
    const response = await fetch(`http://127.0.0.1:${running.instance.port}/v1/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${running.token}`,
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(formatLlamaServerError(response.status, await response.text()));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const emitFrame = (frame: string): boolean => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data) return false;
      if (data === "[DONE]") return true;
      onChunk(JSON.parse(data) as ChatCompletionChunk);
      return false;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (!emitFrame(frame)) continue;
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && emitFrame(buffer)) await reader.cancel().catch(() => undefined);
  }

  private async runtimeCandidates(): Promise<string[]> {
    const root = this.paths.packaged
      ? join(this.paths.resourcesPath, "runtime", "llama.cpp")
      : join(this.paths.projectRoot, "runtime", "llama.cpp");
    const override = this.paths.overrideTrust
      ? await revalidateRuntimeExecutable(this.paths.overrideTrust)
      : undefined;
    return [
      override,
      join(root, "cuda", "llama-server.exe"),
      join(root, "cpu", "llama-server.exe"),
      join(root, "llama-server.exe"),
    ].filter((value): value is string => Boolean(value));
  }
}

export function buildLlamaServerArgs(
  model: ModelDescriptor,
  options: {
    contextLength: number;
    gpuLayers: number;
    cacheType?: KvCacheType;
    kvCachePlacement?: KvCachePlacement;
    port: number;
    apiKeyFile: string;
  },
): string[] {
  if (/\0|\r|\n/.test(model.path) || (model.projectorPath && /\0|\r|\n/.test(model.projectorPath))) {
    throw new Error("llama-server model paths must not contain control-line characters.");
  }
  if (/\0|\r|\n/.test(options.apiKeyFile)) {
    throw new Error("llama-server credential paths must not contain control-line characters.");
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("llama-server loopback port must be an integer from 1 to 65535.");
  }
  const cacheType = options.cacheType ?? "f16";
  const args = [
    "--model",
    model.path,
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--api-key-file",
    options.apiKeyFile,
    "--ctx-size",
    String(options.contextLength),
    "--n-gpu-layers",
    String(options.gpuLayers),
    "--parallel",
    "1",
    "--fit",
    "off",
    "--offline",
    "--no-webui",
    "--jinja",
    "--cache-type-k",
    cacheType,
    "--cache-type-v",
    cacheType,
    options.kvCachePlacement === "cpu" ? "--no-kv-offload" : "--kv-offload",
    "--log-verbosity",
    "3",
    "--log-colors",
    "off",
  ];
  if (cacheType !== "f16") args.push("--flash-attn", "on");
  if (model.projectorPath) args.push("--mmproj", model.projectorPath);
  return args;
}

async function listDevices(executable: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--list-devices"], {
      windowsHide: true,
      // Freshly unpacked executables can spend tens of seconds in Windows
      // security scanning before their first instruction runs.
      timeout: 60_000,
      maxBuffer: 256 * 1024,
      signal,
    });
    return `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^available devices:?$/i.test(line));
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}

export function parseCudaBufferBytes(stderr: string): number {
  let totalMib = 0;
  const matchedLines = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    if (!/CUDA\d+/i.test(line) || !/buffer size/i.test(line) || matchedLines.has(line)) continue;
    const match = line.match(/buffer size\s*=\s*([\d.]+)\s*MiB/i);
    if (!match) continue;
    matchedLines.add(line);
    totalMib += Number(match[1]);
  }
  return Math.round(totalMib * 1024 ** 2);
}

export function formatLlamaServerError(status: number, detail: string): string {
  if (/Failed to parse tool call arguments as JSON/i.test(detail)) {
    return "The model produced malformed tool-call JSON. Retry once; after two consecutive failures it will be limited to Chat-only mode.";
  }
  const compact = detail.replace(/\s+/g, " ").trim();
  const suffix = compact.length > 1_000 ? `${compact.slice(0, 1_000)}...` : compact;
  return `llama-server request failed (${status})${suffix ? `: ${suffix}` : "."}`;
}

async function queryNvidiaUsedVramBytes(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      nvidiaSmiExecutable(),
      ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 5_000 },
    );
    const memoryMib = Number(String(stdout).trim().split(/\r?\n/, 1)[0]);
    return Number.isFinite(memoryMib) ? memoryMib * 1024 ** 2 : 0;
  } catch {
    return 0;
  }
}

async function waitForHealth(
  port: number,
  listenerBound: () => boolean,
  child: LlamaServerProcess,
  stderr: () => string,
  spawnError: () => Error | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const launchFailure = spawnError();
    if (launchFailure) {
      throw new Error(`Unable to start llama-server.exe: ${launchFailure.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = stderr();
      const prefix = /out of memory|cuda.*alloc|failed to allocate/i.test(detail) ? "GPU_OOM: " : "";
      throw new Error(prefix + (detail.trim() || `llama-server exited ${child.exitCode ?? child.signalCode}`));
    }
    if (!listenerBound()) {
      await delay(500, signal);
      continue;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
          : AbortSignal.timeout(2_000),
      });
      if (await isExpectedLlamaHealthResponse(response)) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        return;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Model loading is still in progress.
    }
    await delay(500, signal);
  }
  if (!listenerBound()) {
    throw new Error(
      "llama-server did not publish the expected post-bind, pre-metadata startup announcement.",
    );
  }
  throw new Error(`llama-server did not become healthy within ${Math.round(timeoutMs / 1_000)} seconds.`);
}

export function hasLlamaServerStartedModelLoad(output: string): boolean {
  // b9970 reaches server_context::load_model() only after its HTTP socket has
  // bound successfully. This logger-owned prefix is emitted before the GGUF is
  // opened, so attacker-controlled model metadata cannot synthesize the first
  // accepted occurrence. Native b9970 builds may prepend their fixed
  // monotonic-time and severity fields (for example `0.00.109.346 I`) before
  // the same `srv    load_model` record. Model paths containing line controls
  // are rejected, and no free-form prefix is accepted here.
  return /(?:^|\r?\n)(?:\d{1,4}\.\d{2}\.\d{3}\.\d{3} [IWE] )?srv {4}load_model: loading model (?='[^\r\n]*'\r?$)/m.test(output);
}

function chooseLoopbackPort(excluded: ReadonlySet<number>): number {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomInt(49_152, 65_536);
    if (!excluded.has(candidate)) return candidate;
  }
  throw new Error("Unable to select a unique bounded-retry loopback port.");
}

export function isLlamaLoopbackBindConflict(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /couldn't bind HTTP server socket, hostname: 127\.0\.0\.1, port: \d+/i.test(detail);
}

export async function createEphemeralLlamaCredential(token: string): Promise<EphemeralLlamaCredential> {
  if (!/^[a-f0-9]{48}$/.test(token)) {
    throw new Error("llama-server credentials must be 192-bit lowercase hexadecimal tokens.");
  }
  const directory = await mkdtemp(join(tmpdir(), "proto-workbench-llama-"));
  const path = join(directory, "api-key");
  try {
    await chmod(directory, 0o700);
    await writeFile(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(path).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
    throw error;
  }

  let disposed = false;
  return {
    path,
    async dispose(): Promise<void> {
      if (disposed) return;
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      try {
        await rmdir(directory);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      disposed = true;
    },
  };
}

async function isExpectedLlamaHealthResponse(response: Response): Promise<boolean> {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4_096) {
      await reader.cancel().catch(() => undefined);
      return false;
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  try {
    const payload = JSON.parse(body) as unknown;
    return Boolean(
      payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && (payload as Record<string, unknown>).status === "ok",
    );
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
