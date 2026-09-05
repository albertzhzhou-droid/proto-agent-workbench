import { spawn } from "node:child_process";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_BYTES = 128 * 1024;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const SPAWN_TIMEOUT_MS = 5_000;
const ownedProcesses = new WeakMap();
const closedProcesses = new WeakSet();
const verifiedWorkspaces = new Map();
export const DISPOSABLE_WORKSPACE_MARKER = "PROTO_AGENT_DISPOSABLE_WORKSPACE_V1\n";

export class OwnedProcessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OwnedProcessError";
    this.code = code;
    this.details = details;
  }
}

export async function spawnOwned(command, args, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new OwnedProcessError("INVALID_OPTIONS", "Owned process options must be an object.");
  }
  const executable = await canonicalRegularFile(command, "command");
  const cwd = await canonicalDirectory(options.cwd, "cwd");
  const safeArgs = validateArguments(args);
  const env = minimalChildEnvironment(options.env);
  const stdio = validateStdio(options.stdio);
  env.TEMP = cwd.path;
  env.TMP = cwd.path;
  env.TMPDIR = cwd.path;

  await revalidatePath(executable, "command");
  await revalidatePath(cwd, "cwd");
  let child;
  try {
    child = spawn(executable.path, safeArgs, {
      cwd: cwd.path,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio,
      shell: false,
    });
  } catch (error) {
    throw processStartError(error);
  }
  observeProcessClose(child);
  const ownership = { pid: child.pid, termination: undefined };
  ownedProcesses.set(child, ownership);
  try {
    await waitForSpawn(child, SPAWN_TIMEOUT_MS);
  } catch (error) {
    try {
      await terminateOwned(child, { gracefulMs: 0, killerTimeoutMs: 1_000 });
    } catch {
      // The process may never have started; preserve the start error.
    }
    throw error;
  }
  ownership.pid = child.pid;
  return child;
}

export async function assertDisposableWorkspace(value, forbiddenRoots = []) {
  const workspace = await canonicalDirectory(value, "disposable workspace");
  for (const rootValue of forbiddenRoots) {
    const root = await canonicalDirectory(rootValue, "protected root");
    if (containsPath(root.path, workspace.path) || containsPath(workspace.path, root.path)) {
      throw new OwnedProcessError(
        "WORKSPACE_OVERLAP",
        "Disposable workspace must not overlap a protected root.",
      );
    }
  }
  const marker = await readWorkspaceMarker(workspace.path);
  await revalidatePath(workspace, "disposable workspace");
  verifiedWorkspaces.set(pathKey(workspace.path), {
    directory: fileIdentity(workspace.info),
    marker: fileIdentity(marker.info),
  });
  return workspace.path;
}

export async function revalidateDisposableWorkspace(value) {
  const requested = validateAbsolutePath(value, "disposable workspace");
  const proof = verifiedWorkspaces.get(pathKey(requested));
  if (!proof) {
    throw new OwnedProcessError("UNVERIFIED_WORKSPACE", "Disposable workspace was not verified.");
  }
  const workspace = await canonicalDirectory(requested, "disposable workspace");
  if (!matchesIdentity(proof.directory, workspace.info)) {
    throw new OwnedProcessError("WORKSPACE_CHANGED", "Disposable workspace identity changed.");
  }
  const marker = await readWorkspaceMarker(workspace.path);
  if (!matchesIdentity(proof.marker, marker.info)) {
    throw new OwnedProcessError("WORKSPACE_MARKER_CHANGED", "Disposable workspace marker changed.");
  }
  return workspace.path;
}

export async function ensureDisposableBuildRoot(value) {
  const workspace = await revalidateDisposableWorkspace(value);
  const buildRoot = join(workspace, "build");
  try {
    await mkdir(buildRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new OwnedProcessError("BUILD_CREATE_FAILED", "Disposable build directory could not be created.");
    }
  }
  const build = await canonicalDirectory(buildRoot, "disposable build root");
  if (!containsPath(workspace, build.path) || samePath(workspace, build.path)) {
    throw new OwnedProcessError("BUILD_ESCAPE", "Disposable build directory escaped its workspace.");
  }
  await revalidateDisposableWorkspace(workspace);
  await revalidatePath(build, "disposable build root");
  return build.path;
}

