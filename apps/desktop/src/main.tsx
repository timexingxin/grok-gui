import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Note: we intentionally do NOT wrap in <React.StrictMode>. StrictMode
// double-invokes effects in dev to surface side-effect bugs, but it
// double-spawns our grok agent process — not what we want during UI work.
// Re-enable temporarily when debugging effect purity.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
