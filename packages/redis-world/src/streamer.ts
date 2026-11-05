import { EventEmitter } from "node:events";
import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from "@workflow/world";
import type { Redis } from "ioredis";
import { keys } from "./keys.js";
import { debug } from "./util.js";

interface StreamPublishMessage {
  runId: string;
  streamId: string;
  entryId: string;
  /** Base64 chunk, inline so subscribers need no XRANGE per notification. */
  data: string;
  eof: boolean;
  /**
   * The entry that came before this one in the stream ('' for the first).
   * Pub/sub does not guarantee delivery, so a reader that sees an entry whose
   * predecessor is not the last one it delivered knows a message was lost and
   * reads the stream instead of skipping it.
   */
  prevId: string;
}

function parseStreamPublishMessage(raw: string): StreamPublishMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { runId, streamId, entryId, data, eof, prevId } = parsed as Record<
    string,
    unknown
  >;
  if (typeof runId !== "string" || typeof streamId !== "string") return null;
  if (typeof entryId !== "string" || typeof prevId !== "string") return null;
  if (typeof data !== "string" || typeof eof !== "boolean") return null;
  return { runId, streamId, entryId, data, eof, prevId };
}

interface StreamChunkEvent {
  id: string;
  data: Uint8Array;
  eof: boolean;
  /** Set on live notifications: see `StreamPublishMessage.prevId`. */
  prevId?: string;
}

/** A reader also re-reads the stream this often, in case a notification and the
 * reconnect hook both missed something. Notifications are the fast path. */
const CATCH_UP_INTERVAL_MS = 2_000;

/**
 * Compare two Redis stream entry IDs (`<ms>-<seq>`) numerically.
 *
 * String comparison is NOT safe here: within one millisecond `...-10` compares
 * lexicographically smaller than `...-9`, which would drop chunks (and the eof
 * marker) once the sequence number crosses a digit boundary.
 */
function compareStreamEntryIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split("-").map(Number);
  const [bMs, bSeq] = b.split("-").map(Number);
  return aMs - bMs || aSeq - bSeq;
}

interface StreamerConfig {
  redis: Redis;
  keyPrefix: string;
}

/**
 * Append one or more chunks, index the stream under its run, and notify
 * subscribers in one round trip. The publish could not be pipelined with the
 * append because it needs the entry ID `XADD` generates; Lua makes that
 * dependency server-side. Each chunk rides along in its message so subscribers
 * do not `XRANGE` per notification.
 *
 * A stream that already holds its eof marker is closed: the append is dropped
 * and nothing is published. Readers stop at the first eof anyway, so this only
 * keeps the invariant that the eof marker, when present, is the final entry.
 * `getInfo` relies on it to answer from `XLEN` and the tail entry alone, and a
 * producer retrying a lost-ACK `close()` would otherwise break it.
 *
 * KEYS[1] = stream key
 * KEYS[2] = streams-by-run key
 * ARGV[1] = notification channel
 * ARGV[2] = run ID
 * ARGV[3] = stream name
 * ARGV[4] = 'true' | 'false' (eof marker, applied to every chunk below)
 * ARGV[5..] = base64 chunk data, in write order
 * Returns: 1 if appended, 0 if the stream was already closed
 */
const LUA_APPEND_AND_PUBLISH = `
  local streamKey = KEYS[1]
  local runIndexKey = KEYS[2]
  local channel = ARGV[1]
  local runId = ARGV[2]
  local streamId = ARGV[3]
  local eof = ARGV[4]

  local tail = redis.call('XREVRANGE', streamKey, '+', '-', 'COUNT', 1)
  if #tail > 0 and tail[1][2][4] == 'true' then
    return 0
  end

  local prevId = ''
  if #tail > 0 then
    prevId = tail[1][1]
  end

  for i = 5, #ARGV do
    local data = ARGV[i]
    local entryId = redis.call('XADD', streamKey, '*', 'data', data, 'eof', eof)
    redis.call('PUBLISH', channel, cjson.encode({
      runId = runId,
      streamId = streamId,
      entryId = entryId,
      data = data,
      eof = eof == 'true',
      prevId = prevId
    }))
    prevId = entryId
  end
  redis.call('SADD', runIndexKey, streamId)
  return 1
`;