export async function runJsonOwned(command, args, options = {}) {
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    100,
    MAX_TIMEOUT_MS,
  );
  const maxStdoutBytes = boundedInteger(
    options.maxStdoutBytes ?? DEFAULT_STDOUT_BYTES,
    "maxStdoutBytes",
    1,
    16 * 1024 * 1024,
  );
  const maxStderrBytes = boundedInteger(
    options.maxStderrBytes ?? DEFAULT_STDERR_BYTES,
    "maxStderrBytes",
    1,
    4 * 1024 * 1024,
  );
  if (options.stdio !== undefined) {
    throw new OwnedProcessError("INVALID_STDIO", "runJsonOwned controls its captured stdio.");
  }
  if (options.signal?.aborted) {
    throw new OwnedProcessError("PROCESS_CANCELLED", "Owned process was cancelled before start.");
  }
  const child = await spawnOwned(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      void fail(
        new OwnedProcessError("PROCESS_TIMEOUT", `Owned process exceeded ${timeoutMs} ms.`),
      );
    }, timeoutMs);

    const abort = () => {
      void fail(new OwnedProcessError("PROCESS_CANCELLED", "Owned process was cancelled."));
    };
    const onStdout = (chunk) => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        void fail(
          new OwnedProcessError(
            "STDOUT_LIMIT_EXCEEDED",
            `Owned process stdout exceeded ${maxStdoutBytes} bytes.`,
          ),
        );
        return;
      }
      stdout.push(buffer);
    };
    const onStderr = (chunk) => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxStderrBytes) {
        void fail(
          new OwnedProcessError(
            "STDERR_LIMIT_EXCEEDED",
            `Owned process stderr exceeded ${maxStderrBytes} bytes.`,
          ),
        );
      }
    };
    const onError = (error) => void fail(processStartError(error));
    const onClose = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup(false);
      if (code !== 0) {
        rejectPromise(
          new OwnedProcessError(
            "PROCESS_EXITED",
            "Owned process exited unsuccessfully; captured stderr was suppressed.",
            { code, signal, stderrBytes },
          ),
        );
        return;
      }
      const raw = Buffer.concat(stdout).toString("utf8");
      try {
        resolvePromise(parseBoundedJson(raw));
      } catch (error) {
        rejectPromise(error);
      }
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) queueMicrotask(abort);

    async function fail(error) {
      if (settled) return;
      settled = true;
      cleanup(true);
      try {
        await terminateOwned(child);
      } catch (terminationError) {
        error.details = {
          ...error.details,
          terminationCode: terminationError?.code || "PROCESS_TERMINATION_FAILED",
        };
      } finally {
        rejectPromise(error);
      }
    }

    function cleanup(destroyStreams) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (destroyStreams) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }
  });
}

// Completion joins the owned direct child and its captured streams. A Windows
// tree request is recorded separately; it is not a descendant-handle barrier.
export async function terminateOwned(child, options = {}) {
  const ownership = ownedProcesses.get(child);
  if (!ownership) {
    throw new OwnedProcessError("UNOWNED_PROCESS", "Refusing to terminate a process not created by spawnOwned().");
  }
  if (ownership.termination) return ownership.termination;
  ownership.termination = terminateOwnedOnce(child, ownership, options);
  return ownership.termination;
}

