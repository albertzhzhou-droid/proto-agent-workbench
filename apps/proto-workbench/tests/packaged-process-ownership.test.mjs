import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("packaged launch ownership rejects PID reuse, scope escapes and wrong sessions", { skip: process.platform !== "win32", timeout: 35_000 }, () => {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./packaged-process-ownership.test.ps1", import.meta.url))], { windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS 24 packaged identity cases/);
});
