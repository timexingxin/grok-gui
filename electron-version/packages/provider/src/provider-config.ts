import type { ModelInfo, ProviderKind } from "@grok-gui/core";

/**
 * The ACP runtime is Grok Build, not a generic OpenAI client. Keep the model
 * picker constrained to capabilities the running ACP server can actually use;
 * multi-provider routing belongs to a separate adapter, not this catalog.
 */
export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;     // env var name (resolved at runtime)
  enabled: boolean;
}

export interface ModelMetadata {
  id: string;
  label: string;
  context?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  cost?: ModelInfo["cost"];
}

/**
 * Per-provider model catalogue, keyed by auth path the user is currently on.
 * - `oauth`: what the bundled Grok CLI exposes after a grok.com account login
 *   (today: only grok-4.5).
 * - `apiKey`: what direct xAI metering via XAI_API_KEY unlocks (the broader
 *   Grok 3/4 family).
 *
 * Unknown future auth modes will need to be added here; an empty array means
 * the picker will be empty for that auth path, never showing unsupported
 * models.
 */
export const BUILTIN_PROVIDER_MODELS: Record<
  string,
  Record<"oauth" | "apiKey", ModelMetadata[]>
> = {
  xai: {
    oauth: [
      { id: "grok-4.5", label: "Grok 4.5", toolCall: true, reasoning: true },
    ],
    apiKey: [
      { id: "grok-4.5", label: "Grok 4.5", toolCall: true, reasoning: true },
      { id: "grok-4.5-reasoning", label: "Grok 4.5 (reasoning)", toolCall: true, reasoning: true },
      { id: "grok-4-fast-reasoning", label: "Grok 4 fast reasoning", toolCall: true, reasoning: true },
      { id: "grok-4-fast-non-reasoning", label: "Grok 4 fast", toolCall: true, reasoning: false },
      { id: "grok-3", label: "Grok 3", toolCall: true, reasoning: false },
      { id: "grok-3-mini", label: "Grok 3 mini", toolCall: true, reasoning: true },
    ],
  },
};

/** Legacy flat shape used by older code/tests; prefer BUILTIN_PROVIDER_MODELS. */
export const BUILTIN_MODELS = BUILTIN_PROVIDER_MODELS.xai;

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  { id: "xai", name: "Grok Build ACP", kind: "xai", enabled: true },
];

/** Pick the model list for a given provider under the active auth path. */
export function modelsForProvider(
  provider: ProviderConfig,
  authMode: "oauth" | "apiKey" = "oauth",
): ModelMetadata[] {
  return BUILTIN_PROVIDER_MODELS[provider.kind]?.[authMode] ?? [];
}