async function terminateOwnedOnce(child, ownership, options) {
  if (!Number.isInteger(ownership.pid) || ownership.pid <= 0 || child.pid !== ownership.pid) return;

  const gracefulMs = boundedInteger(options.gracefulMs ?? 750, "gracefulMs", 0, 5_000);
  const killerTimeoutMs = boundedInteger(
    options.killerTimeoutMs ?? 5_000,
    "killerTimeoutMs",
    100,
    15_000,
  );
  // A direct child can exit while a descendant still holds inherited stdio.
  // Keep its original identity and join close; never retarget its former PID.
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!(await waitForExit(child, killerTimeoutMs))) {
      throw new OwnedProcessError("PROCESS_STREAM_CLOSE_TIMEOUT", "Exited owned process did not close its streams in time.");
    }
    return terminationReceipt();
  }
  if (process.platform === "win32") {
    return terminateWindowsTree(child, ownership, killerTimeoutMs);
  }

  signalOwnedGroup(ownership.pid, "SIGTERM", child);
  if (await waitForExit(child, gracefulMs)) return terminationReceipt();
  signalOwnedGroup(ownership.pid, "SIGKILL", child);
  if (!(await waitForExit(child, killerTimeoutMs))) {
    throw new OwnedProcessError("PROCESS_TERMINATION_FAILED", "Owned process did not exit after termination.");
  }
  return terminationReceipt();
}

function terminationReceipt(windowsTreeRequest = null) {
  return {
    scope: "owned-direct-child-and-captured-streams",
    directChildClosed: true,
    descendantsVerified: false,
    windowsTreeRequest,
  };
}

export function minimalChildEnvironment(extra = {}) {
  if (extra === null || typeof extra !== "object" || Array.isArray(extra)) {
    throw new OwnedProcessError("INVALID_ENV", "Child environment additions must be an object.");
  }
  // Windows command resolution may fall back to the parent's PATH when PATH is
  // omitted entirely, even with an explicit env object. An explicit empty value
  // prevents that ambient search path from becoming visible to the child.
  const env = { LANG: "C", LC_ALL: "C", TZ: "UTC", PATH: "" };
  const systemRoot = trustedSystemRootSyntax();
  if (systemRoot) {
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
    env.SystemDrive = parse(systemRoot).root.slice(0, 2);
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      throw new OwnedProcessError("INVALID_ENV_NAME", `Invalid child environment name: ${name}`);
    }
    if (isDangerousEnvironmentName(name)) {
      throw new OwnedProcessError("FORBIDDEN_ENV", `Refusing dangerous child environment variable: ${name}`);
    }
    if (typeof value !== "string" || value.length > 32_768 || value.includes("\0")) {
      throw new OwnedProcessError("INVALID_ENV_VALUE", `Invalid child environment value: ${name}`);
    }
    env[name] = value;
  }
  return env;
}

function parseBoundedJson(raw) {
  if (!raw.trim()) {
    throw new OwnedProcessError("EMPTY_JSON", "Owned process returned no JSON.");
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new OwnedProcessError("INVALID_JSON", "Owned process returned invalid JSON.");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OwnedProcessError("INVALID_JSON_ROOT", "Owned process JSON root must be an object.");
  }
  return payload;
}

