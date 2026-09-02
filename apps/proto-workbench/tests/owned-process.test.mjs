import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  OwnedProcessError,
  DISPOSABLE_WORKSPACE_MARKER,
  assertDisposableWorkspace,
  ensureDisposableBuildRoot,
  minimalChildEnvironment,
  revalidateDisposableWorkspace,
  runJsonOwned,
  spawnOwned,
  terminateOwned,
} from "../scripts/owned-process.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("disposable workspace requires an exact marker and cannot overlap protected roots", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "proto-owned-process-"));
  try {
    await assert.rejects(
      assertDisposableWorkspace(workspace, [appRoot]),
      (error) => error instanceof OwnedProcessError && error.code === "INVALID_WORKSPACE_MARKER",
    );
    await writeFile(
      resolve(workspace, ".proto-agent-disposable-workspace"),
      DISPOSABLE_WORKSPACE_MARKER,
      { encoding: "utf8", flag: "wx" },
    );
    assert.equal(await assertDisposableWorkspace(workspace, [appRoot]), workspace);
    await assert.rejects(
      assertDisposableWorkspace(appRoot, [appRoot]),
      (error) => error instanceof OwnedProcessError && error.code === "WORKSPACE_OVERLAP",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("minimal child environments omit ambient secrets and reject interpreter injection", () => {
  const previous = process.env.PROTO_AGENT_TEST_SECRET;
  process.env.PROTO_AGENT_TEST_SECRET = "must-not-cross";
  try {
    const env = minimalChildEnvironment({ PROTO_AGENT_TEST_VALUE: "fixture" });
    assert.equal(env.PROTO_AGENT_TEST_SECRET, undefined);
    assert.equal(env.PROTO_AGENT_TEST_VALUE, "fixture");
    assert.throws(
      () => minimalChildEnvironment({ NODE_OPTIONS: "--require=payload.js" }),
      (error) => error instanceof OwnedProcessError && error.code === "FORBIDDEN_ENV",
    );
    for (const name of ["PATH", "COMSPEC", "TEMP", "LD_PRELOAD", "PYTHONINSPECT"]) {
      assert.throws(
        () => minimalChildEnvironment({ [name]: "attacker-controlled" }),
        (error) => error instanceof OwnedProcessError && error.code === "FORBIDDEN_ENV",
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PROTO_AGENT_TEST_SECRET;
    else process.env.PROTO_AGENT_TEST_SECRET = previous;
  }
});

test("owned JSON process accepts bounded object output", async () => {
  const payload = await runJsonOwned(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({ok:true,value:7}))"],
    { cwd: appRoot, timeoutMs: 5_000, maxStdoutBytes: 1_024 },
  );
  assert.deepEqual(payload, { ok: true, value: 7 });
});

test("owned child receives a deterministic temp root and no ambient secret or PATH", async () => {
  const previous = process.env.PROTO_AGENT_TEST_SECRET;
  process.env.PROTO_AGENT_TEST_SECRET = "must-not-cross";
  try {
    const payload = await runJsonOwned(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({secret:process.env.PROTO_AGENT_TEST_SECRET,path:process.env.PATH,temp:process.env.TEMP}))",
      ],
      { cwd: appRoot, timeoutMs: 5_000, maxStdoutBytes: 32 * 1024 },
    );
    assert.equal(payload.secret, undefined);
    assert.equal(payload.path, "");
    assert.equal(payload.temp.toLowerCase(), appRoot.toLowerCase());
  } finally {
    if (previous === undefined) delete process.env.PROTO_AGENT_TEST_SECRET;
    else process.env.PROTO_AGENT_TEST_SECRET = previous;
  }
});

test("owned JSON process terminates output overflow", async () => {
  await assert.rejects(
    runJsonOwned(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2048))"],
      { cwd: appRoot, timeoutMs: 5_000, maxStdoutBytes: 64 },
    ),
    (error) => error instanceof OwnedProcessError && error.code === "STDOUT_LIMIT_EXCEEDED",
  );
});

test("owned JSON process terminates at its deadline", async () => {
  await assert.rejects(
    runJsonOwned(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: appRoot, timeoutMs: 100, maxStdoutBytes: 64 },
    ),
    (error) => error instanceof OwnedProcessError && error.code === "PROCESS_TIMEOUT",
  );
});

test("owned process refuses relative executables", async () => {
  await assert.rejects(
    runJsonOwned("node", ["-e", "process.stdout.write('{}')"], { cwd: appRoot }),
    (error) => error instanceof OwnedProcessError && error.code === "INVALID_PATH",
  );
});

test("owned JSON process suppresses captured stderr on failure", async () => {
  const sentinel = "PROTO_PRIVATE_STDERR_SENTINEL";
  await assert.rejects(
    runJsonOwned(
      process.execPath,
      ["-e", `process.stderr.write(${JSON.stringify(sentinel)});process.exit(7)`],
      { cwd: appRoot, timeoutMs: 5_000, maxStdoutBytes: 64, maxStderrBytes: 1_024 },
    ),
    (error) => {
      assert.equal(error.code, "PROCESS_EXITED");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(JSON.stringify(error.details).includes(sentinel), false);
      return true;
    },
  );
});

