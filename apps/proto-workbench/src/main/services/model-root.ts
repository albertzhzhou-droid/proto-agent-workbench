import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export async function resolveModelLibraryRoot(selectedRoot: string): Promise<string> {
  const root = resolve(selectedRoot.trim());
  const rootStats = await stat(root).catch(() => undefined);
  if (!rootStats?.isDirectory()) throw new Error(`Model library directory does not exist: ${root}`);

  if (basename(root).toLocaleLowerCase() !== "models") {
    const nestedModels = join(root, "models");
    const nestedStats = await stat(nestedModels).catch(() => undefined);
    if (nestedStats?.isDirectory()) return nestedModels;
  }
  return root;
}