async function canonicalRegularFile(value, label) {
  const requested = validateAbsolutePath(value, label);
  let info;
  try {
    info = await lstat(requested, { bigint: true });
  } catch {
    throw new OwnedProcessError("UNSAFE_EXECUTABLE", `${label} must be a readable regular file.`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new OwnedProcessError("UNSAFE_EXECUTABLE", `${label} must be a regular, single-link file.`);
  }
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch {
    throw new OwnedProcessError("UNSAFE_EXECUTABLE", `${label} could not be canonicalized.`);
  }
  if (!samePath(requested, canonical)) {
    throw new OwnedProcessError("UNSAFE_EXECUTABLE", `${label} must not traverse a link or junction.`);
  }
  const canonicalInfo = await lstat(canonical, { bigint: true });
  if (!sameFileIdentity(info, canonicalInfo)) {
    throw new OwnedProcessError("PATH_CHANGED", `${label} changed while it was being verified.`);
  }
  let handle;
  try {
    handle = await open(canonical, "r");
    if (!sameFileIdentity(info, await handle.stat({ bigint: true }))) {
      throw new OwnedProcessError("PATH_CHANGED", `${label} changed while it was being opened.`);
    }
  } finally {
    await handle?.close();
  }
  return { path: canonical, info: canonicalInfo, kind: "file" };
}

async function canonicalDirectory(value, label) {
  const requested = validateAbsolutePath(value, label);
  let info;
  try {
    info = await lstat(requested, { bigint: true });
  } catch {
    throw new OwnedProcessError("UNSAFE_DIRECTORY", `${label} must be a readable directory.`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new OwnedProcessError("UNSAFE_DIRECTORY", `${label} must be a non-link directory.`);
  }
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch {
    throw new OwnedProcessError("UNSAFE_DIRECTORY", `${label} could not be canonicalized.`);
  }
  if (!samePath(requested, canonical)) {
    throw new OwnedProcessError("UNSAFE_DIRECTORY", `${label} must not traverse a link or junction.`);
  }
  const canonicalInfo = await lstat(canonical, { bigint: true });
  if (!sameFileIdentity(info, canonicalInfo)) {
    throw new OwnedProcessError("PATH_CHANGED", `${label} changed while it was being verified.`);
  }
  return { path: canonical, info: canonicalInfo, kind: "directory" };
}

async function revalidatePath(state, label) {
  const current = state.kind === "file"
    ? await canonicalRegularFile(state.path, label)
    : await canonicalDirectory(state.path, label);
  if (!sameFileIdentity(state.info, current.info)) {
    throw new OwnedProcessError("PATH_CHANGED", `${label} identity changed after verification.`);
  }
  return current.path;
}

async function readWorkspaceMarker(workspace) {
  const markerPath = join(workspace, ".proto-agent-disposable-workspace");
  let before;
  try {
    before = await lstat(markerPath, { bigint: true });
  } catch {
    throw new OwnedProcessError("INVALID_WORKSPACE_MARKER", "Disposable workspace marker is missing.");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size !== BigInt(Buffer.byteLength(DISPOSABLE_WORKSPACE_MARKER, "utf8"))
  ) {
    throw new OwnedProcessError("INVALID_WORKSPACE_MARKER", "Disposable workspace marker is unsafe.");
  }
  const canonicalMarker = await realpath(markerPath);
  if (!samePath(markerPath, canonicalMarker)) {
    throw new OwnedProcessError("INVALID_WORKSPACE_MARKER", "Disposable workspace marker traverses a link.");
  }
  let handle;
  try {
    handle = await open(canonicalMarker, "r");
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, opened) || opened.nlink !== 1n) {
      throw new OwnedProcessError("INVALID_WORKSPACE_MARKER", "Disposable workspace marker changed.");
    }
    const content = await handle.readFile();
    if (!content.equals(Buffer.from(DISPOSABLE_WORKSPACE_MARKER, "utf8"))) {
      throw new OwnedProcessError("INVALID_WORKSPACE_MARKER", "Disposable workspace marker is invalid.");
    }
    const after = await lstat(markerPath, { bigint: true });
    if (!sameFileIdentity(opened, after) || !samePath(markerPath, await realpath(markerPath))) {
      throw new OwnedProcessError("INVALID_WORKSPACE_MARKER", "Disposable workspace marker changed.");
    }
    return { path: canonicalMarker, info: after };
  } finally {
    await handle?.close();
  }
}

function validateArguments(args) {
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) {
    throw new OwnedProcessError("INVALID_ARGUMENTS", `Expected at most ${MAX_ARGUMENTS} arguments.`);
  }
  let bytes = 0;
  return args.map((value) => {
    if (typeof value !== "string" || value.includes("\0")) {
      throw new OwnedProcessError("INVALID_ARGUMENT", "Process arguments must be NUL-free strings.");
    }
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new OwnedProcessError("ARGUMENT_LIMIT_EXCEEDED", "Process arguments exceed the byte budget.");
    }
    return value;
  });
}

