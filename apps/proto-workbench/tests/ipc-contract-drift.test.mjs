import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { IPC_API_CHANNELS, IPC_CHANNEL_CONTRACTS, validateChannelArguments } from "../src/shared/ipc-channel-contracts.ts";
import { IPC } from "../src/shared/ipc.ts";

const workbench = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Type-check a copy of the sources with one edit applied.
 *
 * The copy lives under the workbench so `node_modules` and the base tsconfig
 * resolve exactly as they do for a normal build, and the real sources are never
 * modified.
 */
async function typeCheckWithEdit(edit) {
  const scratch = await mkdtemp(join(workbench, "build", "ipc-contract-drift-"));
  try {
    await cp(join(workbench, "src"), join(scratch, "src"), { recursive: true });
    await writeFile(join(scratch, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.json", include: ["src"] }, null, 2));
    const contracts = join(scratch, "src", "shared", "ipc-channel-contracts.ts");
    const original = await readFile(contracts, "utf8");
    const mutated = edit(original);
    assert.notEqual(mutated, original, "the edit must actually change the schema table");
    await writeFile(contracts, mutated);
    // Run the compiler directly: a shell would split the repository path.
    const completed = spawnSync(process.execPath,
      [join(workbench, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--noEmit"],
      { cwd: scratch, encoding: "utf8", timeout: 600_000 });
    return { status: completed.status, output: `${completed.stdout ?? ""}${completed.stderr ?? ""}` };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("removing a required argument from a channel schema fails the type check", async t => {
  t.diagnostic("Type-checks a full copy of src; this is slower than the unit tests around it.");
  const { status, output } = await typeCheckWithEdit(source =>
    source.replace(",evidenceRef:z.string().trim().min(1).max(4096)", ""));
  assert.notEqual(status, 0, "a schema that no longer supplies evidenceRef must not type-check");

  // The hand-written main-process handler still declares the removed field.
  assert.match(output, /src[\\/]main[\\/]index\.ts.*execution-journal:reconcile/s);
  assert.match(output, /'evidenceRef' is missing/);

  // And the domain contract cross-check names the channel that drifted.
  assert.match(output, /src[\\/]shared[\\/]ipc-channel-contracts\.ts/);
  assert.match(output, /"journal\.reconcile"/);
});

test("preload and the mock follow the schema table rather than restating it", () => {
  // Both implementations are typed as IpcWorkbenchApi, whose argument tuples are
  // inferred from the same schemas, so neither can hold a stale hand-written
  // signature. This is why a schema edit surfaces at the two hand-written
  // definitions above rather than in these two files.
  for (const [file, expected] of [
    ["src/preload/index.ts", "const api: IpcWorkbenchApi"],
    ["src/renderer/mock-api.ts", "const mockWorkbench: IpcWorkbenchApi"],
  ]) {
    const source = readFileSync(join(workbench, file), "utf8");
    assert.ok(source.includes(expected), `${file} must be typed by the shared channel contracts`);
  }
});

test("every API method is bound to exactly one registered channel", () => {
  const seen = new Map();
  for (const [domain, methods] of Object.entries(IPC_API_CHANNELS)) {
    for (const [method, channel] of Object.entries(methods)) {
      assert.ok(IPC_CHANNEL_CONTRACTS[channel], `${domain}.${method} uses unregistered channel ${channel}`);
      assert.equal(seen.get(channel), undefined, `${channel} is bound to both ${seen.get(channel)} and ${domain}.${method}`);
      seen.set(channel, `${domain}.${method}`);
    }
  }
  // The two push-only channels carry no arguments and no API method.
  const requestChannels = Object.values(IPC).filter(channel => channel !== IPC.modelsChanged && channel !== IPC.threadStream);
  for (const channel of requestChannels) {
    assert.ok(IPC_CHANNEL_CONTRACTS[channel], `${channel} has no argument schema`);
  }
  assert.equal(seen.size, requestChannels.length, "every request channel must be reachable through exactly one API method");
});

test("an unregistered channel is refused rather than passed through unvalidated", () => {
  assert.throws(() => validateChannelArguments("not-a-channel", []), /No privileged IPC schema is registered/);
  assert.throws(() => validateChannelArguments(IPC.journalReconcile, [{ operationId: "op-1" }]), /Invalid arguments/);
  assert.deepEqual(
    validateChannelArguments(IPC.journalReconcile,
      [{ operationId: "op-1", verdict: "applied", actor: "reviewer", evidenceRef: "build/evidence.json" }]),
    [{ operationId: "op-1", verdict: "applied", actor: "reviewer", evidenceRef: "build/evidence.json" }],
  );
});
