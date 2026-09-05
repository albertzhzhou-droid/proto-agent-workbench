import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, parse, relative } from "node:path";
import { seedWorkspace } from "./workspace-bootstrap.ts";

export interface LaunchSession { root: string; profile: string; workspace: string }

/** Explicit local launch authority, parsed before Electron takes its profile lock. */
export function prepareLaunchSession(argv: string[]): LaunchSession | undefined {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--session-root") values.push(argv[++index] ?? "");
    else if (argument.startsWith("--session-root=")) values.push(argument.slice("--session-root=".length));
  }
  if (!values.length) return undefined;
  if (values.length !== 1) throw new Error("Specify --session-root exactly once.");
  const requested = values[0];
  if (!requested || requested.length > 4096 || requested.includes("\0") || !isAbsolute(requested)) {
    throw new Error("--session-root requires an existing absolute directory.");
  }
  const root = realpathSync(requested);
  if (!statSync(root).isDirectory() || root === parse(root).root) {
    throw new Error("The session root must be a directory below the filesystem root.");
  }
  const child = (name: "profile" | "workspace") => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    const canonical = realpathSync(path);
    const within = relative(root, canonical);
    const equivalent = process.platform === "win32" ? within.toLowerCase() === name : within === name;
    if (!statSync(canonical).isDirectory() || !equivalent) {
      throw new Error(`Session ${name} must resolve to its own directory directly inside the session root.`);
    }
    return canonical;
  };
  return { root, profile: child("profile"), workspace: child("workspace") };
}

export async function prepareLaunchWorkspace(input: {
  packaged: boolean; session?: LaunchSession; fallbackPath: string;
  documentsPath: () => string; templatePath: string;
}): Promise<string> {
  // An explicit session never consults or seeds the user's Documents directory.
  // Its inputs are supplied by the operator, through the normal workspace tools.
  if (input.session) return input.session.workspace;
  if (!input.packaged) return input.fallbackPath;
  const path = join(input.documentsPath(), "Proto Workbench Workspace");
  await seedWorkspace(input.templatePath, path);
  return path;
}
