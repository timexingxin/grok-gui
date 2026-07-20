import { describe, it, expect } from "vitest";
import { modeForLevel, type PermissionLevel, type WorkspaceMode } from "./index";

const cases: Array<[PermissionLevel, WorkspaceMode]> = [
  ["always_ask", "ask"],
  ["sensitive_ask", "ask"],
  ["read_only", "plan"],
  ["ask_write", "plan"],
  ["trust_workspace", "build"],
  ["full_access", "build"],
];

describe("modeForLevel", () => {
  it.each(cases)("maps %s → %s", (level, expected) => {
    expect(modeForLevel(level)).toBe(expected);
  });

  it("covers every PermissionLevel value", () => {
    const levels = cases.map(([level]) => level);
    expect(new Set(levels).size).toBe(6);
  });
});