/** An XRANGE entry, by the field order `LUA_APPEND_AND_PUBLISH` writes: data, then eof. */
function decodeEntry([id, fields]: [string, string[]]): StreamChunkEvent {
  return {
    id,
    data: Buffer.from(fields[1]!, "base64"),
    eof: fields[3] === "true",
  };
}

type RedisWithStreamScript = Redis & {
  wfStreamAppend(...args: string[]): Promise<number>;
};

/**
 * Create a streamer implementation using Redis Streams.
 *
 * Uses Redis auto-generated stream entry IDs (timestamp-sequence format)
 * instead of custom IDs, since Redis Streams require IDs in
 * `<millisecondsTime>-<sequenceNumber>` format.
 *
 * Key layout (every key is scoped to the run that owns the stream, so two runs
 * can use the same stream name without sharing chunks):
 * - `<prefix>stream:<runId>:<name>`   Redis Stream of the chunks plus the eof marker
 * - `<prefix>streams:by_run:<runId>`  Set of the run's stream names
 * - `<prefix>stream_notify`           pub/sub channel carrying live chunks
 */
export function createStreamer(
  config: StreamerConfig,
): Streamer & { close(): Promise<void> } {
  const { redis, keyPrefix } = config;
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const tails = new Map<string, Promise<unknown>>();

  // Serialize work per stream key, so concurrent pub/sub notifications for the
  // same stream are processed in order. A key's tail is dropped once it settles last.
  const withStreamMutex = <T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };

  redis.defineCommand("wfStreamAppend", {
    numberOfKeys: 2,
    lua: LUA_APPEND_AND_PUBLISH,
  });
  const scripted = redis as RedisWithStreamScript;

  // `streamsByRunKey` indexes a run's stream names, populated on every
  // write/close so `streams.list` can enumerate them.
  const {
    streamKey,
    streamsByRunKey,
    streamChannel: STREAM_CHANNEL,
  } = keys(keyPrefix);
  const emitterKey = (runId: string, name: string) =>
    `strm:${runId}:${name}` as const;

  // Set up pub/sub subscriber for stream notifications
  const subscriber = redis.duplicate();

  // CRITICAL: Must await subscribe() to avoid race condition where PUBLISH happens before SUBSCRIBE is ready
  // This was causing workflows to hang because completion events were published but never received
  const subscriptionReady: Promise<void> = subscriber
    .subscribe(STREAM_CHANNEL)
    .then(() => {});

  // Anything published while the subscriber connection was down is gone, so on
  // every reconnect the live readers re-read their streams.
  const resync = new EventEmitter();
  resync.setMaxListeners(0);
  let subscriberConnected = false;
  subscriber.on("ready", () => {
    if (subscriberConnected) resync.emit("resync");
    subscriberConnected = true;
  });

  subscriber.on("message", async (channel, message) => {
    if (channel !== STREAM_CHANNEL) return;

    try {
      const parsed = parseStreamPublishMessage(message);
      if (!parsed) return;

      const key = emitterKey(parsed.runId, parsed.streamId);
      if (!events.listenerCount(key)) {
        return;
      }

      await withStreamMutex(key, async () => {
        // The chunk travels with the notification, so no XRANGE per message.
        events.emit(key, {
          id: parsed.entryId,
          data: Buffer.from(parsed.data, "base64"),
          eof: parsed.eof,
          prevId: parsed.prevId,
        });
      });
    } catch (error) {
      console.error("Error processing stream notification:", error);
    }
  });

  const toBase64 = (chunk: string | Uint8Array): string =>
    (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString("base64");

  const append = async (
    runId: string,
    name: string,
    eof: boolean,
    encodedChunks: string[],
  ): Promise<void> => {
    // CRITICAL: Wait for subscription to be ready before publishing
    // Otherwise the message might be published before anyone is subscribed
    await subscriptionReady;

    await scripted.wfStreamAppend(
      streamKey(runId, name),
      streamsByRunKey(runId),
      STREAM_CHANNEL,
      runId,
      name,
      eof ? "true" : "false",
      ...encodedChunks,
    );
  };

  return {
    streams: {
      async write(
        _runId: string | Promise<string>,
        name: string,
        chunk: string | Uint8Array,
      ): Promise<void> {
        // Await runId if it's a promise to ensure proper flushing
        const runId = await _runId;
        await append(runId, name, false, [toBase64(chunk)]);
      },

      async writeMulti(
        _runId: string | Promise<string>,
        name: string,
        chunks: (string | Uint8Array)[],
      ): Promise<void> {
        if (chunks.length === 0) return;

        // Await runId if it's a promise to ensure proper flushing
        const runId = await _runId;

        // One script call appends every chunk, so they land contiguously and
        // in array order.
        await append(runId, name, false, chunks.map(toBase64));
      },

      async close(
        _runId: string | Promise<string>,
        name: string,
      ): Promise<void> {
        // Await runId if it's a promise to ensure proper flushing
        const runId = await _runId;

        // Final chunk carries eof=true. Same single-round-trip append as
        // above, which also keeps the stream indexed when it closes without
        // any data.
        await append(runId, name, true, [""]);
      },

      async get(
        runId: string,
        name: string,
        startIndex?: number,
      ): Promise<ReadableStream<Uint8Array>> {
        const key = emitterKey(runId, name);
        const cleanups: (() => void)[] = [];
        let cleanedUp = false;
        // Idempotent: reachable from eof, cancel() and a failed initial read,
        // and more than one of them can fire for the same reader (for example
        // cancel() while the initial XRANGE is in flight).
        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          for (const fn of cleanups) fn();
        };

        return new ReadableStream<Uint8Array>({
          async start(controller) {
            // Track last entry ID for ordering
            let lastEntryId = "";
            let offset = startIndex ?? 0;
            let buffer = [] as StreamChunkEvent[] | null;

            function enqueue(msg: StreamChunkEvent) {
              // The reader was cancelled while the initial read was in flight,
              // or the eof marker was already delivered. Nothing may be
              // enqueued on the controller any more.
              if (cleanedUp) return;

              // Already delivered, or out of order.
              if (
                lastEntryId !== "" &&
                compareStreamEntryIds(lastEntryId, msg.id) >= 0
              )
                return;
              // Record the entry before the offset check: an entry skipped by
              // the offset must not be skipped (and counted) a second time when
              // it shows up again as a buffered live message.
              lastEntryId = msg.id;

              // The eof marker is not a data chunk (`getInfo`'s tailIndex
              // excludes it), so it never counts toward the offset: a start
              // index at or past the data count must still close the stream
              // rather than consume the marker and then hang.
              if (offset > 0 && !msg.eof) {
                offset--;
                return;
              }

              if (msg.data.byteLength) {
                controller.enqueue(new Uint8Array(msg.data));
              }
              if (msg.eof) {
                cleanup();
                controller.close();
              }
            }

            // Read what the stream holds beyond the last delivered entry. Notifications
            // are fire-and-forget, so this is how a lost one is recovered. Runs one
            // at a time; a request that arrives meanwhile triggers one more pass.
            let catchingUp = false;
            let again = false;
            async function catchUp() {
              if (cleanedUp || buffer) return;
              if (catchingUp) {
                again = true;
                return;
              }
              catchingUp = true;
              try {
                do {
                  again = false;
                  const entries = await redis.xrange(
                    streamKey(runId, name),
                    lastEntryId === "" ? "-" : `(${lastEntryId}`,
                    "+",
                  );
                  for (const entry of entries) enqueue(decodeEntry(entry));
                } while (again && !cleanedUp);
              } catch (error) {
                // Transient (connection loss): the next trigger reads again.
                debug("Stream catch-up failed:", error);
              } finally {
                catchingUp = false;
              }
            }

            // A live notification. One whose predecessor we never delivered means an
            // earlier one was lost: read the stream rather than skip past it.
            function deliverLive(data: StreamChunkEvent) {
              if (data.prevId !== undefined && data.prevId !== lastEntryId) {
                void catchUp();
                return;
              }
              enqueue(data);
            }

            function onData(data: StreamChunkEvent) {
              if (buffer) {
                buffer.push(data);
                return;
              }
              deliverLive(data);
            }

            // Subscribe before reading history so nothing published in between
            // is missed; `buffer` holds those until the history is replayed.
            events.on(key, onData);
            cleanups.push(() => {
              events.off(key, onData);
            });

            // Read all historical chunks from Redis Stream
            // XRANGE reads entries from start to end
            const chunks = await redis
              .xrange(streamKey(runId, name), "-", "+")
              .catch((err) => {
                // A failed read fails the stream; detach the listener so a
                // failing stream does not leak one per attempt.
                cleanup();
                throw err;
              });

            const parsedChunks = chunks.map(decodeEntry);

            // Resolve a negative start index against the data chunks stored
            // right now (everything before the eof marker): -3 on a stream
            // with 10 chunks starts at chunk 7. Clamped to 0.
            if (offset < 0) {
              const firstEof = parsedChunks.findIndex((chunk) => chunk.eof);
              const dataCount =
                firstEof === -1 ? parsedChunks.length : firstEof;
              offset = Math.max(0, dataCount + offset);
            }

            // From now on, process chunks in real-time
            const buffered = buffer ?? [];
            buffer = null;

            // The history is the stream as it was read, so it goes in as is. What was
            // buffered while it was read is live traffic, and a message lost there
            // would leave a hole, so it goes through the same gap check.
            for (const chunk of parsedChunks) {
              enqueue(chunk);
            }
            for (const chunk of buffered) {
              deliverLive(chunk);
            }

            // Cover a notification lost while the history was being read, after a
            // reconnect, and by a timer in case both miss.
            resync.on("resync", catchUp);
            const timer = setInterval(
              () => void catchUp(),
              CATCH_UP_INTERVAL_MS,
            );
            timer.unref();
            cleanups.push(() => {
              resync.off("resync", catchUp);
              clearInterval(timer);
            });
            await catchUp();
          },
          cancel() {
            cleanup();
          },
        });
      },

      async list(runId: string): Promise<string[]> {
        return (await redis.smembers(streamsByRunKey(runId))) ?? [];
      },

      async getChunks(
        runId: string,
        name: string,
        options?: GetChunksOptions,
      ): Promise<StreamChunksResponse> {
        const limit = Math.min(options?.limit ?? 100, 1000);

        // Cursor carries the running 0-based data-chunk index plus the last
        // returned entry ID, letting us resume with a bounded XRANGE instead of
        // rescanning the whole stream on every page.
        let dataIndex = 0;
        let start = "-";
        if (options?.cursor) {
          try {
            const decoded = JSON.parse(
              Buffer.from(options.cursor, "base64").toString("utf-8"),
            ) as {
              i?: number;
              id?: string;
            };
            if (typeof decoded.i === "number") dataIndex = decoded.i;
            // '(' makes the range start exclusive of the last returned entry.
            if (typeof decoded.id === "string") start = `(${decoded.id}`;
          } catch {
            // Malformed cursor -> restart from the beginning of the stream.
            dataIndex = 0;
            start = "-";
          }
        }

        // Fetch one extra entry to detect whether more data pages follow.
        const entries = await redis.xrange(
          streamKey(runId, name),
          start,
          "+",
          "COUNT",
          limit + 1,
        );

        const data: StreamChunk[] = [];
        let done = false;
        let hasMore = false;
        let lastId: string | null = null;

        for (const entry of entries) {
          const { id, data: bytes, eof } = decodeEntry(entry);
          if (eof) {
            // The eof marker is always the terminal entry, so reaching it means
            // the stream is complete and no further data pages exist.
            done = true;
            break;
          }
          if (data.length >= limit) {
            // A data entry beyond the requested page: more pages remain.
            hasMore = true;
            break;
          }
          data.push({
            index: dataIndex,
            data: new Uint8Array(bytes),
          });
          dataIndex++;
          lastId = id;
        }

        const cursor =
          hasMore && lastId
            ? Buffer.from(
                JSON.stringify({ i: dataIndex, id: lastId }),
              ).toString("base64")
            : null;

        return { data, cursor, hasMore, done };
      },

      async getInfo(runId: string, name: string): Promise<StreamInfoResponse> {
        const key = streamKey(runId, name);
        const [length, tail] = await Promise.all([
          redis.xlen(key),
          redis.xrevrange(key, "+", "-", "COUNT", 1),
        ]);
        // The eof marker is always the final entry (the append script drops
        // anything written after it, and auto-generated IDs are monotonic), so
        // the last entry alone tells us whether the stream is done. Data chunks
        // are the non-eof entries; an empty stream yields tailIndex -1.
        const done = tail.length > 0 && tail[0][1][3] === "true";
        const dataCount = length - (done ? 1 : 0);
        return { tailIndex: dataCount - 1, done };
      },
    },

    async close(): Promise<void> {
      // Tear down the duplicated pub/sub connection so short-lived processes
      // do not leak it.
      await subscriber.quit();
    },
  };
}
