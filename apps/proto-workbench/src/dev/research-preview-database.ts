import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Isolate browser acceptance records without changing the normal preview DB. */
export function researchPreviewDatabase(workspace: string, override?: string): string {
  if (override === undefined || override === "") return resolve(workspace, "build/chat-preview/conversations.sqlite");
  const root = realpathSync(workspace);
  const build = resolve(root, "build");
  const target = resolve(root, override);
  const rel = relative(build, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || extname(target) !== ".sqlite") {
    throw new Error("PROTO_CHAT_PREVIEW_DB must name a .sqlite file inside this workspace's build directory.");
  }
  let directory = root;
  const parts = relative(root, target).split(sep);
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    if (!existsSync(directory)) mkdirSync(directory);
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(directory) !== directory) {
      throw new Error("Preview database parents must be regular workspace directories.");
    }
  }
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Preview database must be a regular file.");
  }
  return target;
}
