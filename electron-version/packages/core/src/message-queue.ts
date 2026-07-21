import type { QueuedMessage } from "./types";

/** Append a local follow-up without changing the dispatch order. */
export function enqueueMessage(
  queue: QueuedMessage[],
  message: QueuedMessage,
): QueuedMessage[] {
  return [...queue, message];
}

/** Put exactly one follow-up next, preserving the relative order of all others. */
export function guideQueuedMessage(
  queue: QueuedMessage[],
  id: string,
): QueuedMessage[] {
  const selected = queue.find((message) => message.id === id);
  if (!selected) return queue;
  return [
    { ...selected, guided: true },
    ...queue
      .filter((message) => message.id !== id)
      .map((message) => ({ ...message, guided: false })),
  ];
}

export function editQueuedMessage(
  queue: QueuedMessage[],
  id: string,
  text: string,
): QueuedMessage[] {
  const normalized = text.trim();
  if (!normalized) return queue;
  return queue.map((message) => message.id === id ? { ...message, text: normalized } : message);
}

export function deleteQueuedMessage(queue: QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((message) => message.id !== id);
}

export function takeNextQueuedMessage(queue: QueuedMessage[]): {
  next: QueuedMessage | null;
  remaining: QueuedMessage[];
} {
  const [next, ...remaining] = queue;
  return { next: next ?? null, remaining };
}
