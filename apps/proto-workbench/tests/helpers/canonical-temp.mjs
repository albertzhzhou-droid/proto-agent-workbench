import { mkdtemp, realpath } from "node:fs/promises";

// Hosted Windows TEMP can use a short-name/alias spelling. Newly owned fixtures
// must pass their canonical paths to production APIs that reject linked paths.
// Do not use this helper on adversarial paths exercised by junction tests.
export async function canonicalMkdtemp(prefix) {
  return realpath(await mkdtemp(prefix));
}
