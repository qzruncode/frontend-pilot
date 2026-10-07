import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workspaceRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8080";
const configuredBasePath = process.env.VITE_APP_BASE_PATH?.trim() || "/";
const normalizedBasePath = configuredBasePath.startsWith("/") ? configuredBasePath : `/${configuredBasePath}`;
const appBasePath = normalizedBasePath === "/" ? "/" : `${normalizedBasePath.replace(/\/+$/, "")}/`;

export default defineConfig({
  base: appBasePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(workspaceRoot, "apps/web/src"),
      "@contracts": path.join(workspaceRoot, "src/contracts.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiProxyTarget, ws: true },
      "/healthz": apiProxyTarget,
      "/webhooks": apiProxyTarget,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "assistant-vendor": ["@assistant-ui/react"],
          "icons-vendor": ["lucide-react"],
          "form-vendor": ["react-hook-form"],
          "radix-vendor": [
            "@radix-ui/react-checkbox",
            "@radix-ui/react-collapsible",
            "@radix-ui/react-label",
            "@radix-ui/react-select",
            "@radix-ui/react-slot",
          ],
        },
      },
    },
  },
});
