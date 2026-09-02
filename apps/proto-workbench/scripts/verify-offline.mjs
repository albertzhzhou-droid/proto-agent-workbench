import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TEST_FILES = 256;
const MAX_COMPILER_FILES = 256;
const MAX_COMPILER_FILE_BYTES = 16 * 1024 * 1024;
const MAX_COMPILER_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_COMPILER_TREE_DEPTH = 8;
const MAX_COMPILER_RELATIVE_PATH = 512;
const COMMAND_TIMEOUT_MS = 10 * 60_000;

export const PINNED_TYPESCRIPT_PACKAGE = Object.freeze({
  name: "typescript",
  version: "5.9.3",
  integrity: "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
  bin: "./bin/tsc",
  fileCount: 132,
  totalBytes: 23_625_066,
  // Official npm tarball tree, sorted by ordinal relative path. Each record is
  // UTF-8 path, NUL, decimal byte length, NUL, lowercase SHA-256, LF.
  treeSha256: "d9f21ce5082611aef2af206a9eec690ac2b89a7c7ac943e422443071b6cfcf4c",
});

export const OFFLINE_NETWORK_STATUS = Object.freeze({
  externalNetwork: "not-os-isolated",
  jsGuard: "node-net-socket-connect-and-dns-callback-lookup",
  defenseInDepth: true,
});

if (isMainModule()) {
  try {
    const plan = await buildOfflineVerificationPlan(appRoot);
    for (const command of plan.commands) await runBounded(command);
    console.log(JSON.stringify({
      ok: true,
      mode: "offline",
      ...OFFLINE_NETWORK_STATUS,
      packageManagerInvoked: false,
      dependencyVersion: plan.typescriptVersion,
      dependencyIntegrity: plan.typescriptIntegrity,
      dependencyTreeSha256: plan.typescriptTreeSha256,
      testFileCount: plan.testFileCount,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: safeCode(error),
      message: "Offline verification failed closed; path and command details were suppressed.",
    }));
    process.exitCode = 1;
  }
}

