import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {join} from "node:path";

export const MANIFEST_HASH_CONCURRENCY = 8;

/** Bound open streams while preserving every artifact's original position. */
export function createArtifactMaterializer(projectRoot, {concurrency = MANIFEST_HASH_CONCURRENCY, openReadStream = createReadStream} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("Manifest hashing concurrency must be between 1 and 64.");
  const cache = new Map();
  return async function materialize(files) {
    const results = new Array(files.length);
    let cursor = 0, failed = false, failure;
    const worker = async () => {
      while (!failed) {
        const index = cursor++;
        if (index >= files.length) return;
        const file = files[index], key = `${file.scope}:${file.path}`;
        try {
          if (!cache.has(key)) {
            // Store the promise immediately so duplicate descriptors also share
            // a single open handle while their first hash is still running.
            const pending = (async () => {
              const absolute = join(projectRoot, ...file.sourcePath.split("/"));
              const metadata = await stat(absolute);
              return {scope:file.scope, path:file.path, sizeBytes:metadata.size, sha256:await sha256File(absolute, openReadStream)};
            })();
            cache.set(key, pending);
            void pending.catch(() => {if (cache.get(key) === pending) cache.delete(key);});
          }
          results[index] = await cache.get(key);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    };
    // Drain active workers before rejecting: a failed build must not leave its
    // read handles pending when the guarded build transaction exits.
    await Promise.all(Array.from({length:Math.min(concurrency, files.length)}, worker));
    if (failed) throw failure;
    return results;
  };
}

function sha256File(path, openReadStream) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256"), stream = openReadStream(path);
    let ended = false, failure;
    stream.on("data", chunk => hash.update(chunk));
    stream.once("end", () => {ended = true;});
    stream.once("error", error => {failure = error;stream.destroy();});
    stream.once("close", () => {
      if (failure) reject(failure);
      else if (!ended) reject(new Error(`Artifact stream closed before its complete hash: ${path}`));
      else resolve(hash.digest("hex"));
    });
  });
}
