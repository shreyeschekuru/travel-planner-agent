import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig, loadEnv, type Plugin } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** PNGs in public/icons, rendered from icons/icon.svg by icons/render.sh. */
const icons = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${size}.png`]));

/** Generates manifest.json so host_permissions always match the configured API origin. */
function manifest(apiBase: string): Plugin {
  const origin = new URL(apiBase).origin;
  return {
    name: "travellite-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: JSON.stringify(
          {
            manifest_version: 3,
            name: "Travellite",
            version: pkg.version,
            description: "Plan whole trips that fit your budget.",
            icons,
            action: {
              default_popup: "popup.html",
              default_title: "Travellite",
              default_icon: icons,
            },
            background: { service_worker: "service-worker.js", type: "module" },
            permissions: ["storage"],
            host_permissions: [`${origin}/*`],
            content_security_policy: {
              extension_pages: "script-src 'self'; object-src 'self'",
            },
          },
          null,
          2,
        ),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiBase = env.VITE_API_BASE || "http://localhost:3000";
  const { protocol, hostname } = new URL(apiBase);
  if (mode === "production" && protocol !== "https:" && hostname !== "localhost") {
    throw new Error(`VITE_API_BASE must be https in production builds (got ${apiBase})`);
  }
  return {
    plugins: [react(), manifest(apiBase)],
    define: { "import.meta.env.VITE_API_BASE": JSON.stringify(apiBase) },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: { popup: "popup.html", "service-worker": "src/worker/service-worker.ts" },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "service-worker" ? "service-worker.js" : "assets/[name]-[hash].js",
        },
      },
    },
  };
});
