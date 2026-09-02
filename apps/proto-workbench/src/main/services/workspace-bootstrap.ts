import { cp, mkdir } from "node:fs/promises";

export interface StartupWorkspaceActivation {
  activePath: string;
  fallback?: {
    requestedPath: string;
    reason: string;
  };
}

export async function seedWorkspace(templatePath: string, workspacePath: string): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  await cp(templatePath, workspacePath, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

export async function activateStartupWorkspace(
  requestedPath: string,
  fallbackPath: string,
  activate: (workspacePath: string) => Promise<void>,
): Promise<StartupWorkspaceActivation> {
  try {
    await activate(requestedPath);
    return { activePath: requestedPath };
  } catch (error) {
    if (requestedPath === fallbackPath) throw error;
    await activate(fallbackPath);
    return {
      activePath: fallbackPath,
      fallback: {
        requestedPath,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
