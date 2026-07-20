import { describe, it, expect } from "vitest";
import { listProviders, providersFromConfig } from "./models-dev";
import type { ProviderConfig } from "./provider-config";
import { BUILTIN_PROVIDERS, BUILTIN_PROVIDER_MODELS } from "./provider-config";

describe("providersFromConfig", () => {
  it("maps enabled providers to ProviderInfo with the oauth catalog by default", () => {
    const input: ProviderConfig[] = [
      {
        id: "xai",
        name: "Grok Build ACP",
        kind: "xai",
        enabled: true,
      },
    ];
    const result = providersFromConfig(input);
    expect(result).toEqual([
      {
        id: "xai",
        name: "Grok Build ACP",
        kind: "xai",
        baseUrl: undefined,
        apiKeyEnv: undefined,
        enabled: true,
        models: BUILTIN_PROVIDER_MODELS.xai.oauth,
      },
    ]);
  });

  it("switches to the apiKey catalog when authMode is apiKey", () => {
    const result = providersFromConfig(BUILTIN_PROVIDERS, "apiKey");
    expect(result[0].models).toEqual(BUILTIN_PROVIDER_MODELS.xai.apiKey);
  });

  it("filters out disabled providers", () => {
    const input: ProviderConfig[] = [
      { id: "xai", name: "Off", kind: "xai", enabled: false },
      {
        id: "backup",
        name: "Backup ACP",
        kind: "xai",
        enabled: true,
        baseUrl: "https://example.test",
        apiKeyEnv: "XAI_API_KEY",
      },
    ];
    const result = providersFromConfig(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("backup");
    expect(result[0].baseUrl).toBe("https://example.test");
    expect(result[0].apiKeyEnv).toBe("XAI_API_KEY");
    expect(result[0].models).toEqual(BUILTIN_PROVIDER_MODELS.xai.oauth);
  });

  it("returns an empty array when every provider is disabled", () => {
    expect(
      providersFromConfig([
        { id: "xai", name: "Off", kind: "xai", enabled: false },
      ]),
    ).toEqual([]);
  });

  it("returns empty models for unknown provider kinds", () => {
    const result = providersFromConfig([
      {
        id: "custom",
        name: "Custom",
        kind: "openai_compat",
        enabled: true,
      },
    ]);
    expect(result[0].models).toEqual([]);
  });

  it("preserves optional fields when present", () => {
    const result = providersFromConfig([
      {
        id: "xai",
        name: "Grok",
        kind: "xai",
        enabled: true,
        baseUrl: "https://api.x.ai/v1",
        apiKeyEnv: "XAI_API_KEY",
      },
    ]);
    expect(result[0].baseUrl).toBe("https://api.x.ai/v1");
    expect(result[0].apiKeyEnv).toBe("XAI_API_KEY");
  });
});

describe("listProviders", () => {
  it("returns the OAuth catalog by default", async () => {
    const providers = await listProviders();
    expect(providers).toEqual(providersFromConfig(BUILTIN_PROVIDERS));
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: "xai",
      name: "Grok Build ACP",
      kind: "xai",
      enabled: true,
    });
    expect(providers[0].models).toEqual([
      { id: "grok-4.5", label: "Grok 4.5", toolCall: true, reasoning: true },
    ]);
  });

  it("returns the apiKey catalog when requested", async () => {
    const providers = await listProviders("apiKey");
    expect(providers[0].models.length).toBeGreaterThan(1);
    expect(providers[0].models.some((m) => m.id === "grok-3")).toBe(true);
  });

  it("resolves without network I/O (local catalog only)", async () => {
    await expect(listProviders()).resolves.toBeDefined();
  });
});
