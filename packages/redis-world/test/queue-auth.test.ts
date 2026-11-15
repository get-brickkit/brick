import { QUEUE_AUTH_HEADER, verifyQueueAuthKey } from "@workflow/utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorldQueue,
  type Deliver,
  type QueueBackend,
} from "../src/world-queue.js";

const KEY = process.env.WORKFLOW_QUEUE_AUTH_KEY!;
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const queue of opened.splice(0)) await queue.close();
});

function open(config: { queueAuthKey?: string } = {}) {
  let deliver: Deliver | undefined;
  const backend: QueueBackend = {
    enqueue: async (message) => message.messageId,
    start: async (d) => void (deliver = d),
    close: async () => {},
    getQueueStats: async () => ({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    }),
  };
  const queue = createWorldQueue(
    backend,
    { baseUrl: "http://localhost:1", httpTimeoutMs: 1000, ...config },
    { debug: () => {} },
  );
  opened.push(queue);
  return { queue, deliver: () => deliver! };
}

describe("queue auth", () => {
  it("declares loopback and sends the key with every delivery", async () => {
    const { queue, deliver } = open();
    expect(queue.queueAuthMode).toBe("loopback");
    let seen: string | null = null;
    queue.registerHandler?.("__wkf_workflow_" as any, async (req) => {
      seen = req.headers.get(QUEUE_AUTH_HEADER);
      return Response.json({ ok: true });
    });
    await queue.start();
    await deliver()({
      messageId: "msg_1" as any,
      queueName: "__wkf_workflow_w" as any,
      message: "{}",
      attempt: 1,
      deliveryCount: 1,
      createdAt: Date.now(),
    });
    expect(seen).toBe(KEY);
  });

  it("makes the runtime accept its key and nothing else, until it closes", async () => {
    const { queue } = open();
    expect(await verifyQueueAuthKey(KEY)).toBe(true);
    expect(
      await verifyQueueAuthKey(
        KEY.replace(/^./, (c) => (c === "A" ? "B" : "A")),
      ),
    ).toBe(false);
    expect(await verifyQueueAuthKey(null)).toBe(false);
    await queue.close();
    opened.length = 0;
    expect(await verifyQueueAuthKey(KEY)).toBe(false);
  });

  it("refuses to start without a well-formed key", () => {
    const saved = process.env.WORKFLOW_QUEUE_AUTH_KEY;
    delete process.env.WORKFLOW_QUEUE_AUTH_KEY;
    try {
      expect(() => open()).toThrow("Set WORKFLOW_QUEUE_AUTH_KEY");
      expect(() => open({ queueAuthKey: "short" })).toThrow(
        "is not a queue auth key",
      );
    } finally {
      process.env.WORKFLOW_QUEUE_AUTH_KEY = saved;
    }
  });
});
