import { compareSocketSeq } from "./protocol";
import type { SocketBroker, SocketBrokerMessage } from "./socket-types";

// From the global, as @types/bun doesn't export RedisClient from "bun" for the .d.ts build.
type RedisClient = InstanceType<typeof Bun.RedisClient>;

export interface RedisBrokerOptions {
  /** Defaults to `REDIS_URL`, then `redis://localhost:6379`. */
  url?: string;
  /** Emits held while Redis is unreachable; older ones are dropped. Default 1000. */
  queue?: number;
}

/** Exponential backoff from 500 ms to 30 s, with jitter so processes don't reconnect in step. */
export function reconnectDelay(failures: number): number {
  const ceiling = Math.min(30_000, 500 * 2 ** failures);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** How long a call waits for Redis to connect before going on without it. */
const REDIS_WAIT_MS = 1000;

/** One Redis connection that reconnects by itself and reports each fresh connection. */
export function connection(
  url: string | undefined,
  connected: (redis: RedisClient) => void,
) {
  let redis: RedisClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let failures = 0;
  const waiters: (() => void)[] = [];
  const lost = (client: RedisClient) => {
    if (redis !== client) return;
    redis = undefined;
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      start();
    }, reconnectDelay(failures++));
  };
  const start = () => {
    if (closed || redis || timer) return;
    // Bun's own reconnect keeps no subscriptions we can see; a fresh client resubscribes explicitly.
    const client = new Bun.RedisClient(url, {
      autoReconnect: false,
      enableOfflineQueue: false,
    });
    redis = client;
    client.onclose = () => lost(client);
    client.connect().then(
      () => {
        if (redis !== client) return;
        failures = 0;
        connected(client);
        for (const wake of waiters.splice(0)) wake();
      },
      () => lost(client),
    );
  };
  return {
    get(): RedisClient | undefined {
      start();
      return redis?.connected ? redis : undefined;
    },
    /** Resolves after the next connection is made and announced, or after `ms`. */
    opened(ms: number): Promise<void> {
      if (redis?.connected) return Promise.resolve();
      start();
      return new Promise((resolve) => {
        const timeout = setTimeout(resolve, ms);
        waiters.push(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
    close() {
      closed = true;
      clearTimeout(timer);
      for (const wake of waiters.splice(0)) wake();
      const client = redis;
      redis = undefined;
      client?.close();
    },
  };
}

/**
 * Fans socket emits and kicks out across processes through Redis pub/sub, one
 * channel per room topic. An emit is a PUBLISH only: every process, the emitting
 * one included, delivers it once to its own connections. Uses Bun's built-in
 * Redis client and two connections, one to publish and one to subscribe.
 */
export function redisBroker(options: RedisBrokerOptions = {}): SocketBroker {
  const limit = options.queue ?? 1000;
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("redisBroker queue must be a nonnegative integer");
  const channel = (topic: string) => `brick:socket:${topic}`;
  const listeners = new Map<
    string,
    Set<(message: SocketBrokerMessage) => void>
  >();
  const pending = new Map<string, Promise<unknown>>();
  const stream = (topic: string) => `brick:socket:stream:${topic}`;
  // Failures stay non-fatal (an emit is best effort) but leave a trace, once per kind.
  const warned = new Set<string>();
  const warn = (what: string) => (error: unknown) => {
    if (warned.has(what)) return;
    warned.add(what);
    console.warn(
      `[Brick-TS] Redis socket broker: ${what} failed; later failures of it are not logged.`,
      error,
    );
  };
  const queue: ((redis: RedisClient) => void)[] = [];
  const send = (work: (redis: RedisClient) => void) => {
    const redis = publisher.get();
    if (redis) return work(redis);
    queue.push(work);
    if (queue.length > limit) queue.shift();
  };
  const receive = (payload: string, name: string) => {
    let message: SocketBrokerMessage;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    for (const deliver of listeners.get(name) ?? []) deliver(message);
  };
  const subscribe = (redis: RedisClient, name: string) => {
    const done = redis.subscribe(name, receive).catch(warn("SUBSCRIBE"));
    pending.set(name, done);
    void done.then(() => {
      if (pending.get(name) === done) pending.delete(name);
    });
  };
  const publisher = connection(options.url, (redis) => {
    for (const work of queue.splice(0)) work(redis);
  });
  const subscriber = connection(options.url, (redis) => {
    for (const name of listeners.keys()) subscribe(redis, name);
  });
  return {
    publish(message, replay) {
      const name = channel(message.topic);
      if (message.type !== "emit" || !replay)
        return send(
          (redis) =>
            void redis
              .publish(name, JSON.stringify(message))
              .catch(warn("PUBLISH")),
        );
      const key = stream(message.topic);
      send((redis) => {
        // Replies come back in order, so each PUBLISH follows its XADD in emit order.
        void redis
          .send("XADD", [
            key,
            "MAXLEN",
            "~",
            String(replay.keep),
            "*",
            "m",
            message.frame,
          ])
          .then((seq: string) => {
            void redis
              .send("PEXPIRE", [key, String(replay.maxAgeMs)])
              .catch(warn("PEXPIRE"));
            return redis.publish(name, JSON.stringify({ ...message, seq }));
          })
          .catch(warn("XADD/PUBLISH"));
      });
    },
    async head() {
      try {
        await publisher.opened(REDIS_WAIT_MS);
        const [seconds, micros] = (await publisher.get()!.send("TIME", [])) as [
          string,
          string,
        ];
        return `${Number(seconds) * 1000 + Math.floor(Number(micros) / 1000) - 1}-0`;
      } catch {
        return `${Date.now() - 1}-0`;
      }
    },
    async history(topic, since, replay) {
      let raw: [string, string[]][];
      try {
        await publisher.opened(REDIS_WAIT_MS);
        raw = await publisher.get()!.send("XRANGE", [stream(topic), "-", "+"]);
      } catch {
        return undefined;
      }
      const ms = (seq: string) => Number(seq.split("-")[0]);
      const after = raw.filter(([id]) => compareSocketSeq(id, since) > 0);
      // Nothing kept at or before `since`: entries after it may have been trimmed or expired.
      if (
        after.length === raw.length &&
        (raw.length >= replay.keep ||
          (raw[0] ? ms(raw[0][0]) : Date.now()) - ms(since) >= replay.maxAgeMs)
      )
        return undefined;
      return after.map(([seq, fields]) => ({
        type: "emit" as const,
        topic,
        frame: fields[fields.indexOf("m") + 1]!,
        seq,
      }));
    },
    subscribe(topic, deliver) {
      const name = channel(topic);
      let local = listeners.get(name);
      if (!local) {
        local = new Set();
        listeners.set(name, local);
        const redis = subscriber.get();
        if (redis) subscribe(redis, name);
      }
      local.add(deliver);
      return () => {
        local.delete(deliver);
        if (local.size || listeners.get(name) !== local) return;
        listeners.delete(name);
        pending.delete(name);
        void subscriber.get()?.unsubscribe(name).catch(warn("UNSUBSCRIBE"));
      };
    },
    async ready(topic) {
      const name = channel(topic);
      // Wait briefly for Redis, so a join is acknowledged once its emits can arrive.
      if (!pending.has(name)) await subscriber.opened(REDIS_WAIT_MS);
      await pending.get(name);
    },
    close() {
      publisher.close();
      subscriber.close();
    },
  };
}
