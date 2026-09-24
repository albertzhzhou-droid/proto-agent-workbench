import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { assertTypographyOutput, selectTypography, syncChemTypography, typographyCss, typographyReceipt } from "./typography-profile.mjs";

export function typographyPlugin(appRoot, requestedProfile) {
  const app = resolve(appRoot), cssPath = resolve(app, "src/renderer/fonts.css");
  let selection;
  return {
    name: "proto-typography-profile",
    enforce: "pre",
    config() { return { build: { assetsInlineLimit: 0 } }; },
    configResolved(config = { command: "build", define: {} }) {
      selection = selectTypography(app, requestedProfile);
      // Active source sessions retain their selected family set when another
      // server or build selects a different profile in the same checkout.
      syncChemTypography(app, selection, { isolated: true });
      if (config.command === "build") syncChemTypography(app, selection);
      config.define ??= {};
      config.define.__PROTO_TYPOGRAPHY_PROFILE__ = JSON.stringify(selection.profile);
    },
    load(id) {
      if (resolve(id.split("?")[0]) === cssPath) return typographyCss(selection);
      return null;
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "typography-profile.json", source: `${JSON.stringify(typographyReceipt(selection), null, 2)}\n` });
      if (selection.profile === "public") for (const file of selection.files.filter(file => !file.file.endsWith(".woff2"))) {
        this.emitFile({ type: "asset", fileName: `fonts/public/${file.file}`, source: readFileSync(file.path) });
      }
    },
    writeBundle(options) {
      if (!options.dir) throw Error("Typography verification requires a Vite output directory.");
      assertTypographyOutput(app, resolve(app, options.dir), selection.profile);
    },
  };
}
