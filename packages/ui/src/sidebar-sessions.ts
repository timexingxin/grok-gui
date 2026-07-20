import { conversationActivityTimestamp, type ConversationRecord } from "@grok-gui/core";

export interface UnsavedSidebarSession {
  id: string;
  title: string;
  workspace?: string;
}

export interface SidebarSessions {
  persisted: ConversationRecord[];
  unsaved: UnsavedSidebarSession | null;
}

export interface SplitPinnedSessions {
  pinned: ConversationRecord[];
  regular: ConversationRecord[];
}

/** Pins are a separate view, never a hidden sort key for normal sessions. */
export function splitPinnedSessions(entries: ConversationRecord[]): SplitPinnedSessions {
  const byActivity = (a: ConversationRecord, b: ConversationRecord) =>
    conversationActivityTimestamp(b) - conversationActivityTimestamp(a);
  return {
    pinned: entries.filter((entry) => entry.pinned).sort(byActivity),
    regular: entries.filter((entry) => !entry.pinned).sort(byActivity),
  };
}

/** Persisted records own ordering; an untouched new session is separate. */
export function buildSidebarSessions(history: ConversationRecord[]): SidebarSessions {
  return {
    persisted: history,
    // A blank runtime is an editor state, not a conversation. It belongs in
    // the main empty state until the first user message creates a transcript.
    unsaved: null,
  };
}
