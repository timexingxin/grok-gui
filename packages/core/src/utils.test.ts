import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cn, formatTokens, formatCost, relativeTime, debounce } from "./utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("dedupes conflicting tailwind utilities via twMerge", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("ignores falsy values", () => {
    const hidden = vi.fn(() => false)();
    expect(cn("base", hidden && "hidden", null, undefined, "active")).toBe(
      "base active",
    );
  });
});

describe("formatTokens", () => {
  it("returns raw number for values under 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with one decimal and k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(999_999)).toBe("1000.0k");
  });

  it("formats millions with two decimals and M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(1_500_000)).toBe("1.50M");
  });
});

describe("formatCost", () => {
  it("returns zero-padded CNY for tiny amounts", () => {
    expect(formatCost(0)).toBe("¥0.0000");
    expect(formatCost(0.00005)).toBe("¥0.0000");
  });

  it("converts USD to CNY at 7.2 rate with four decimals", () => {
    expect(formatCost(1)).toBe("¥7.2000");
    expect(formatCost(0.01)).toBe("¥0.0720");
  });
});

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 刚刚 for differences under 5 seconds", () => {
    expect(relativeTime(Date.now() - 2000)).toBe("刚刚");
  });

  it("returns seconds for differences under a minute", () => {
    expect(relativeTime(Date.now() - 15_000)).toBe("15秒前");
  });

  it("returns minutes for differences under an hour", () => {
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe("5分钟前");
  });

  it("returns English timestamps when requested by the UI locale", () => {
    expect(relativeTime(Date.now() - 5 * 60_000, "en-US")).toBe("5m ago");
    expect(relativeTime(Date.now() - 2_000, "en-US")).toBe("Just now");
  });

  it("returns hours for differences under a day", () => {
    expect(relativeTime(Date.now() - 3 * 3600_000)).toBe("3小时前");
  });

  it("returns days for differences under a week", () => {
    expect(relativeTime(Date.now() - 2 * 24 * 3600_000)).toBe("2天前");
  });

  it("falls back to locale date for older timestamps", () => {
    const older = Date.now() - 10 * 24 * 3600_000;
    const result = relativeTime(older);
    expect(result).not.toMatch(/前$/);
    expect(result.length).toBeGreaterThan(0);
  });

  it("accepts Date objects and ISO strings", () => {
    expect(relativeTime(new Date(Date.now() - 1000))).toBe("刚刚");
    expect(relativeTime(new Date(Date.now() - 1000).toISOString())).toBe("刚刚");
  });
});

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays invocation until wait ms elapse", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced("a");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("resets the timer on subsequent calls", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced("a");
    vi.advanceTimersByTime(50);
    debounced("b");
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("b");
  });
});
