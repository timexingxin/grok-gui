import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODELS,
  BUILTIN_PROVIDER_MODELS,
  modelsForProvider,
  type ProviderConfig,
} from "./provider-config";

describe("BUILTIN_PROVIDER_MODELS", () => {
  it("exposes a strict xai oauth catalog with only the model the CLI advertises", () => {
    expect(BUILTIN_PROVIDER_MODELS.xai.oauth).toEqual([
      { id: "grok-4.5", label: "Grok 4.5", toolCall: true, reasoning: true },
    ]);
  });

  it("exposes the wider xAI catalogue for apiKey authentication", () => {
    const ids = BUILTIN_PROVIDER_MODELS.xai.apiKey.map((m) => m.id);
    expect(ids).toContain("grok-4.5");
    expect(ids).toContain("grok-4.5-reasoning");
    expect(ids).toContain("grok-3");
    expect(ids).toContain("grok-3-mini");
  });

  it("does not include speculative models outside the xAI family", () => {
    const ids = BUILTIN_PROVIDER_MODELS.xai.apiKey.map((m) => m.id);
    expect(ids).not.toContain("gpt-4o");
    expect(ids).not.toContain("claude-opus");
  });
});

describe("BUILTIN_MODELS (xai)", () => {
  it("defaults to the strict oauth catalog", () => {
    expect(BUILTIN_MODELS.oauth).toEqual([
      { id: "grok-4.5", label: "Grok 4.5", toolCall: true, reasoning: true },
    ]);
  });
});

describe("modelsForProvider", () => {
  const provider: ProviderConfig = {
    id: "xai",
    name: "Grok Build ACP",
    kind: "xai",
    enabled: true,
  };

  it("returns the OAuth catalog by default when no authMode is given", () => {
    expect(modelsForProvider(provider)).toEqual(BUILTIN_PROVIDER_MODELS.xai.oauth);
  });

  it("returns the apiKey catalog when authMode is apiKey", () => {
    expect(modelsForProvider(provider, "apiKey")).toEqual(BUILTIN_PROVIDER_MODELS.xai.apiKey);
  });

  it("returns the OAuth catalog when authMode is oauth", () => {
    expect(modelsForProvider(provider, "oauth")).toEqual(BUILTIN_PROVIDER_MODELS.xai.oauth);
  });

  it("returns an empty list for user-added or unknown provider kinds", () => {
    const custom: ProviderConfig = {
      id: "custom-ollama",
      name: "Local Ollama",
      kind: "openai_compat",
      enabled: true,
    };
    expect(modelsForProvider(custom)).toEqual([]);
    expect(modelsForProvider(custom, "apiKey")).toEqual([]);
  });

  it("does not throw when provider is disabled", () => {
    const disabled: ProviderConfig = {
      id: "xai",
      name: "Grok Build ACP",
      kind: "xai",
      enabled: false,
    };
    expect(modelsForProvider(disabled)).toEqual(BUILTIN_PROVIDER_MODELS.xai.oauth);
  });
});
