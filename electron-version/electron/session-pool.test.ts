// Translated from `mod session_pool_tests` in
// apps/desktop/src-tauri/src/lib.rs — the LRU eviction and admission
// control invariants are the highest-risk piece of this port, since the
// original Rust `try_admit` / `insert` / `evict_oldest_idle` sequencing
// exists specifically to stop a burst of concurrent `start_session` calls
// from over-spawning `grok agent stdio` child processes.

import { describe, expect, it } from "vitest";
import { lruOldest, SessionPool, MAX_RUNTIMES } from "./session-pool";
import type { GrokRuntime } from "./grok-runtime";

function fakeRuntime(busy: boolean): GrokRuntime {
  return { isBusy: () => busy } as unknown as GrokRuntime;
}

describe("lruOldest", () => {
  it("returns undefined for an empty map", () => {
    expect(lruOldest(new Map())).toBeUndefined();
  });

  it("picks the earliest timestamp", () => {
    const base = Date.now();
    const map = new Map<string, number>([
      ["a", base - 100],
      ["b", base - 10],
      ["c", base - 50],
    ]);
    expect(lruOldest(map)).toBe("a");
  });

  it("handles a single entry", () => {
    const map = new Map<string, number>([["only", Date.now()]]);
    expect(lruOldest(map)).toBe("only");
  });
});

describe("SessionPool", () => {
  it("starts empty with no active sessions", () => {
    const pool = new SessionPool();
    expect(pool.activeIds()).toEqual([]);
    expect(pool.size()).toBe(0);
    expect(pool.contains("anything")).toBe(false);
  });

  it("remove on an empty pool returns undefined", () => {
    const pool = new SessionPool();
    expect(pool.remove("missing")).toBeUndefined();
  });

  it("tryAdmit records a placeholder for a new key", () => {
    const pool = new SessionPool();
    expect(pool.tryAdmit("hint-a", "new-session")).toBe(true);
    expect(pool.inFlightSize()).toBe(1);
  });

  it("tryAdmit is free for a resumed session id", () => {
    const pool = new SessionPool();
    expect(pool.tryAdmit("hint-a", "already-running")).toBe(true);
    pool.releaseReservation("hint-a");
    expect(pool.tryAdmit("hint-b", "new-session")).toBe(true);
    pool.releaseReservation("hint-b");
  });

  it("tryAdmit rejects once the pool is full, and recovers after a release", () => {
    const pool = new SessionPool();
    // Saturate the admission gate with MAX_RUNTIMES placeholders.
    for (let i = 0; i < MAX_RUNTIMES; i += 1) {
      expect(pool.tryAdmit(`hint-${i}`, "unused")).toBe(true);
    }
    // Next spawn must be refused.
    expect(pool.tryAdmit("hint-overflow", "unused")).toBe(false);
    // Releasing one slot must let the next call back in.
    pool.releaseReservation("hint-0");
    expect(pool.tryAdmit("hint-recovered", "unused")).toBe(true);
  });

  it("releaseReservation is idempotent", () => {
    const pool = new SessionPool();
    pool.releaseReservation("never-admitted");
    expect(pool.inFlightSize()).toBe(0);
    pool.tryAdmit("hint", "unused");
    pool.releaseReservation("hint");
    pool.releaseReservation("hint"); // double release is safe.
    expect(pool.inFlightSize()).toBe(0);
  });

  it("in-flight + runtime count never exceeds the cap while filling via admit", () => {
    const pool = new SessionPool();
    for (let i = 0; i < MAX_RUNTIMES; i += 1) {
      expect(pool.tryAdmit(`hint-${i}`, "rt")).toBe(true);
    }
    expect(pool.tryAdmit("spawn-blocked", "rt")).toBe(false);
  });

  it("insert evicts the oldest IDLE runtime once the pool is full", () => {
    const pool = new SessionPool();
    // Fill to capacity with idle runtimes, oldest first.
    for (let i = 0; i < MAX_RUNTIMES; i += 1) {
      const hint = `hint-${i}`;
      pool.tryAdmit(hint, "unused");
      pool.insert(`session-${i}`, fakeRuntime(false), hint);
    }
    expect(pool.size()).toBe(MAX_RUNTIMES);

    const hint = "hint-new";
    pool.tryAdmit(hint, "unused");
    const evicted = pool.insert("session-new", fakeRuntime(false), hint);
    expect(evicted).toBeDefined();
    expect(pool.size()).toBe(MAX_RUNTIMES);
    // The very first inserted session (oldest lastUsed) is the one evicted.
    expect(pool.contains("session-0")).toBe(false);
    expect(pool.contains("session-new")).toBe(true);
  });

  it("insert throws instead of killing a busy runtime to make room", () => {
    const pool = new SessionPool();
    for (let i = 0; i < MAX_RUNTIMES; i += 1) {
      const hint = `hint-${i}`;
      pool.tryAdmit(hint, "unused");
      pool.insert(`session-${i}`, fakeRuntime(true), hint); // all busy
    }
    const hint = "hint-new";
    pool.tryAdmit(hint, "unused");
    expect(() => pool.insert("session-new", fakeRuntime(false), hint)).toThrow(/并发会话已达上限/);
    // No eviction happened; the pool is still exactly at capacity.
    expect(pool.size()).toBe(MAX_RUNTIMES);
  });

  it("get() marks a session as most-recently-used, protecting it from eviction", () => {
    const pool = new SessionPool();
    for (let i = 0; i < MAX_RUNTIMES; i += 1) {
      const hint = `hint-${i}`;
      pool.tryAdmit(hint, "unused");
      pool.insert(`session-${i}`, fakeRuntime(false), hint);
    }
    // Touch session-0 so it is no longer the least-recently-used entry.
    pool.get("session-0");

    const hint = "hint-new";
    pool.tryAdmit(hint, "unused");
    pool.insert("session-new", fakeRuntime(false), hint);

    // session-0 survives; session-1 (now oldest) is evicted instead.
    expect(pool.contains("session-0")).toBe(true);
    expect(pool.contains("session-1")).toBe(false);
  });

  it("remove() clears both the runtime and its lastUsed bookkeeping", () => {
    const pool = new SessionPool();
    pool.tryAdmit("hint", "s1");
    pool.insert("s1", fakeRuntime(false), "hint");
    expect(pool.remove("s1")).toBeDefined();
    expect(pool.contains("s1")).toBe(false);
    expect(pool.remove("s1")).toBeUndefined();
  });
});
