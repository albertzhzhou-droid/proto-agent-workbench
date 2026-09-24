import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ComputeRequest, ComputeRun } from "../../shared/compute.ts";

// The renderer supplies data only. Output paths and the callable tool are host-owned.
export async function runWorkspaceComputation(root: string, request: ComputeRequest,
  call: (name: string, input: Record<string, unknown>, operationId: string) => Promise<Record<string, unknown>>,
  operationId: string = randomUUID(),
): Promise<ComputeRun> {
  const path = await writeWorkspaceComputeRequest(root, request, operationId);
  return await call("proto_compute_run", {path}, operationId) as unknown as ComputeRun;
}

/** A host-owned immutable request can also be inspected by the read-only identity endpoint. */
export async function writeWorkspaceComputeRequest(root: string, request: ComputeRequest, operationId: string = randomUUID()): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new Error("Compute operation ID must be a UUID.");
  }
  let directory = resolve(root);
  await assertDirectory(directory);
  for (const segment of ["build", "compute-inputs"]) {
    directory = join(directory, segment);
    try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertDirectory(directory);
  }
  const name = `${operationId}.json`;
  const target = join(directory, name);
  const payload = JSON.stringify(request, null, 2);
  try {
    await writeFile(target, payload, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(target), actual = await realpath(target), handle = await open(target, "r");
    try {
      const opened = await handle.stat();
      const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2 * 1024 * 1024
        || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size
        || normalize(actual) !== normalize(target) || await handle.readFile("utf8") !== payload) {
        throw new Error("COMPUTE_REQUEST_IDENTITY_CONFLICT");
      }
      const finalInfo = await lstat(target), finalPath = await realpath(target);
      if (!finalInfo.isFile() || finalInfo.isSymbolicLink() || finalInfo.nlink !== 1
        || finalInfo.dev !== opened.dev || finalInfo.ino !== opened.ino || finalInfo.size !== opened.size
        || normalize(finalPath) !== normalize(target)) throw new Error("COMPUTE_REQUEST_IDENTITY_CONFLICT");
    } finally { await handle.close(); }
  }
  return `build/compute-inputs/${name}`;
}

async function assertDirectory(path: string) {
  const info = await lstat(path);
  const actual = await realpath(path);
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (!info.isDirectory() || info.isSymbolicLink() || normalize(actual) !== normalize(resolve(path))) {
    throw new Error("Compute artifacts require regular workspace directories without links or junctions.");
  }
}
