import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
// Tauri expects a fixed port and a stable dev URL. Fail fast otherwise.
const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
    plugins: [react()],
    // Compile-time product name. The shared UI package reads `__APP_NAME__` so
    // the Tauri build brands itself "Grok GUI Lite" while the Electron build
    // (see electron-version/electron.vite.config.ts) keeps "Grok GUI".
    define: {
        __APP_NAME__: JSON.stringify("Grok GUI Lite"),
    },
    // Vite options tailored for Tauri development.
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? { protocol: "ws", host, port: 1421 }
            : undefined,
        watch: {
            // Tell vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
        },
    },
    resolve: {
        // Resolve TypeScript source first so the editable application code is the
        // only code path Vite and Tauri can bundle.
        extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
        alias: {
            "@": path.resolve(currentDir, "./src"),
            "@grok-gui/ui": path.resolve(currentDir, "../../packages/ui/src"),
            "@grok-gui/core": path.resolve(currentDir, "../../packages/core/src"),
            "@grok-gui/provider": path.resolve(currentDir, "../../packages/provider/src"),
        },
    },
    // Build options.
    build: {
        target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
        minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
        rollupOptions: {
            output: {
                // Split heavy vendor libs out of the main chunk so the initial paint
                // only needs the core app code; markdown/katex load with the chat.
                manualChunks: {
                    markdown: ["react-markdown", "remark-gfm", "remark-math", "rehype-katex"],
                    vendor: ["react", "react-dom", "zustand", "lucide-react"],
                },
            },
        },
    },
});
