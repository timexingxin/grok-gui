import { describe, expect, it } from "vitest";
import { nextOnboardingStage } from "./onboarding-flow";

describe("onboarding flow", () => {
  it("routes an installed CLI to authentication instead of terminal instructions", () => {
    expect(nextOnboardingStage({ installed: true })).toBe("authenticate");
  });

  it("routes a missing CLI to official installation", () => {
    expect(nextOnboardingStage({ installed: false })).toBe("missing-cli");
  });
});
