import type { Plugin } from "vite";
import { LmStudioProvider } from "../main/services/lm-studio-provider.ts";
import { MODEL_ENDPOINT, readModelSnapshot } from "../shared/model-status.ts";

export function lmStudioPreview(): Plugin {
  const provider = new LmStudioProvider();
  return { name: "proto-live-lm-studio-inventory", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split("?")[0] !== "/__proto/lm-studio/models") return next();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      const host = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)
        || (req.headers.origin && req.headers.origin !== `http://${host}`)
        || req.headers["sec-fetch-site"] === "cross-site") {
        res.statusCode = 403; res.end('{"error":"Loopback same-origin access required."}'); return;
      }
      if (req.method !== "GET" || req.url?.includes("?")) {
        res.statusCode = 405; res.end('{"error":"Read-only model inventory."}'); return;
      }
      const snapshot = await readModelSnapshot(() => provider.scan(MODEL_ENDPOINT));
      res.end(JSON.stringify(snapshot));
    });
  } };
}
