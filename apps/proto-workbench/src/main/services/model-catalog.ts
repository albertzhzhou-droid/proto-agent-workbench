import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDescriptor } from "../../shared/contracts.ts";
import { minimalChildEnvironment, terminateOwnedProcessTree } from "./process-security.ts";

const SCAN_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_MODELS = 10_000;

export interface SidecarPaths {
  packaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  cachePath?: string;
  pythonExecutable?: string;
}

export class ModelCatalogService {
  private readonly paths: SidecarPaths;
  private activeScan?: { controller: AbortController; promise: Promise<ModelDescriptor[]> };

  constructor(paths: SidecarPaths) {
    this.paths = paths;
  }

  async scan(root: string, signal?: AbortSignal): Promise<ModelDescriptor[]> {
    this.activeScan?.controller.abort();
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    let tracked!: Promise<ModelDescriptor[]>;
    tracked = this.performScan(root, controller.signal).finally(() => {
      signal?.removeEventListener("abort", relayAbort);
      if (this.activeScan?.promise === tracked) this.activeScan = undefined;
    });
    this.activeScan = { controller, promise: tracked };
    return tracked;
  }

  cancel(): void {
    this.activeScan?.controller.abort();
  }

  private async performScan(root: string, signal: AbortSignal): Promise<ModelDescriptor[]> {
    const sidecarArgs = ["scan-models", root];
    if (this.paths.cachePath) sidecarArgs.push("--cache", this.paths.cachePath);
    const { command, args, env } = await this.command(sidecarArgs);
    const payload = await spawnJson(command, args, env, signal);
    if (!payload.ok || !Array.isArray(payload.models) || payload.models.length > MAX_MODELS) {
      const detail = typeof payload.error === "string"
        ? payload.error
        : "Model catalog sidecar returned an invalid or oversized response.";
      throw new Error(detail);
    }
    return payload.models as ModelDescriptor[];
  }

  private async command(sidecarArgs: string[]): Promise<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }> {
    if (this.paths.packaged) {
      const executable = join(
        this.paths.resourcesPath,
        "runtime",
        "proto-agent",
        "proto-workbench-sidecar",
        "proto-workbench-sidecar.exe",
      );
      await access(executable);
      return { command: executable, args: sidecarArgs, env: minimalChildEnvironment() };
    }

    const python = this.paths.pythonExecutable || process.env.PROTO_AGENT_PYTHON || "python";
    const sourceRoot = join(this.paths.repoRoot, "src");
    return {
      command: python,
      args: ["-m", "proto_agent.workbench_bridge", ...sidecarArgs],
      env: minimalChildEnvironment({
        PYTHONPATH: sourceRoot,
      }),
    };
  }
}

async function spawnJson(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    const finish = (error?: Error, payload?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(payload ?? {});
    };
    const terminate = (error: Error) => {
      if (settled || terminating) return;
      terminating = true;
      void terminateOwnedProcessTree(child).then(() => finish(error), cleanupError => finish(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))));
    };
    const abort = () => terminate(new DOMException("Model scan cancelled.", "AbortError"));
    const timer = setTimeout(
      () => terminate(new Error(`Model scan exceeded its ${SCAN_TIMEOUT_MS} ms deadline.`)),
      SCAN_TIMEOUT_MS,
    );
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        terminate(new Error("Model catalog output exceeded the 32 MiB limit."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES);
    });
    child.once("error", (error) => {
      if (!terminating) finish(error);
    });
    child.once("close", (code) => {
      if (settled || terminating) return;
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Model catalog exited with code ${code}.`));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout) as Record<string, unknown>);
      } catch (error) {
        finish(new Error(`Model catalog returned malformed JSON: ${String(error)}`));
      }
    });
    if (signal.aborted) abort();
  });
}
