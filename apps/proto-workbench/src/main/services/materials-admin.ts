import { isAbsolute, join, resolve } from "node:path";

export interface MaterialsRootPathOptions {
  configuredRoot?: string;
  isPackaged: boolean;
  documentsPath: string;
  repoRoot: string;
}

/** Resolve the shared CLI/Workbench catalogue root without embedding a user path. */
export function resolveMaterialsRootPath(options: MaterialsRootPathOptions): string {
  if (options.configuredRoot) {
    if (!isAbsolute(options.configuredRoot)) {
      throw new Error("PROTO_AGENT_MATERIALS_ROOT must be an absolute path");
    }
    return resolve(options.configuredRoot);
  }
  return options.isPackaged
    ? join(options.documentsPath, "Proto CLI Materials")
    : resolve(options.repoRoot, "..", "Proto CLI Materials");
}

/**
 * Resolve the bounded admin CLI inside PyInstaller's onedir layout.
 *
 * `build-proto-sidecar.ps1` stages the named distribution directory beneath
 * `runtime/proto-agent`, so the executable is intentionally nested one level
 * below the copied resource root.
 */
export function packagedMaterialsCliPath(resourcesPath: string): string {
  return join(
    resourcesPath,
    "runtime",
    "proto-agent",
    "proto-agent",
    "proto-agent.exe",
  );
}
