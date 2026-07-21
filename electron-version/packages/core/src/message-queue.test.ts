import { describe, expect, it } from "vitest";
import type { QueuedMessage } from "./types";
import {
  deleteQueuedMessage,
  editQueuedMessage,
  enqueueMessage,
  guideQueuedMessage,
  takeNextQueuedMessage,
} from "./message-queue";

const first: QueuedMessage = { id: "one", text: "first", createdAt: 1 };
const second: QueuedMessage = { id: "two", text: "second", createdAt: 2 };
const third: QueuedMessage = { id: "three", text: "third", createdAt: 3 };

describe("message queue", () => {
  it("dispatches messages in FIFO order", () => {
    const queue = enqueueMessage(enqueueMessage([], first), second);
    expect(takeNextQueuedMessage(queue)).toEqual({ next: first, remaining: [second] });
  });

  it("moves a guided message to the next dispatch slot", () => {
    const queue = guideQueuedMessage([first, second, third], third.id);
    expect(queue.map((message) => message.id)).toEqual(["three", "one", "two"]);
    expect(queue[0]).toMatchObject({ guided: true });
    expect(queue.slice(1).every((message) => !message.guided)).toBe(true);
  });

  it("replaces only the queued message being edited", () => {
    const queue = editQueuedMessage([first, second], second.id, "updated");
    expect(queue).toEqual([first, { ...second, text: "updated" }]);
  });

  it("removes a queued message without changing the remaining order", () => {
    expect(deleteQueuedMessage([first, second, third], second.id)).toEqual([first, third]);
  });
});
