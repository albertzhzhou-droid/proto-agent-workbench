import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "../src/renderer/sha256.ts";

test("renderer SHA-256 matches standard UTF-8 vectors synchronously", () => {
  assert.equal(sha256Text(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Text("MKTWVDEFGH"), "bc1069765c6aac25e56e54fdf000d06d4590b05dc90a1056f046c7066d69d06c");
  assert.equal(sha256Text("蛋白"), "c4ba2b6a88e6cd8797f32813d3a177e2ee7c531497329ecd692f3c8a4efe3e94");
});
