import { describe, expect, it } from "vitest";
import { shouldApplyAgentEvent } from "./event-routing";

describe("shouldApplyAgentEvent", () => {
  it("drops every event while a conversation is switching", () => {
    expect(
      shouldApplyAgentEvent({
        switching: true,
        eventSessionId: "old-runtime",
        currentSessionId: "old-runtime",
      }),
    ).toBe(false);
  });

  it("drops events from a different active runtime", () => {
    expect(
      shouldApplyAgentEvent({
        switching: false,
        eventSessionId: "old-runtime",
        currentSessionId: "new-runtime",
      }),
    ).toBe(false);
  });

  it("keeps matching and sessionless events outside a switch", () => {
    expect(
      shouldApplyAgentEvent({
        switching: false,
        eventSessionId: "active-runtime",
        currentSessionId: "active-runtime",
      }),
    ).toBe(true);
    expect(shouldApplyAgentEvent({ switching: false })).toBe(true);
  });
});
