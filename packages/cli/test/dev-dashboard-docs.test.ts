import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevDashboard } from "../src/dev-dashboard";
import { DocsHost } from "../src/dev-docs";
import { DevTelemetryStore } from "../src/dev-telemetry-store";
import { PNG } from "./helpers";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function setup(
  documentation?: { dir: string; components?: string },
  files: Record<string, string | Buffer> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "brick-docs-routes-"));
  roots.push(root);
  const all: Record<string, string | Buffer> = {
    "docs/index.mdx": "---\ntitle: Home\n---\n\nWelcome to the docs.\n",
    "docs/guide/setup.mdx":
      "---\ntitle: Setup\n---\n\n## Install\n\nRun the installer.\n",
    "docs/pic.png": PNG,
    "secret.png": "outside",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const store = new DevTelemetryStore();
  const host = new DocsHost(
    (docs) => store.setDocs(docs),
    () => {},
  );
  if (documentation) await host.configure(root, documentation);
  const dashboard = await startDevDashboard({
    port: 0,
    store,
    docs: () => host.current,
  });
  const base = `http://localhost:${dashboard.port}`;
  return {
    base,
    store,
    host,
    stop() {
      dashboard.stop();
      host.close();
    },
  };
}

describe("dashboard docs routes", () => {
  it("serves the tree, compiled pages, search, and files of the app's docs", async () => {
    const { base, store, stop } = await setup({ dir: "./docs" });
    try {
      // The snapshot says docs exist, so the page can show its tab.
      const snapshot = await (await fetch(`${base}/api/state`)).json();
      expect(snapshot.docs).toMatchObject({ status: "ready", revision: 1 });
      expect(store.snapshot().docs?.status).toBe("ready");

      const info = await (await fetch(`${base}/api/docs`)).json();
      expect(
        info.tree.children.map((node: { name: string }) => node.name),
      ).toEqual(["Home", "Guide"]);
      expect(info.components).toBe(false);

      const page = await fetch(`${base}/api/docs/page/guide/setup`);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.json()).toMatchObject({
        title: "Setup",
        path: "guide/setup.mdx",
        toc: [{ title: "Install", url: "#install", depth: 2 }],
      });
      // The home page is the empty path, with or without a trailing slash.
      expect((await (await fetch(`${base}/api/docs/page`)).json()).title).toBe(
        "Home",
      );
      expect((await (await fetch(`${base}/api/docs/page/`)).json()).title).toBe(
        "Home",
      );
      expect((await fetch(`${base}/api/docs/page/nope`)).status).toBe(404);

      const hits = await (
        await fetch(`${base}/api/docs/search?q=installer`)
      ).json();
      expect(hits.map((hit: { url: string }) => hit.url)).toContain(
        "/guide/setup",
      );
      expect(await (await fetch(`${base}/api/docs/search`)).json()).toEqual([]);
    } finally {
      stop();
    }
  });

  it("serves images from the docs folder, never anything outside it", async () => {
    const { base, stop } = await setup({ dir: "./docs" });
    try {
      const image = await fetch(`${base}/api/docs/files/pic.png`);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");
      // Opened on its own, an image (an SVG, say) cannot run scripts.
      expect(image.headers.get("content-security-policy")).toBe("sandbox");
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);

      for (const path of [
        "../secret.png",
        "..%2Fsecret.png",
        "%2e%2e/secret.png",
        "guide/../../secret.png",
        "missing.png",
        "index.mdx",
        "%E0%A4%A",
      ]) {
        const response = await fetch(`${base}/api/docs/files/${path}`);
        expect([400, 404]).toContain(response.status);
      }
    } finally {
      stop();
    }
  });

  it("serves the project's components bundle, and says when there is none", async () => {
    const { base, stop } = await setup(
      { dir: "./docs", components: "./docs/components.tsx" },
      {
        "docs/components.tsx":
          "export const Badge = () => <b>badge</b>;\nexport const components = { Badge };\n",
      },
    );
    try {
      expect((await (await fetch(`${base}/api/docs`)).json()).components).toBe(
        true,
      );
      const bundle = await fetch(`${base}/api/docs/components.js`);
      expect(bundle.headers.get("content-type")).toContain("text/javascript");
      expect(bundle.headers.get("cache-control")).toBe("no-store");
      expect(await bundle.text()).toContain("Badge");
    } finally {
      stop();
    }

    const plain = await setup({ dir: "./docs" });
    try {
      expect((await fetch(`${plain.base}/api/docs/components.js`)).status).toBe(
        404,
      );
    } finally {
      plain.stop();
    }
  });

  it("explains a components module that does not build", async () => {
    const { base, stop } = await setup(
      { dir: "./docs", components: "./docs/components.tsx" },
      { "docs/components.tsx": "export const x = ;\n" },
    );
    try {
      const response = await fetch(`${base}/api/docs/components.js`);
      expect(response.status).toBe(500);
      expect((await response.text()).length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  it("has no docs routes for an app without documentation", async () => {
    const { base, stop } = await setup();
    try {
      expect((await (await fetch(`${base}/api/state`)).json()).docs).toBeNull();
      for (const path of [
        "",
        "/page/x",
        "/search?q=a",
        "/files/pic.png",
        "/components.js",
      ])
        expect((await fetch(`${base}/api/docs${path}`)).status).toBe(404);
    } finally {
      stop();
    }
  });
});
