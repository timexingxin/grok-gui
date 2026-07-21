import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Path aliases shared by both the TypeScript compiler (tsconfig.json
// "paths") and Vite's module resolver. Keep the two in lock-step.
const rendererAlias = {
  "@": resolve(__dirname, "src"),
  "@grok-gui/ui": resolve(__dirname, "packages/ui/src"),
  "@grok-gui/core": resolve(__dirname, "packages/core/src"),
  "@grok-gui/provider": resolve(__dirname, "packages/provider/src"),
  // Redirect the (copied, unmodified) application code's Tauri imports at
  // Electron-backed shims instead of hand-editing every call site. See
  // src/shims/*.ts for the translation of each API.
  "@tauri-apps/api/core": resolve(__dirname, "src/shims/tauri-core.ts"),
  "@tauri-apps/api/event": resolve(__dirname, "src/shims/tauri-event.ts"),
  "@tauri-apps/plugin-dialog": resolve(__dirname, "src/shims/plugin-dialog.ts"),
  "@tauri-apps/plugin-updater": resolve(__dirname, "src/shims/plugin-updater.ts"),
};

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      // Two entries: the app main process, plus the content-search worker that
      // commands.ts spawns via `new Worker(path.join(__dirname, "search-worker.js"))`.
      // Both land in out/main so the __dirname-relative worker path resolves.
      lib: {
        entry: {
          main: resolve(__dirname, "electron/main.ts"),
          "search-worker": resolve(__dirname, "electron/search-worker.ts"),
        },
      },
      rollupOptions: { external: ["electron", "electron-updater"] },
    },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      outDir: "out/preload",
      lib: { entry: resolve(__dirname, "electron/preload.ts") },
      rollupOptions: { external: ["electron"] },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: ".",
    // Compile-time product name for the shared UI package. The Electron build
    // brands itself "Grok GUI"; the Tauri build overrides this to
    // "Grok GUI Lite" in apps/desktop/vite.config.ts.
    define: {
      __APP_NAME__: JSON.stringify("Grok GUI"),
    },
    resolve: {
      extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
      alias: rendererAlias,
    },
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
        output: {
          // Split heavy vendor libs out of the main chunk so the initial
          // paint only needs the core app code; markdown/katex load with
          // the chat, mirroring the Tauri build's chunking strategy.
          manualChunks: {
            markdown: ["react-markdown", "remark-gfm", "remark-math", "rehype-katex"],
            vendor: ["react", "react-dom", "zustand", "lucide-react"],
          },
        },
      },
    },
    plugins: [react()],
  },
});
