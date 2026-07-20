import type { ProviderInfo } from "@grok-gui/core";
import {
  BUILTIN_PROVIDERS,
  modelsForProvider,
  type ProviderConfig,
} from "./provider-config";

/**
 * Pure mapping: enabled providers → ProviderInfo with model catalogs.
 * Extracted so unit tests can exercise filter/map without mocking module state.
 * Model lookup is keyed by provider kind (not id) so a custom provider that
 * re-uses the `xai` kind reuses the same xAI catalogue we ship.
 */
export function providersFromConfig(
  providers: readonly ProviderConfig[],
  authMode: "oauth" | "apiKey" = "oauth",
): ProviderInfo[] {
  return providers
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      apiKeyEnv: p.apiKeyEnv,
      enabled: p.enabled,
      models: modelsForProvider(p, authMode),
    }));
}

/**
 * Returns only models exposed by this application's Grok Build ACP adapter.
 * The authMode selector narrows the catalog to what the user's current login
 * actually supports (grok.com account login vs xAI API key).
 */
export async function listProviders(
  authMode: "oauth" | "apiKey" = "oauth",
): Promise<ProviderInfo[]> {
  return providersFromConfig(BUILTIN_PROVIDERS, authMode);
}
