import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { brick } from "@brickkit/core";
import { INSPECTOR_TOKEN_HEADER } from "../src/dashboard-protocol";
import { startInspector } from "../src/dev-inspector";

const built = join(import.meta.dir, "..", "inspector-dist");

describe("startInspector", () => {
  it("serves the inspector for the app's own world, to the dashboard only", async () => {
    // All the inspector reads of an app is its world.
    const world = {
      listed: 0,
      runs: {
        list: async () => {
          world.listed++;
          return { data: [], cursor: null, hasMore: false };
        },
      },
    };
    const app = { events: { workflows: { world } } };
    const inspector = await startInspector(app as never);
    try {
      expect(inspector).toBeDefined();
      const base = `http://127.0.0.1:${inspector!.port}`;
      const headers = { [INSPECTOR_TOKEN_HEADER]: inspector!.token };

      expect((await fetch(`${base}/workflows/`)).status).toBe(403);
      const page = await fetch(`${base}/workflows/`, { headers });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");

      // The UI lists runs through the world the app gave it.
      const rpc = await fetch(`${base}/workflows/api/rpc`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ method: "fetchRuns", params: {} }),
      });
      expect(rpc.status).toBe(200);
      expect(world.listed).toBe(1);
    } finally {
      inspector?.stop();
    }
  });

  it("serves the page's scripts and styles from the build, to keep", async () => {
    const inspector = await startInspector({
      events: { workflows: { world: {} } },
    } as never);
    try {
      const base = `http://127.0.0.1:${inspector!.port}`;
      const headers = { [INSPECTOR_TOKEN_HEADER]: inspector!.token };
      const styles = readdirSync(join(built, "client", "assets")).find((name) =>
        name.endsWith(".css"),
      )!;

      const asset = await fetch(`${base}/workflows/assets/${styles}`, {
        headers,
      });
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/css");
      expect(asset.headers.get("cache-control")).toContain("immutable");
      // The page names them under the path it is served at.
      const page = await (
        await fetch(`${base}/workflows/`, { headers })
      ).text();
      expect(page).toContain(`/workflows/assets/`);

      // Nothing else under assets/ is a file: a name the build lacks, a folder,
      // a path through a file, a name no file system takes. A plain 404, not the
      // page (which answers HTML) and not a server error.
      for (const path of [
        "assets/missing.js",
        "assets/",
        `assets/${styles}/x`,
        `assets/${"a".repeat(300)}`,
      ]) {
        const other = await fetch(`${base}/workflows/${path}`, { headers });
        expect(other.status).toBe(404);
        expect(await other.text()).toBe("Not found");
        expect(other.headers.get("cache-control") ?? "").not.toContain(
          "immutable",
        );
      }
    } finally {
      inspector?.stop();
    }
  });

  it("does nothing for an app that runs no workflows", async () => {
    expect(
      await startInspector(brick({ services: [], docs: false })),
    ).toBeUndefined();
  });

  it("says how to build it when the build is missing", async () => {
    const app = { events: { workflows: { world: {} } } };
    await expect(
      startInspector(app as never, join(built, "nowhere")),
    ).rejects.toThrow("not built");
  });
});
