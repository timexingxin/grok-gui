// Live ACP runtime pool, keyed by session id.
//
// Translated from the `SessionPool` in apps/desktop/src-tauri/src/lib.rs.
// On overflow, the least-recently-used **idle** entry is evicted and
// returned so the caller can shut it down outside the pool's critical
// section, keeping multiple conversations alive across switches.

import type { GrokRuntime } from "./grok-runtime";

/** Maximum number of concurrent ACP runtimes kept alive in the pool. Each
 * runtime is a full `grok agent stdio` subprocess; the cap bounds
 * memory/fd usage while letting several projects run in parallel. */
export const MAX_RUNTIMES = 6;

let spawnHintCounter = 0;
/** Generates a unique token for `start_session`'s admission-control slot
 * reservation. The pool only uses the token as an opaque placeholder key;
 * its readable form is purely for debugging. */
export function nextSpawnHint(): string {
  spawnHintCounter += 1;
  return `spawn:${spawnHintCounter}`;
}

/** Monotonic tick used for `lastUsed` bookkeeping instead of `Date.now()`.
 * The Rust pool ordered eviction by `std::time::Instant`, a monotonic
 * clock with sub-millisecond resolution; `Date.now()`'s ~1ms resolution
 * lets same-tick `get()`/`insert()` calls collide and break LRU ordering
 * under fast, synchronous access patterns (e.g. admission-control bursts). */
let lruTick = 0;
function nextTick(): number {
  lruTick += 1;
  return lruTick;
}

/** Pick the session id with the oldest `lastUsed` timestamp. Extracted as a
 * pure function so the LRU direction can be unit-tested without
 * constructing a real GrokRuntime (which requires a live subprocess). */
export function lruOldest(timestamps: Map<string, number>): string | undefined {
  let oldestId: string | undefined;
  let oldestAt = Infinity;
  for (const [id, at] of timestamps) {
    if (at < oldestAt) {
      oldestAt = at;
      oldestId = id;
    }
  }
  return oldestId;
}

export class SessionPool {
  private runtimes = new Map<string, GrokRuntime>();
  private lastUsed = new Map<string, number>();
  /** Admission-control placeholder for sessions currently being spawned.
   * `start_session` reserves a slot here before calling `GrokRuntime.spawn`
   * and then either promotes it via `insert` (real session id known) or
   * rolls it back via `releaseReservation` (spawn failure). This prevents a
   * burst of concurrent start_session calls from all spawning a child
   * process only to find the pool full afterwards. */
  private inFlight = new Set<string>();

  /** Returns a cheap reference (every GrokRuntime holds its own process
   * handle) and marks the session most-recently-used. */
  get(sessionId: string): GrokRuntime | undefined {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) this.lastUsed.set(sessionId, nextTick());
    return runtime;
  }

  contains(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  /** Insert a runtime. If the pool is full and this is a new key, the
   * least-recently-used **idle** runtime is evicted and returned for
   * shutdown. Throws if the pool is full and every runtime is busy (a
   * running turn must never be killed to make room). `hint` is the
   * reservation token `tryAdmit` placed in `inFlight`; this call promotes
   * it into a real slot by removing it. */
  insert(sessionId: string, runtime: GrokRuntime, hint: string): GrokRuntime | undefined {
    const isNew = !this.runtimes.has(sessionId);
    let evicted: GrokRuntime | undefined;
    if (isNew && this.runtimes.size >= MAX_RUNTIMES) {
      evicted = this.evictOldestIdle();
    }
    if (isNew && evicted === undefined && this.runtimes.size >= MAX_RUNTIMES) {
      throw new Error(`并发会话已达上限（${MAX_RUNTIMES}），且全部正在执行任务，请等待其中一个完成后再试。`);
    }
    // Promote the reservation into a real slot.
    this.inFlight.delete(hint);
    this.runtimes.set(sessionId, runtime);
    this.lastUsed.set(sessionId, nextTick());
    return evicted;
  }

  /** Reserve a slot for a session not yet inserted into the pool. Returns
   * true if the projected capacity (runtimes + in-flight placeholders)
   * still fits under MAX_RUNTIMES; the hint is recorded so concurrent
   * start_session calls don't all clear the gate. */
  tryAdmit(hint: string, resumeSid: string): boolean {
    // Re-admitting an existing runtime is free; no new slot consumed.
    if (this.runtimes.has(resumeSid)) return true;
    if (this.runtimes.size + this.inFlight.size >= MAX_RUNTIMES) return false;
    this.inFlight.add(hint);
    return true;
  }

  /** Roll back a reservation whose spawn subsequently failed; if `insert`
   * succeeds, the hint is removed there instead. */
  releaseReservation(hint: string): void {
    this.inFlight.delete(hint);
  }

  remove(sessionId: string): GrokRuntime | undefined {
    this.lastUsed.delete(sessionId);
    const runtime = this.runtimes.get(sessionId);
    this.runtimes.delete(sessionId);
    return runtime;
  }

  private evictOldestIdle(): GrokRuntime | undefined {
    const candidateIds = [...this.runtimes.entries()].filter(([, r]) => !r.isBusy()).map(([id]) => id);
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const id of candidateIds) {
      const at = this.lastUsed.get(id);
      if (at !== undefined && at < oldestAt) {
        oldestAt = at;
        oldestId = id;
      }
    }
    if (oldestId === undefined) return undefined;
    this.lastUsed.delete(oldestId);
    const runtime = this.runtimes.get(oldestId);
    this.runtimes.delete(oldestId);
    return runtime;
  }

  activeIds(): string[] {
    return [...this.runtimes.keys()];
  }

  /** Test-only: number of live runtimes in the pool. */
  size(): number {
    return this.runtimes.size;
  }

  /** Test-only: number of in-flight admission reservations. */
  inFlightSize(): number {
    return this.inFlight.size;
  }
}
