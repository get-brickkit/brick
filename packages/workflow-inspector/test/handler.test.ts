import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SPEC_VERSION_SUPPORTS_SLOT_IDENTITY } from "@workflow/world";
import { decode } from "cbor-x";

// The server build, which `bun run build` makes. The CLI serves its files; this
// is the page and the calls it makes. Named by a variable so that the type
// checker does not follow it into the bundle.
const build = "../build/server/index.js";
const { createFetchHandler } = (await import(build)) as {
  createFetchHandler(
    basename: string,
    host: { world: unknown },
  ): (request: Request) => Promise<Response>;
};

// Where the dashboard serves it, and what the build is made for (Vite `base`).
const base = "http://localhost/workflows";

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

describe("createFetchHandler", () => {
  const world = stubWorld();
  let handle: (request: Request) => Promise<Response>;
  beforeAll(() => {
    handle = createFetchHandler("/workflows", { world });
  });

  it("serves the page under its base path, without a header of its own", async () => {
    const response = await handle(new Request(`${base}/`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("/workflows/assets/");
    // The dashboard around it has its own /assets/, which has none of these.
    expect(html).not.toMatch(/["'(]\/assets\//);
    // The dashboard around it has the navigation, the health probe and the theme switch.
    for (const header of ["Connected to", "Health Check", "Workflow Logo"])
      expect(html).not.toContain(header);
    // It takes the theme of the page that frames it, before first paint.
    expect(html).toContain("window.parent.document.documentElement");
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
    expect(read(".js")).toContain("/workflows/assets/zstd-");
    // Only the dashboard serves the two fonts, and at its own /assets/.
    expect(read(".css")).toMatch(/url\(["']?\/assets\/Geist-Variable\.woff2/);
    expect(read(".css")).not.toContain("/workflows/assets/Geist");
  });

  it("reads the world the host gave it", async () => {
    const before = world.listed;
    const answer = await rpc(handle, "fetchRuns");
    expect(answer.success).toBe(true);
    expect(world.listed).toBe(before + 1);
  });

  it("gives the SDK the host's world, which Resume hook reads", async () => {
    // An app that only records events may never set the SDK's world, so it may
    // hold another one, or none.
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
      expect(global[cache]).toBe(world);
    } finally {
      global[cache] = before;
    }
  });
});
