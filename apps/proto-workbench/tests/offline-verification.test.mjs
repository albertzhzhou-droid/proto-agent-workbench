import assert from "node:assert/strict";
import dns from "node:dns";
import net from "node:net";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OFFLINE_NETWORK_STATUS,
  PINNED_TYPESCRIPT_PACKAGE,
  buildOfflineVerificationPlan,
  verifyPinnedTypeScriptPackage,
} from "../scripts/verify-offline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("offline verification uses only the current Node runtime and pinned local compiler", async () => {
  const plan = await buildOfflineVerificationPlan(root);
  assert.equal(plan.typescriptVersion, "5.9.3");
  assert.equal(plan.typescriptIntegrity, PINNED_TYPESCRIPT_PACKAGE.integrity);
  assert.equal(plan.typescriptTreeSha256, PINNED_TYPESCRIPT_PACKAGE.treeSha256);
  assert.equal(plan.typescriptFileCount, PINNED_TYPESCRIPT_PACKAGE.fileCount);
  assert.equal(plan.typescriptTotalBytes, PINNED_TYPESCRIPT_PACKAGE.totalBytes);
  assert.deepEqual(OFFLINE_NETWORK_STATUS, {
    externalNetwork: "not-os-isolated",
    jsGuard: "node-net-socket-connect-and-dns-callback-lookup",
    defenseInDepth: true,
  });
  assert.ok(plan.testFileCount > 0);
  assert.equal(plan.commands.length, 2);
  for (const command of plan.commands) {
    assert.equal(command.executable, process.execPath);
    assert.ok(command.args.some((argument) => argument.startsWith("--import=file:")));
    assert.equal(command.args.some((argument) => /(?:^|[\\/])(?:pnpm|npm|npx)(?:\.cmd|\.exe)?$/i.test(argument)), false);
  }
  assert.ok(plan.commands[1].args.some((argument) => /node_modules[\\/]\.pnpm[\\/]typescript@5\.9\.3[\\/]node_modules[\\/]typescript[\\/]bin[\\/]tsc$/i.test(argument)));
  assert.equal(plan.commands[1].preflight?.type, "pinned-typescript");
});

test("Node TCP guard blocks positional external hosts through Socket and net helpers", async () => {
  const realConnect = net.Socket.prototype.connect;
  const realLookup = dns.lookup;
  let originalCalls = 0;
  net.Socket.prototype.connect = function sentinelConnect() {
    originalCalls += 1;
    return this;
  };
  try {
    await import(`../scripts/offline-network-guard.mjs?overload-regression=${Date.now()}`);
    const externalHost = "203.0.113.10";
    assert.throws(() => new net.Socket().connect(443, externalHost), /EXTERNAL_NETWORK_BLOCKED/);
    assert.throws(() => net.connect(443, externalHost), /EXTERNAL_NETWORK_BLOCKED/);
    assert.throws(() => net.createConnection(443, externalHost), /EXTERNAL_NETWORK_BLOCKED/);
    assert.equal(originalCalls, 0, "external positional overloads must not reach the original connector");

    const local = net.connect(443, "127.0.0.1");
    assert.equal(originalCalls, 1, "the explicit loopback control remains available");
    local.destroy();

    const ipcPath = process.platform === "win32" ? "\\\\.\\pipe\\proto-offline-guard" : "/tmp/proto-offline-guard.sock";
    const directIpc = new net.Socket().connect(ipcPath);
    const helperIpc = net.connect(ipcPath);
    const optionsIpc = new net.Socket().connect({ path: ipcPath });
    assert.equal(originalCalls, 4, "all local IPC overloads must reach the original connector");
    directIpc.destroy();
    helperIpc.destroy();
    optionsIpc.destroy();
  } finally {
    net.Socket.prototype.connect = realConnect;
    dns.lookup = realLookup;
  }
});

test("pinned compiler rejects byte tampering and unexpected files", async (context) => {
  const fixture = await createCompilerFixture(context);
  const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");

  const verified = await verifyPinnedTypeScriptPackage(fixture.root, lock);
  assert.equal(verified.treeSha256, PINNED_TYPESCRIPT_PACKAGE.treeSha256);

  const unexpected = join(fixture.packageRoot, "unexpected.js");
  await writeFile(unexpected, "module.exports = true;\n", "utf8");
  await assert.rejects(
    verifyPinnedTypeScriptPackage(fixture.root, lock),
    { message: "INSTALLED_COMPILER_INTEGRITY_MISMATCH" },
  );
  await unlink(unexpected);

  await writeFile(join(fixture.packageRoot, "bin", "tsc"), "throw new Error('tampered');\n", "utf8");
  await assert.rejects(
    verifyPinnedTypeScriptPackage(fixture.root, lock),
    { message: "INSTALLED_COMPILER_INTEGRITY_MISMATCH" },
  );
});

test("pinned compiler rejects a junction outside the exact project virtual store", async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "proto-offline-wrong-target-"));
  context.after(() => safeRemoveFixture(fixtureRoot));
  await mkdir(join(fixtureRoot, "node_modules"), { recursive: true });
  const actualPackageRoot = await realpath(join(root, "node_modules", "typescript"));
  await symlink(
    actualPackageRoot,
    join(fixtureRoot, "node_modules", "typescript"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");

  await assert.rejects(
    verifyPinnedTypeScriptPackage(fixtureRoot, lock),
    { message: "INSTALLED_COMPILER_ROOT_UNSAFE" },
  );
});

test("pinned compiler rejects a lock integrity mismatch", async () => {
  const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const wrongIntegrity = `sha512-${"A".repeat(88)}`;
  const altered = lock.replace(PINNED_TYPESCRIPT_PACKAGE.integrity, wrongIntegrity);
  assert.notEqual(altered, lock);

  await assert.rejects(
    verifyPinnedTypeScriptPackage(root, altered),
    { message: "INSTALLED_COMPILER_LOCK_UNSAFE" },
  );
});

async function createCompilerFixture(context) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "proto-offline-compiler-"));
  context.after(() => safeRemoveFixture(fixtureRoot));
  const packageRoot = join(
    fixtureRoot,
    "node_modules",
    ".pnpm",
    `typescript@${PINNED_TYPESCRIPT_PACKAGE.version}`,
    "node_modules",
    "typescript",
  );
  await mkdir(dirname(packageRoot), { recursive: true });
  await cp(join(root, "node_modules", "typescript"), packageRoot, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
  });
  await symlink(
    packageRoot,
    join(fixtureRoot, "node_modules", "typescript"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return { root: fixtureRoot, packageRoot };
}

async function safeRemoveFixture(path) {
  const canonicalTmp = resolve(tmpdir());
  const target = resolve(path);
  const child = relative(canonicalTmp, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("TEST_FIXTURE_PATH_UNSAFE");
  }
  await rm(target, { recursive: true, force: true });
}
