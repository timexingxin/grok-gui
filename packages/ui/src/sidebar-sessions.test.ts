import { describe, expect, it } from "vitest";
import type { ConversationRecord } from "@grok-gui/core";
import { buildSidebarSessions, splitPinnedSessions } from "./sidebar-sessions";

const savedPinned: ConversationRecord = {
  id: "saved-1",
  title: "稳定的会话",
  messages: [],
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 10,
  pinned: true,
};

describe("buildSidebarSessions", () => {
  it("keeps a saved active record's pin and activity time", () => {
    const rows = buildSidebarSessions([savedPinned]);

    expect(rows.persisted).toEqual([savedPinned]);
    expect(rows.unsaved).toBeNull();
  });

  it("does not create a sidebar row until a session has saved content", () => {
    const rows = buildSidebarSessions([savedPinned]);

    expect(rows.persisted).toEqual([savedPinned]);
    expect(rows.unsaved).toBeNull();
  });
});

describe("splitPinnedSessions", () => {
  it("renders pins in their own section without promoting a normal session", () => {
    const latestNormal = { ...savedPinned, id: "latest-normal", pinned: false, lastActivityAt: 30 };
    const olderPinned = { ...savedPinned, id: "older-pinned", pinned: true, lastActivityAt: 10 };
    const rows = splitPinnedSessions([latestNormal, olderPinned]);

    expect(rows.pinned.map((entry) => entry.id)).toEqual(["older-pinned"]);
    expect(rows.regular.map((entry) => entry.id)).toEqual(["latest-normal"]);
  });
});