export async function buildOfflineVerificationPlan(root) {
  const canonicalRoot = await canonicalDirectory(root, "application root");
  const packageJsonPath = join(canonicalRoot, "package.json");
  const lockPath = join(canonicalRoot, "pnpm-lock.yaml");
  const guardPath = join(canonicalRoot, "scripts", "offline-network-guard.mjs");
  await Promise.all([
    canonicalSingleLinkFile(packageJsonPath, "package manifest"),
    canonicalSingleLinkFile(lockPath, "dependency lock"),
    canonicalSingleLinkFile(guardPath, "offline network guard"),
  ]);

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const lock = await readFile(lockPath, "utf8");
  const declared = packageJson?.devDependencies?.typescript;
  const locked = lockedImporterVersion(lock, "typescript");
  if (typeof declared !== "string") throw new Error("DEPENDENCY_DRIFT");
  const declaredFloor = declared.replace(/^[~^]/, "");
  if (declaredFloor !== locked) throw new Error("DEPENDENCY_DRIFT");

  const initialCompiler = await verifyPinnedTypeScriptPackage(canonicalRoot, lock);
  if (initialCompiler.version !== locked) throw new Error("DEPENDENCY_DRIFT");

  const testsRoot = await canonicalDirectory(join(canonicalRoot, "tests"), "test root");
  const testNames = (await readdir(testsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => entry.name)
    .sort();
  if (!testNames.length || testNames.length > MAX_TEST_FILES) throw new Error("TEST_SET_INVALID");
  const testPaths = [];
  for (const name of testNames) {
    const path = join(testsRoot, name);
    await canonicalSingleLinkFile(path, "test file");
    testPaths.push(path);
  }

  // The pnpm content-addressed store uses hardlinks. Re-hash the complete,
  // exact project-local package after all other plan work so a stale or
  // concurrently changed compiler cannot be returned as verified.
  await canonicalSingleLinkFile(lockPath, "dependency lock");
  const finalLock = await readFile(lockPath, "utf8");
  if (finalLock !== lock) throw new Error("DEPENDENCY_LOCK_CHANGED");
  const compiler = await verifyPinnedTypeScriptPackage(canonicalRoot, finalLock);
  if (compiler.version !== initialCompiler.version || compiler.compilerPath !== initialCompiler.compilerPath) {
    throw new Error("INSTALLED_COMPILER_CHANGED");
  }

  const guardArg = `--import=${pathToFileURL(guardPath).href}`;
  return {
    typescriptVersion: compiler.version,
    typescriptIntegrity: compiler.integrity,
    typescriptTreeSha256: compiler.treeSha256,
    typescriptFileCount: compiler.fileCount,
    typescriptTotalBytes: compiler.totalBytes,
    testFileCount: testPaths.length,
    commands: [
      {
        executable: process.execPath,
        args: [guardArg, "--experimental-strip-types", "--test", ...testPaths],
        cwd: canonicalRoot,
      },
      {
        executable: process.execPath,
        args: [guardArg, compiler.compilerPath, "--noEmit"],
        cwd: canonicalRoot,
        preflight: { type: "pinned-typescript", lockPath },
      },
    ],
  };
}

export async function verifyPinnedTypeScriptPackage(root, lock) {
  const canonicalRoot = resolve(root);
  const expected = PINNED_TYPESCRIPT_PACKAGE;
  if (typeof lock !== "string") throw new Error("DEPENDENCY_LOCK_MISSING");
  const lockedVersion = lockedImporterVersion(lock, expected.name);
  const lockedIntegrity = lockedPackageIntegrity(lock, expected.name, lockedVersion);
  if (lockedVersion !== expected.version || lockedIntegrity !== expected.integrity) {
    throw new Error("INSTALLED_COMPILER_LOCK_UNSAFE");
  }

  const packageAlias = join(canonicalRoot, "node_modules", expected.name);
  const expectedPackageRoot = join(
    canonicalRoot,
    "node_modules",
    ".pnpm",
    `${expected.name}@${expected.version}`,
    "node_modules",
    expected.name,
  );
  let aliasInfo;
  let resolvedAlias;
  try {
    aliasInfo = await lstat(packageAlias, { bigint: true });
    resolvedAlias = resolve(await realpath(packageAlias));
  } catch {
    throw new Error("INSTALLED_COMPILER_ROOT_UNSAFE");
  }
  if (!aliasInfo.isSymbolicLink() || aliasInfo.nlink !== 1n || resolvedAlias !== expectedPackageRoot) {
    throw new Error("INSTALLED_COMPILER_ROOT_UNSAFE");
  }

  await canonicalDirectory(expectedPackageRoot, "installed compiler root");
  const manifestPath = join(expectedPackageRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("INSTALLED_COMPILER_MANIFEST_UNSAFE");
  }
  if (
    manifest?.name !== expected.name
    || manifest?.version !== expected.version
    || manifest?.bin?.tsc !== expected.bin
  ) {
    throw new Error("INSTALLED_COMPILER_MANIFEST_UNSAFE");
  }

  // Hash after metadata validation so the content check is the last package
  // filesystem read before the verified command path is returned.
  const tree = await digestCompilerTree(expectedPackageRoot);
  if (
    tree.fileCount !== expected.fileCount
    || tree.totalBytes !== expected.totalBytes
    || tree.treeSha256 !== expected.treeSha256
  ) {
    throw new Error("INSTALLED_COMPILER_INTEGRITY_MISMATCH");
  }

  const compilerPath = resolve(expectedPackageRoot, expected.bin);
  if (compilerPath !== join(expectedPackageRoot, "bin", "tsc")) {
    throw new Error("INSTALLED_COMPILER_ENTRYPOINT_UNSAFE");
  }
  return {
    version: expected.version,
    integrity: expected.integrity,
    packageRoot: expectedPackageRoot,
    compilerPath,
    ...tree,
  };
}

function lockedImporterVersion(lock, dependency) {
  const importer = lock.match(/\n  \.:\n([\s\S]*?)(?=\n  [^\s][^:]*:\n|\npackages:\n)/)?.[1] ?? "";
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = importer.match(new RegExp(`\\n      ['\"]?${escaped}['\"]?:\\n        specifier: [^\\n]+\\n        version: ([^\\s(]+)`));
  if (!match) throw new Error("DEPENDENCY_LOCK_MISSING");
  return match[1].replace(/^['"]|['"]$/g, "");
}

function lockedPackageIntegrity(lock, dependency, version) {
  if (typeof lock !== "string") throw new Error("DEPENDENCY_LOCK_MISSING");
  const target = `${dependency}@${version}`;
  const lines = lock.split(/\r?\n/);
  let inPackages = false;
  let inTarget = false;
  const matches = [];
  for (const line of lines) {
    if (line === "packages:") {
      inPackages = true;
      inTarget = false;
      continue;
    }
    if (!inPackages) continue;
    if (line && !line.startsWith(" ")) break;
    const entry = line.match(/^  (.+):$/);
    if (entry) {
      const key = entry[1].replace(/^(['"])(.*)\1$/, "$2");
      inTarget = key === target;
      continue;
    }
    if (!inTarget) continue;
    const resolution = line.match(/^    resolution: \{integrity: ([^,}\s]+)(?:,[^}]*)?\}$/);
    if (resolution) matches.push(resolution[1]);
  }
  if (matches.length !== 1) throw new Error("DEPENDENCY_LOCK_MISSING");
  return matches[0];
}

async function digestCompilerTree(packageRoot) {
  const files = [];
  let totalBytes = 0;

  async function visit(directory, depth) {
    if (depth > MAX_COMPILER_TREE_DEPTH) throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      let info;
      try {
        info = await lstat(path, { bigint: true });
      } catch {
        throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
      }
      if (info.isSymbolicLink()) throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
      if (info.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");

      const relativePath = relative(packageRoot, path).replaceAll("\\", "/");
      if (
        !relativePath
        || relativePath.startsWith("../")
        || relativePath.length > MAX_COMPILER_RELATIVE_PATH
        || info.size > BigInt(MAX_COMPILER_FILE_BYTES)
      ) {
        throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
      }
      if (files.length >= MAX_COMPILER_FILES) throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
      if (info.size > BigInt(MAX_COMPILER_TOTAL_BYTES - totalBytes)) {
        throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
      }

      let handle;
      try {
        handle = await open(path, "r");
        const opened = await handle.stat({ bigint: true });
        if (!sameFileIdentity(info, opened)) throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (!sameFileIdentity(opened, after) || BigInt(bytes.length) !== opened.size) {
          throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
        }
        const size = bytes.length;
        totalBytes += size;
        files.push({
          path: relativePath,
          size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "INSTALLED_COMPILER_TREE_UNSAFE") throw error;
        throw new Error("INSTALLED_COMPILER_TREE_UNSAFE");
      } finally {
        await handle?.close();
      }
    }
  }

  await visit(packageRoot, 0);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const tree = createHash("sha256");
  for (const file of files) {
    tree.update(file.path);
    tree.update("\0");
    tree.update(String(file.size));
    tree.update("\0");
    tree.update(file.sha256);
    tree.update("\n");
  }
  return {
    fileCount: files.length,
    totalBytes,
    treeSha256: tree.digest("hex"),
  };
}

function sameFileIdentity(left, right) {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function canonicalDirectory(path, label) {
  const requested = resolve(path);
  const info = await lstat(requested, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label.toUpperCase().replaceAll(" ", "_")}_UNSAFE`);
  if (resolve(await realpath(requested)) !== requested) throw new Error(`${label.toUpperCase().replaceAll(" ", "_")}_UNSAFE`);
  return requested;
}

async function canonicalSingleLinkFile(path, label) {
  const requested = resolve(path);
  const info = await lstat(requested, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new Error(`${label.toUpperCase().replaceAll(" ", "_")}_UNSAFE`);
  }
  if (resolve(await realpath(requested)) !== requested) throw new Error(`${label.toUpperCase().replaceAll(" ", "_")}_UNSAFE`);
  return requested;
}

async function runBounded(command) {
  if (command.preflight?.type === "pinned-typescript") {
    const lockPath = await canonicalSingleLinkFile(command.preflight.lockPath, "dependency lock");
    const lock = await readFile(lockPath, "utf8");
    const compiler = await verifyPinnedTypeScriptPackage(
      await canonicalDirectory(command.cwd, "application root"),
      lock,
    );
    if (compiler.compilerPath !== command.args[1]) throw new Error("INSTALLED_COMPILER_CHANGED");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        CI: "1",
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost,::1",
      },
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("OFFLINE_COMMAND_TIMEOUT"));
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error("OFFLINE_COMMAND_FAILED"));
    });
  });
}

function safeCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{2,64}$/.test(value) ? value : "OFFLINE_VERIFICATION_FAILED";
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
