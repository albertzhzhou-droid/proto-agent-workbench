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
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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

test("owned termination joins inherited stdio after the direct child has exited", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "proto-owned-close-"));
  const releasePath = join(workspace, "release");
  const descendantCode = [
    "const fs=require('node:fs');",
    "process.stdout.write('descendant-ready');",
    "const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},5);",
    "setTimeout(()=>process.exit(0),5000);",
  ].join("");
  const childCode = [
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)},process.argv[1]],{windowsHide:true,stdio:['ignore','pipe','inherit']});`,
    "child.stdout.once('data',data=>{process.stdout.write(data);process.exit(0)});",
    "setTimeout(()=>process.exit(1),5000);",
  ].join("");
  let child;
  try {
    child = await spawnOwned(process.execPath, ["-e", childCode, releasePath], { cwd: workspace });
    const close = once(child, "close");
    await once(child, "exit");
    assert.equal(child.stderr.closed, false, "the bounded descendant still holds the inherited pipe");
    let settled = false;
    const termination = terminateOwned(child).then(() => { settled = true; });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(settled, false, "exit alone must not claim that owned stdio is closed");
    await writeFile(releasePath, "release");
    await termination;
    await close;
    assert.equal(child.stderr.closed, true);
  } finally {
    await writeFile(releasePath, "release");
    if (child) {
      const closed = child.stderr.closed ? Promise.resolve() : once(child, "close");
      if (child.exitCode === null && child.signalCode === null) await terminateOwned(child);
      await closed;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test("owned tree termination is idempotent and stops a bounded descendant", async (context) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "proto-owned-tree-"));
  const pidPath = join(workspace, "descendant.pid");
  const nonce = randomUUID();
  const startedAt = new Date().toISOString();
  const childCode = [
    "const {spawn}=require('node:child_process');",
    "const code=\"require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,ppid:process.ppid,exe:process.execPath,cwd:process.cwd(),nonce:process.argv[2]}));setTimeout(()=>process.exit(0),20000)\";",
    "spawn(process.execPath,['-e',code,process.argv[1],process.argv[2]],{windowsHide:true,stdio:'ignore'});",
    "setTimeout(()=>process.exit(0),22000);",
  ].join("");
  let child;
  let observer;
  let observerClosed;
  let observerOutput = "";
  let nativeResult;
  let descendantPid;
  const receiptPath = join(workspace, "termination-receipt.json");
  const observerResultPath = join(workspace, "native-exit-result.json");
  const errors = [];
  try {
    child = await spawnOwned(process.execPath, ["-e", childCode, pidPath, nonce], { cwd: workspace });
    const ready = JSON.parse(await readEventually(pidPath, 2_000));
    descendantPid = ready.pid;
    assert.equal(Number.isInteger(descendantPid) && descendantPid > 0, true);
    assert.deepEqual(ready, { pid: descendantPid, ppid: child.pid, exe: process.execPath, cwd: workspace, nonce });
    assert.equal(await pidIsAlive(descendantPid), true, "the descendant acknowledged startup before termination");
    if (process.platform === "win32") {
      const observerReadyPath = join(workspace, "native-handles-ready.json");
      const bindingPath = join(workspace, "native-handle-binding.json");
      await writeFile(bindingPath, JSON.stringify({
        parentPid: child.pid, descendantPid, executable: process.execPath, workspace,
        descendantReadyPath: pidPath, nonce, startedAt, observerReadyPath, observerResultPath,
      }));
      // This fixed Windows system observer is deliberately not an owned CLI
      // executable: the OS PowerShell binary is legitimately hardlinked.
      observer = spawn(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(appRoot, "tests", "helpers", "hold-owned-descendant.ps1"), "-BindingPath", bindingPath],
        // The fixture parent and descendant retain the original temp cwd.
        // The read-only observer must not add its own cwd handle to that fixture.
        {
          cwd: appRoot, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
          env: { ...minimalChildEnvironment(), TEMP: tmpdir(), TMP: tmpdir() },
        },
      );
      const captureObserver = (chunk) => { observerOutput = (observerOutput + chunk.toString()).slice(0, 8_192); };
      observer.stdout.on("data", captureObserver);
      observer.stderr.on("data", captureObserver);
      observerClosed = once(observer, "close");
      observerClosed.catch(() => {});
      let nativeReady;
      try { nativeReady = JSON.parse(await readEventually(observerReadyPath, 6_000)); }
      catch (error) { throw new Error(`${error.message} Native observer output: ${observerOutput}`, { cause: error }); }
      assert.equal(nativeReady.descendant.pid, descendantPid);
      assert.equal(nativeReady.parent.pid, child.pid);
      assert.equal(nativeReady.descendantInitialWait, 258, "the held descendant object must be unsignaled before termination");
    }
    const [first, repeated] = await Promise.all([terminateOwned(child), terminateOwned(child)]);
    assert.strictEqual(first, repeated, "idempotent calls return the same completion receipt");
    await writeFile(receiptPath, JSON.stringify(first, null, 2));
    assert.equal(first.scope, "owned-direct-child-and-captured-streams");
    assert.equal(first.directChildClosed, true);
    assert.equal(first.descendantsVerified, false, "the generic helper must not claim a descendant-handle join");
    if (process.platform === "win32") {
      const request = first.windowsTreeRequest;
      assert.equal(request.attempted, true);
      assert.equal(request.helperClosed, true);
      assert.equal(request.status, request.exitCode === 0 ? "succeeded" : "failed");
      assert.equal(typeof request.stdout, "string");
      assert.equal(typeof request.stderr, "string");
      assert.ok(Buffer.byteLength(request.stdout) <= 4_098 && Buffer.byteLength(request.stderr) <= 4_098);
      if (request.exitCode !== 0) assert.ok(request.stderr || request.stdout || request.errorCode, "tree-request failure must retain diagnostic evidence");
      const [observerCode] = await observerClosed;
      nativeResult = JSON.parse(await readFile(observerResultPath, "utf8"));
      assert.equal(observerCode, 0, JSON.stringify(nativeResult));
      assert.equal(nativeResult.descendantFinalWait, 0, "the original descendant process object must be signaled before cleanup");
      assert.equal(nativeResult.parentFinalWait, 0);
      assert.equal(nativeResult.handlesClosed, true);
      context.diagnostic(JSON.stringify({ windowsTreeRequest: request, nativeExit: nativeResult }));
    }
    assert.equal(await pidIsAlive(descendantPid), false);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      if (child) await terminateOwned(child);
    } catch (error) {
      if (!errors.includes(error)) errors.push(error);
    }
    if (observerClosed && !nativeResult) {
      try {
        await observerClosed;
        nativeResult = JSON.parse(await readFile(observerResultPath, "utf8"));
      } catch (error) { errors.push(error); }
    }
    try {
      if (process.platform === "win32" && descendantPid && (!nativeResult?.ok || !nativeResult?.handlesClosed)) {
        throw new Error(`Native descendant exit was not verified; fixture preserved at ${workspace}`);
      }
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Owned tree verification and cleanup failed; all failures are preserved.");
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
