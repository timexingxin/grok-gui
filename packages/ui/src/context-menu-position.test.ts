import { describe, expect, it } from "vitest";
import { contextMenuPosition } from "./context-menu-position";

describe("contextMenuPosition", () => {
  it("keeps a session menu fully inside the viewport near the lower-right corner", () => {
    expect(contextMenuPosition(
      { x: 900, y: 560 },
      { width: 960, height: 630 },
      { width: 272, height: 480 },
    )).toEqual({ x: 680, y: 142 });
  });

  it("keeps the menu away from the top and left viewport edges", () => {
    expect(contextMenuPosition(
      { x: -8, y: -20 },
      { width: 960, height: 630 },
      { width: 272, height: 480 },
    )).toEqual({ x: 8, y: 8 });
  });
});
