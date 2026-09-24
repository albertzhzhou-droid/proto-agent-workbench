import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { typographyPlugin } from "./scripts/typography-vite.mjs";
import { selectTypography } from "./scripts/typography-profile.mjs";

const typographyProfile = selectTypography(__dirname).profile;

export default defineConfig({
  main: {
    define: { __PROTO_TYPOGRAPHY_PROFILE__: JSON.stringify(typographyProfile) },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: ".",
    server: {
      host: "127.0.0.1",
      watch: { ignored: ["**/build/**", "**/out/**", "**/runtime/**", "**/release*/**", "**/qa/**"] },
    },
    plugins: [typographyPlugin(__dirname, typographyProfile), react()],
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
      },
    },
  },
});
