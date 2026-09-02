import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const MINIMAL_ENV_KEYS = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
] as const;

export function minimalChildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function terminateOwnedProcessTree(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill" | "once">,
  graceMs = 2_000,
): Promise<void> {
  if (hasExited(child)) return;
  const pid = child.pid;
  if (process.platform === "win32" && Number.isInteger(pid) && (pid as number) > 0) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const taskkill = join(systemRoot, "System32", "taskkill.exe");
    await new Promise<void>((resolve) => {
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        env: minimalChildEnvironment(),
      });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        killer.kill();
        finish();
      }, Math.max(1_000, graceMs));
      timer.unref?.();
      killer.once("error", finish);
      killer.once("exit", finish);
    });
    if (await waitForExit(child, graceMs)) return;
    if (!hasExited(child)) child.kill("SIGKILL");
  } else if (Number.isInteger(pid) && (pid as number) > 0) {
    try {
      process.kill(-(pid as number), "SIGTERM");
    } catch {
      child.kill();
    }
    if (await waitForExit(child, graceMs)) return;
    try {
      process.kill(-(pid as number), "SIGKILL");
    } catch {
      if (!hasExited(child)) child.kill("SIGKILL");
    }
  }
  await waitForExit(child, graceMs);
}

function waitForExit(
  child: Pick<ChildProcess, "exitCode" | "signalCode" | "once">,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(hasExited(child));
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function hasExited(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
