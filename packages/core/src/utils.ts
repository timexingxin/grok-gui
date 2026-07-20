import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className merge. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Compact token formatter: 1234 → "1.2k", 1_500_000 → "1.50M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Tiny cost formatter; converts USD → CNY. Will become i18n-aware in P2. */
export function formatCost(usd: number): string {
  if (usd < 0.0001) return `¥0.0000`;
  return `¥${(usd * 7.2).toFixed(4)}`;
}

/** Relative time for the selected product UI locale. */
export function relativeTime(date: Date | string | number, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  const d = typeof date === "object" ? date : new Date(date);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (locale === "en-US") {
    if (s < 5) return "Just now";
    if (s < 60) return `${s}s ago`;
    const minutes = Math.floor(s / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-US");
  }
  if (s < 5) return "刚刚";
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}天前`;
  return d.toLocaleDateString(locale);
}

/** Simple debounce for editor auto-save scenarios. */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
