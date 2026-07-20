// Provider / model configuration. P0: trivial in-memory list. P2 will
// persist via `tauri-plugin-store` and load model metadata from
// `https://models.dev/api.json` (OpenCode's pattern).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: Option<String>,
    pub api_key_ref: String, // env var name or "store:<key>"
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Xai,
    OpenAi,
    Anthropic,
    Google,
    OpenAiCompat, // LM Studio, vLLM, Ollama, OpenRouter, Moonshot, etc.
}
