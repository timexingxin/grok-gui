import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import type {} from "./electron.d.ts";

// The copied application code's `isTauri()` checks look for
// `window.__TAURI_INTERNALS__`. Rather than edit every call site, alias it
// to the Electron bridge preload.ts exposes so those checks keep working.
if (typeof window !== "undefined" && window.electron) {
  window.__TAURI_INTERNALS__ = window.electron;
}

// Note: we intentionally do NOT wrap in <React.StrictMode>. StrictMode
// double-invokes effects in dev to surface side-effect bugs, but it
// double-spawns our grok agent process — not what we want during UI work.
// Re-enable temporarily when debugging effect purity.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
