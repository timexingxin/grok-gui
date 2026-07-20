import type { Message } from "@grok-gui/core";

/** Text placed on the clipboard; internal reasoning and tool traces stay private. */
export function copyableMessageText(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** A tool/reasoning-only record has no user-visible answer to copy. */
export function canCopyMessage(message: Message): boolean {
  return copyableMessageText(message).trim().length > 0;
}
