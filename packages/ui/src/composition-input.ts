export interface CompositionKeyboardEvent {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * An IME uses Enter to commit a candidate before React receives the completed
 * value. In that state the keystroke must reach the native input unchanged.
 */
export function shouldSubmitOnEnter(
  event: CompositionKeyboardEvent,
  composing: boolean,
): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !composing
    && !event.isComposing
    && event.keyCode !== 229;
}
