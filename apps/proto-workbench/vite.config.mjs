import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { lmStudioPreview } from "./src/dev/lm-studio-preview.ts";
import { researchChatPreview } from "./src/dev/research-chat-preview.ts";
import { chemWorkbenchPreview } from "./src/dev/chem-workbench-preview.ts";
import { chemSciencePreview } from './src/dev/chem-science-preview.ts';
import { typographyPlugin } from "./scripts/typography-vite.mjs";
import { fileURLToPath } from "node:url";

export default defineConfig({
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    watch: { ignored: ["**/build/**", "**/out/**", "**/runtime/**", "**/release*/**", "**/qa/**"] },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/renderer/main.tsx"],
    },
  },
  plugins: [typographyPlugin(fileURLToPath(new URL(".", import.meta.url))), react(), lmStudioPreview(), researchChatPreview(), chemWorkbenchPreview(), chemSciencePreview()],
});
