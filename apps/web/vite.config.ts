import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Module UIs live in <repo>/modules, outside this app.
    fs: { allow: [repoRoot] },
    proxy: { "/api": "http://127.0.0.1:4317" },
  },
});
