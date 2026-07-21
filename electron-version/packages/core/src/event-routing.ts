/**
 * Decide whether an incoming Agent event belongs to the currently visible
 * transcript. During a session switch the previous runtime may emit trailing
 * events while it is being shut down, so no event is safe to apply.
 */
export function shouldApplyAgentEvent(options: {
  switching: boolean;
  eventSessionId?: string;
  currentSessionId?: string;
}): boolean {
  if (options.switching) return false;

  return !(
    options.eventSessionId &&
    options.currentSessionId &&
    options.eventSessionId !== options.currentSessionId
  );
}