function validateStdio(value) {
  const stdio = value ?? ["ignore", "pipe", "pipe"];
  if (
    !Array.isArray(stdio) ||
    stdio.length !== 3 ||
    !["ignore", "pipe"].includes(stdio[0]) ||
    stdio[1] !== "pipe" ||
    stdio[2] !== "pipe"
  ) {
    throw new OwnedProcessError(
      "INVALID_STDIO",
      "Owned processes require captured stdout/stderr and ignored or piped stdin.",
    );
  }
  return [...stdio];
}

function validateAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw new OwnedProcessError("INVALID_PATH", `${label} must be a bounded absolute path.`);
  }
  return resolve(value);
}

function fileIdentity(info) {
  if (typeof info.dev !== "bigint" || typeof info.ino !== "bigint" || info.ino <= 0n) {
    throw new OwnedProcessError("UNSTABLE_FILE_IDENTITY", "Filesystem did not provide a stable identity.");
  }
  return { dev: info.dev, ino: info.ino };
}

function matchesIdentity(identity, info) {
  return identity.dev === info.dev && identity.ino === info.ino && info.ino > 0n;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.ino > 0n;
}

function isDangerousEnvironmentName(name) {
  const blocked = new Set([
    "APPDATA", "BASH_ENV", "CLASSPATH", "COMSPEC", "ELECTRON_RUN_AS_NODE", "ENV",
    "HOME", "JAVA_TOOL_OPTIONS", "LOCALAPPDATA", "NODE_OPTIONS", "PATH", "PATHEXT",
    "PERL5OPT", "PYTHONHOME", "PYTHONPATH", "R_ENVIRON", "R_PROFILE", "RUBYOPT",
    "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "WINDIR",
    "ZDOTDIR", "_JAVA_OPTIONS",
  ]);
  return blocked.has(name) || /^(?:DYLD_|LD_|NODE_|PYTHON|ELECTRON_|GIT_|SSH_)/.test(name);
}

function trustedSystemRootSyntax() {
  if (process.platform !== "win32") return undefined;
  const values = [process.env.SystemRoot, process.env.WINDIR]
    .filter((value) => typeof value === "string")
    .map((value) => resolve(value));
  if (!values.length || values.some((value) => !samePath(value, values[0]))) return undefined;
  return /^[A-Za-z]:\\Windows$/i.test(values[0]) ? values[0] : undefined;
}

