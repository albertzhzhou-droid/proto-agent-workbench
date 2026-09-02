import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const MAX_RUNTIME_HASH_MILLISECONDS = 30_000;

const SAFE_EXTERNAL_OPEN_EXTENSIONS = new Set([
  ".proto",
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);

export interface RuntimeExecutableTrust {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export async function canonicalSelectedDirectory(inputPath: string): Promise<string> {
  const original = await lstat(inputPath);
  if (original.isSymbolicLink() || !original.isDirectory()) {
    throw new Error("The selected path must be a regular, non-linked directory.");
  }
  const canonical = await realpath(inputPath);
  if (!samePath(canonical, resolve(inputPath))) {
    throw new Error("Directory selections cannot traverse symbolic links, junctions, or other reparse points.");
  }
  const canonicalInfo = await stat(canonical);
  if (!canonicalInfo.isDirectory()) throw new Error("The selected directory no longer exists.");
  return canonical;
}

export async function trustRuntimeExecutable(inputPath: string): Promise<RuntimeExecutableTrust> {
  if (basename(inputPath).toLowerCase() !== "llama-server.exe" || extname(inputPath).toLowerCase() !== ".exe") {
    throw new Error("Select the upstream llama-server.exe executable.");
  }
  const original = await lstat(inputPath);
  if (original.isSymbolicLink() || !original.isFile()) {
    throw new Error("The runtime must be a regular, non-linked executable file.");
  }
  const canonical = await realpath(inputPath);
  if (!samePath(canonical, resolve(inputPath))) {
    throw new Error("Runtime selections cannot traverse symbolic links, junctions, or other reparse points.");
  }
  const canonicalInfo = await stat(canonical);
  if (!canonicalInfo.isFile()) throw new Error("The selected runtime is not a regular file.");
  if (canonicalInfo.size > MAX_RUNTIME_BYTES) throw new Error("The selected runtime exceeds the 512 MiB trust limit.");
  return { path: canonical, sha256: await sha256File(canonical), sizeBytes: canonicalInfo.size };
}

export async function revalidateRuntimeExecutable(trust: RuntimeExecutableTrust): Promise<string> {
  const current = await trustRuntimeExecutable(trust.path);
  if (current.path !== trust.path || current.sha256 !== trust.sha256 || current.sizeBytes !== trust.sizeBytes) {
    throw new Error("The selected llama-server.exe changed after approval. Select and trust it again.");
  }
  return current.path;
}

export function assertSafeExternalOpenPath(path: string): void {
  if (!SAFE_EXTERNAL_OPEN_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new Error("This file type cannot be opened by an external application from Proto Workbench.");
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    const timer = setTimeout(() => stream.destroy(new Error("Runtime hashing exceeded its 30 second deadline.")), MAX_RUNTIME_HASH_MILLISECONDS);
    timer.unref?.();
    stream.once("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("close", () => clearTimeout(timer));
    stream.once("end", resolve);
  });
  return digest.digest("hex");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
