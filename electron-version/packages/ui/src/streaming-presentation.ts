/** Avoid a detached cursor while the agent has not emitted visible text. */
export function shouldShowStreamingCaret(text: string, isLatest: boolean): boolean {
  return isLatest && text.trim().length > 0;
}
