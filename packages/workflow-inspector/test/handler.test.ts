import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  type World,
} from "@workflow/world";
import { WorkflowRunNotFoundError } from "@workflow/errors";
import { decode } from "cbor-x";
import { BASE_PATH } from "../base-path";
import type { CreateFetchHandler } from "../server/handler";

// The server build, which `bun run build` makes. The CLI serves its files; this
// is the page and the calls it makes. Named by a variable so that the type
// checker does not follow it into the bundle.
const build = "../build/server/index.js";
const built = existsSync(join(import.meta.dir, build));
if (!built)
  console.warn(
    "workflow-inspector handler tests skipped: run bun run build first",
  );
const { createFetchHandler } = (built ? await import(build) : {}) as {
  createFetchHandler: CreateFetchHandler;
};

// Where the dashboard serves it, and what the build is made for.
const base = `http://localhost${BASE_PATH}`;

/** A world that records what the UI asks of it. */
function stubWorld() {
  const world = {
    specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
    listed: 0,
    tokens: [] as string[],
    runs: {
      list: async () => {
        world.listed++;
        return { data: [], cursor: null, hasMore: false };
      },
    },
    chunks: [] as Uint8Array[],
    // Pages like redis-world: a cursor to the next page, null on the last one.
    streams: {
      getChunks: async (
        _runId: string,
        _name: string,
        options: { limit?: number; cursor?: string } = {},
      ) => {
        const start = Number(options.cursor ?? 0);
        const end = Math.min(
          start + (options.limit ?? 100),
          world.chunks.length,
        );
        const hasMore = end < world.chunks.length;
        return {
          data: world.chunks
            .slice(start, end)
            .map((data, index) => ({ index: start + index, data })),
          cursor: hasMore ? String(end) : null,
          hasMore,
          done: false,
        };
      },
    },
    hooks: {
      getByToken: async (token: string) => {
        world.tokens.push(token);
        throw new Error("No such hook");
      },
    },
  };
  return world;
}

async function rpc(
  handle: (request: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await handle(
    new Request(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    }),
  );
  expect(response.status).toBe(200);
  return decode(new Uint8Array(await response.arrayBuffer())) as {
    success: boolean;
    data: any;
  };
}

describe.skipIf(!built)("createFetchHandler", () => {
  const world = stubWorld();
  let handle: (request: Request) => Promise<Response>;
  beforeAll(() => {
    // A stub: only the parts the tests reach.
    handle = createFetchHandler(BASE_PATH, {
      world: world as unknown as World,
    });
  });

  it("serves the page under its base path, without a header of its own", async () => {
    const response = await handle(new Request(`${base}/`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(`${BASE_PATH}/assets/`);
    // The dashboard around it has its own /assets/, which has none of these.
    expect(html).not.toMatch(/["'(]\/assets\//);
  });

  it("names its files under its own path in the scripts too, and the fonts at the dashboard's", () => {
    const directory = join(import.meta.dir, "..", "build", "client", "assets");
    const files = readdirSync(directory);
    const read = (extension: string) =>
      files
        .filter((name) => name.endsWith(extension))
        .map((name) => readFileSync(join(directory, name), "utf8"))
        .join("\n");
    // The manifest, the preloads of lazy chunks and the wasm decoder's URL.
    expect(read(".js")).not.toMatch(/["'`]\/assets\//);
    expect(read(".js")).toContain(`${BASE_PATH}/assets/zstd-`);
    // Only the dashboard serves the two fonts, and at its own /assets/.
    expect(read(".css")).toMatch(/url\(["']?\/assets\/Geist-Variable\.woff2/);
    expect(read(".css")).not.toContain(`${BASE_PATH}/assets/Geist`);
  });

  it("reads the world the host gave it", async () => {
    const before = world.listed;
    const answer = await rpc(handle, "fetchRuns");
    expect(answer.success).toBe(true);
    expect(world.listed).toBe(before + 1);
  });

  it("keeps each handler's own world when another is made", async () => {
    const other = stubWorld();
    const second = createFetchHandler(BASE_PATH, {
      world: other as unknown as World,
    });
    const before = world.listed;
    await rpc(handle, "fetchRuns");
    await rpc(second, "fetchRuns");
    expect(world.listed).toBe(before + 1);
    expect(other.listed).toBe(1);
  });

  it("answers a stream of a missing run with 404 and the error the page reads", async () => {
    const missing = stubWorld();
    missing.streams.getChunks = async () => {
      throw new WorkflowRunNotFoundError("wrun_gone");
    };
    const response = await createFetchHandler(BASE_PATH, {
      world: missing as unknown as World,
    })(new Request(`${base}/api/stream/strm_1?runId=wrun_gone`));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.layer).toBe("API");
    expect(body.message).toContain("not found");
  });

  it("resumes a stream after the chunks it already sent, past one page", async () => {
    const read = async (cursor: string | null) => {
      const query = new URLSearchParams({ runId: "wrun_1" });
      if (cursor) query.set("cursor", cursor);
      const response = await handle(
        new Request(`${base}/api/stream/strm_1?${query}`),
      );
      expect(response.status).toBe(200);
      return {
        chunks: [...new Uint8Array(await response.arrayBuffer())],
        cursor: response.headers.get("X-Stream-Cursor"),
      };
    };
    const write = (from: number, to: number) => {
      for (let i = from; i < to; i++)
        world.chunks.push(new Uint8Array([i % 256]));
    };

    // More than the 500 chunks the route reads per page.
    write(0, 700);
    const first = await read(null);
    expect(first.chunks.length).toBe(700);

    write(700, 710);
    const second = await read(first.cursor);
    expect(second.chunks).toEqual(
      [...Array(10)].map((_, i) => (700 + i) % 256),
    );

    expect((await read(second.cursor)).chunks).toEqual([]);
  });

  it("gives the SDK the host's world, which Resume hook reads", async () => {
    // An app that only records events may never set the SDK's world, so it may
    // hold another one, or none. Seeding it relies on the SDK 5.x private cache key.
    const cache = Symbol.for("@workflow/world//cache");
    const global = globalThis as Record<symbol, unknown>;
    const other = stubWorld();
    const before = global[cache];
    global[cache] = other;
    try {
      const answer = await rpc(handle, "resumeHook", {
        token: "hook_token",
        payload: { approved: true },
      });
      expect(answer.success).toBe(false);
      expect(world.tokens).toEqual(["hook_token"]);
      expect(other.tokens).toEqual([]);
    } finally {
      global[cache] = before;
    }
  });
});
