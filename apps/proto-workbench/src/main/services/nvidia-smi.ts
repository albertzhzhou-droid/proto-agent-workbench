import { isAbsolute, join } from "node:path";

export function nvidiaSmiExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return "/usr/bin/nvidia-smi";
  const windowsRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!windowsRoot || !isAbsolute(windowsRoot)) {
    throw new Error("A trusted absolute Windows system root is required for the NVIDIA probe.");
  }
  return join(windowsRoot, "System32", "nvidia-smi.exe");
}