test("pre-aborted calls and inherited stdio fail before execution", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runJsonOwned(process.execPath, ["-e", "process.stdout.write('{}')"], {
      cwd: appRoot,
      signal: controller.signal,
    }),
    (error) => error instanceof OwnedProcessError && error.code === "PROCESS_CANCELLED",
  );
  await assert.rejects(
    runJsonOwned(process.execPath, ["-e", "process.stdout.write('{}')"], {
      cwd: appRoot,
      stdio: "inherit",
    }),
    (error) => error instanceof OwnedProcessError && error.code === "INVALID_STDIO",
  );
});

test("workspace revalidation detects marker and parent-directory replacement", async () => {
  const suiteRoot = await mkdtemp(resolve(tmpdir(), "proto-workspace-identity-"));
  const workspace = join(suiteRoot, "workspace");
  const movedWorkspace = join(suiteRoot, "workspace-moved");
  try {
    await mkdir(workspace);
    const marker = join(workspace, ".proto-agent-disposable-workspace");
    await writeFile(marker, DISPOSABLE_WORKSPACE_MARKER, { flag: "wx" });
    await assertDisposableWorkspace(workspace);
    await rename(marker, `${marker}.old`);
    await writeFile(marker, DISPOSABLE_WORKSPACE_MARKER, { flag: "wx" });
    await assert.rejects(
      revalidateDisposableWorkspace(workspace),
      (error) => error instanceof OwnedProcessError && error.code === "WORKSPACE_MARKER_CHANGED",
    );

    await rm(marker);
    await rename(`${marker}.old`, marker);
    await assertDisposableWorkspace(workspace);
    await rename(workspace, movedWorkspace);
    await mkdir(workspace);
    await writeFile(join(workspace, ".proto-agent-disposable-workspace"), DISPOSABLE_WORKSPACE_MARKER);
    await assert.rejects(
      revalidateDisposableWorkspace(workspace),
      (error) => error instanceof OwnedProcessError && error.code === "WORKSPACE_CHANGED",
    );
  } finally {
    await rm(suiteRoot, { recursive: true, force: true });
  }
});

test("hardlinked markers and linked build roots are rejected", async (t) => {
  const suiteRoot = await mkdtemp(resolve(tmpdir(), "proto-workspace-links-"));
  const workspace = join(suiteRoot, "workspace");
  try {
    await mkdir(workspace);
    const sourceMarker = join(suiteRoot, "marker-source");
    const marker = join(workspace, ".proto-agent-disposable-workspace");
    await writeFile(sourceMarker, DISPOSABLE_WORKSPACE_MARKER, { flag: "wx" });
    await link(sourceMarker, marker);
    await assert.rejects(
      assertDisposableWorkspace(workspace),
      (error) => error instanceof OwnedProcessError && error.code === "INVALID_WORKSPACE_MARKER",
    );
    await rm(marker);
    await writeFile(marker, DISPOSABLE_WORKSPACE_MARKER, { flag: "wx" });
    await assertDisposableWorkspace(workspace);
    const outsideBuild = join(suiteRoot, "outside-build");
    await mkdir(outsideBuild);
    try {
      await symlink(outsideBuild, join(workspace, "build"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.diagnostic("Platform did not permit a temporary link; hardlink coverage still ran.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      ensureDisposableBuildRoot(workspace),
      (error) => error instanceof OwnedProcessError && error.code === "UNSAFE_DIRECTORY",
    );
  } finally {
    await rm(suiteRoot, { recursive: true, force: true });
  }
});

test("only actual owned child objects can be terminated", async () => {
  await assert.rejects(
    terminateOwned({ __protoOwnedProcess: true, pid: 4, exitCode: null, signalCode: null }),
    (error) => error instanceof OwnedProcessError && error.code === "UNOWNED_PROCESS",
  );
});

test("owned tree termination is idempotent and stops a bounded descendant", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "proto-owned-tree-"));
  const pidPath = join(workspace, "descendant.pid");
  const childCode = [
    "const {spawn}=require('node:child_process');",
    "const fs=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),5000)'],{stdio:'ignore'});",
    "fs.writeFileSync(process.argv[1],String(child.pid));",
    "setTimeout(()=>process.exit(0),5000);",
  ].join("");
  let child;
  try {
    child = await spawnOwned(process.execPath, ["-e", childCode, pidPath], { cwd: workspace });
    const descendantPid = Number(await readEventually(pidPath, 2_000));
    assert.equal(Number.isInteger(descendantPid) && descendantPid > 0, true);
    await Promise.all([terminateOwned(child), terminateOwned(child)]);
    assert.equal(await pidIsAlive(descendantPid), false);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) await terminateOwned(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

async function readEventually(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("Timed out waiting for bounded descendant pid fixture.");
}

async function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
