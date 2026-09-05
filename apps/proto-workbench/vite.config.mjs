import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  plugins: [react()],
});