async function terminateWindowsTree(child, ownership, timeoutMs) {
  const request = {
    attempted: false, status: "not-requested", exitCode: null, signalCode: null,
    stdout: "", stderr: "", outputTruncated: false, errorCode: null,
    helperClosed: false, directChildFallback: null,
  };
  let taskkill;
  try {
    taskkill = await trustedTaskkillPath();
  } catch (error) {
    taskkill = undefined;
    request.status = "unavailable";
    request.errorCode = error?.code ?? "UNKNOWN";
  }
  if (taskkill && child.pid === ownership.pid && child.exitCode === null && child.signalCode === null) {
    let killer;
    const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const capture = (name, chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = 4_096 - output[name].length;
      if (bytes.length > remaining) request.outputTruncated = true;
      if (remaining > 0) output[name] = Buffer.concat([output[name], bytes.subarray(0, remaining)]);
    };
    try {
      request.attempted = true;
      killer = spawn(taskkill, ["/PID", String(ownership.pid), "/T", "/F"], {
        env: minimalChildEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      observeProcessClose(killer);
      killer.stdout.on("data", (chunk) => capture("stdout", chunk));
      killer.stderr.on("data", (chunk) => capture("stderr", chunk));
      await waitForSpawn(killer, 2_000);
      const completed = await waitForExit(killer, timeoutMs);
      request.status = completed ? (killer.exitCode === 0 ? "succeeded" : "failed") : "timed-out";
      if (!completed && killer.exitCode === null && killer.signalCode === null) killer.kill("SIGKILL");
    } catch (error) {
      request.status = "failed";
      request.errorCode = error?.code ?? "UNKNOWN";
      if (killer?.exitCode === null && killer?.signalCode === null) killer.kill("SIGKILL");
    } finally {
      request.helperClosed = killer ? await waitForExit(killer, Math.min(timeoutMs, 1_000)) : true;
      request.exitCode = killer?.exitCode ?? null;
      request.signalCode = killer?.signalCode ?? null;
      request.stdout = output.stdout.toString("utf8");
      request.stderr = output.stderr.toString("utf8");
    }
  }
  if (child.pid === ownership.pid && child.exitCode === null && child.signalCode === null) {
    try {
      request.directChildFallback = "SIGKILL";
      child.kill("SIGKILL");
    } catch {
      // The final wait distinguishes an already-exited child from failure.
    }
  }
  if (!(await waitForExit(child, timeoutMs))) {
    throw new OwnedProcessError("PROCESS_TERMINATION_FAILED", "Owned process did not exit after termination.", { windowsTreeRequest: request });
  }
  if (request.attempted && !request.helperClosed) {
    throw new OwnedProcessError("PROCESS_TREE_REQUEST_CLOSE_TIMEOUT", "Owned tree request did not close its streams in time.", { windowsTreeRequest: request });
  }
  return terminationReceipt(request);
}

async function trustedTaskkillPath() {
  const systemRoot = trustedSystemRootSyntax();
  if (!systemRoot) throw new OwnedProcessError("UNTRUSTED_SYSTEM_ROOT", "Windows system root is unavailable.");
  const root = await canonicalDirectory(systemRoot, "Windows system root");
  if (basename(root.path).toLowerCase() !== "windows" || !samePath(dirname(root.path), parse(root.path).root)) {
    throw new OwnedProcessError("UNTRUSTED_SYSTEM_ROOT", "Windows system root is not trusted.");
  }
  const system32 = await canonicalDirectory(join(root.path, "System32"), "Windows system directory");
  const taskkill = join(system32.path, "taskkill.exe");
  const info = await lstat(taskkill);
  const canonical = await realpath(taskkill);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(taskkill, canonical) || !samePath(dirname(canonical), system32.path)) {
    throw new OwnedProcessError("UNTRUSTED_SYSTEM_TOOL", "Windows taskkill executable is not trusted.");
  }
  return canonical;
}

function signalOwnedGroup(pid, signal, child) {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function waitForSpawn(child, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new OwnedProcessError("PROCESS_START_TIMEOUT", "Owned process did not start in time."));
    }, timeoutMs);
    const spawned = () => {
      cleanup();
      resolvePromise();
    };
    const failed = (error) => {
      cleanup();
      rejectPromise(processStartError(error));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("spawn", spawned);
      child.removeListener("error", failed);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

function observeProcessClose(child) {
  child.once("close", () => closedProcesses.add(child));
}

function waitForExit(child, timeoutMs) {
  if (closedProcesses.has(child)) return Promise.resolve(true);
  if (timeoutMs === 0) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(false);
    }, timeoutMs);
    const done = () => {
      cleanup();
      resolvePromise(true);
    };
    // A spawn/kill error is not proof of exit; close or the deadline settles it.
    const onError = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("close", done);
      child.removeListener("error", onError);
    };
    child.once("close", done);
    child.on("error", onError);
  });
}

function processStartError(error) {
  const osCode = typeof error?.code === "string" ? error.code : "UNKNOWN";
  return new OwnedProcessError(
    "PROCESS_START_FAILED",
    `Owned process could not be started (${osCode}); path details were suppressed.`,
    { osCode },
  );
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new OwnedProcessError("INVALID_LIMIT", `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function pathKey(value) {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function containsPath(root, candidate) {
  const delta = relative(root, candidate);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}
