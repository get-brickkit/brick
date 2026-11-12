import { describe, expect, it } from "bun:test";
import {
  DASHBOARD_IDENTITY_HEADER,
  dashboardUser,
  signDashboardIdentity,
} from "@brickkit/core";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mergeExtensions,
  mergeNav,
  type DashboardExtension,
  type NavItem,
} from "../dashboard/extension-registry";
import { loadParts } from "../dashboard/extension";
import { parseRoute } from "../dashboard/state";
import { buildApplication } from "../src/build";
import {
  buildDashboardExtension,
  THEME_TOKENS,
  themeCss,
} from "../src/dashboard-extension";
import { startDevDashboard } from "../src/dev-dashboard";
import { DevTelemetryStore } from "../src/dev-telemetry-store";

const fixture = join(import.meta.dir, "fixtures/dashboard-extension");
const entry = join(fixture, "index.tsx");
const Page = () => null;

const builtIn: NavItem[] = ["overview", "requests", "errors"].map((view) => ({
  key: view,
  view: view as NavItem["view"],
  label: view,
  href: `#/${view}`,
}));
const keys = (nav: NavItem[]) => nav.map((item) => item.key);

describe("mergeNav", () => {
  it("places pages after a page, under a section, or at the end, and links too", () => {
    const extension: DashboardExtension = {
      pages: [
        { id: "billing", label: "Billing", section: "Ops", component: Page },
        { id: "queues", label: "Queues", after: "overview", component: Page },
        { id: "jobs", label: "Jobs", after: "queues", component: Page },
        { id: "notes", label: "Notes", component: Page },
        { id: "cron", label: "Cron", section: "Ops", url: "/app/cron" },
        // Placed after a page declared later.
        { id: "dlq", label: "DLQ", after: "late", component: Page },
        { id: "late", label: "Late", component: Page },
      ],
      sidebar: [
        { label: "Grafana", href: "https://grafana.internal" },
        { label: "Admin", href: "#/x/queues", after: "errors" },
      ],
    };
    const nav = mergeNav(builtIn, extension, false);
    expect(keys(nav)).toEqual([
      "overview",
      "queues",
      "jobs",
      "requests",
      "errors",
      "link:1",
      "notes",
      "late",
      "dlq",
      "link:0",
      "billing",
      "cron",
    ]);
    expect(nav.find((item) => item.key === "queues")?.href).toBe("#/x/queues");
    expect(nav.find((item) => item.key === "link:0")?.external).toBe(true);
    expect(nav.find((item) => item.key === "link:1")?.external).toBe(false);
    expect(nav.find((item) => item.key === "cron")?.section).toBe("Ops");
  });

  it("refuses duplicate, reserved and malformed ids, and an unknown `after`", () => {
    const pages = (...list: DashboardExtension["pages"] & object) => ({
      pages: list,
    });
    expect(() =>
      mergeNav(
        builtIn,
        pages(
          { id: "queues", label: "A", component: Page },
          { id: "queues", label: "B", component: Page },
        ),
        false,
      ),
    ).toThrow('two pages have the id "queues"');
    expect(() =>
      mergeNav(
        builtIn,
        pages({ id: "requests", label: "R", component: Page }),
        false,
      ),
    ).toThrow("built-in page");
    expect(() =>
      mergeNav(
        builtIn,
        pages({ id: "a/b", label: "R", component: Page }),
        false,
      ),
    ).toThrow("letters, digits and dashes");
    expect(() =>
      mergeNav(
        builtIn,
        pages({ id: "q", label: "Q", after: "nowhere", component: Page }),
        false,
      ),
    ).toThrow('placed after "nowhere"');
    expect(() =>
      mergeNav(builtIn, pages({ id: "q", label: "Q" } as never), false),
    ).toThrow("needs a component or a url");
  });

  it("keeps only what is marked production: true in production", () => {
    const nav = mergeNav(
      builtIn,
      {
        pages: [
          { id: "dev", label: "Dev", component: Page },
          { id: "live", label: "Live", production: true, component: Page },
        ],
        sidebar: [{ label: "Docs", href: "https://example.com" }],
      },
      true,
    );
    expect(keys(nav)).toEqual(["overview", "requests", "errors", "live"]);
  });

  it("routes #/x/<id>/… to an extension page", () => {
    expect(parseRoute("#/x/queues/a%20b/c")).toEqual({
      view: "x",
      page: "queues",
      path: ["a b", "c"],
    });
  });
});

describe("themeCss", () => {
  it("sets tokens per mode, the radius and the fonts", () => {
    const css = themeCss({
      light: { primary: "oklch(0.55 0.2 260)" },
      dark: { primary: "oklch(0.7 0.15 260)", "chart-1": "red" },
      radius: "0.5rem",
      fonts: { sans: "Inter, sans-serif" },
    });
    expect(css).toContain(
      ":root {\n  --radius: 0.5rem;\n  --font-sans: Inter, sans-serif;\n}",
    );
    expect(css).toContain(
      ":root:not(.dark) {\n  --primary: oklch(0.55 0.2 260);\n}",
    );
    expect(css).toContain(
      ":root.dark {\n  --primary: oklch(0.7 0.15 260);\n  --chart-1: red;\n}",
    );
    expect(themeCss(undefined)).toBe("");
    expect(themeCss({})).toBe("");
  });

  it("refuses names theme.css does not have, and values that break out", () => {
    expect(() => themeCss({ light: { primay: "red" } })).toThrow(
      'no token "primay"',
    );
    expect(() => themeCss({ colors: {} } as never)).toThrow('no "colors"');
    expect(() => themeCss({ fonts: { serif: "x" } } as never)).toThrow(
      'no "serif"',
    );
    expect(() =>
      themeCss({ light: { primary: "red; } body { x: y" } }),
    ).toThrow("must be a CSS value");
    expect(() => themeCss({ radius: "" })).toThrow("must be a CSS value");
  });

  it("knows exactly the colour tokens of theme.css", () => {
    const source = readFileSync(
      join(import.meta.dir, "../dashboard/theme.css"),
      "utf8",
    );
    const tokens = [...source.matchAll(/--color-([\w-]+): var\(--\1\)/g)].map(
      (match) => match[1],
    );
    expect([...THEME_TOKENS].sort()).toEqual(tokens.sort());
  });
});

describe("mergeExtensions", () => {
  it("skips a page mergeNav would throw on, so the rest still merge", () => {
    const original = console.error;
    console.error = () => {};
    try {
      const merged = mergeExtensions([
        {
          name: "app",
          plugin: false,
          extension: { pages: [{ id: "ok", label: "Ok", component: Page }] },
        },
        {
          name: "plugin",
          plugin: true,
          extension: {
            pages: [
              { id: "bad id", label: "A", component: Page },
              { id: "overview", label: "B", component: Page },
              { id: "both", label: "C", component: Page, url: "/x" },
              { id: "lost", label: "D", component: Page, after: "nowhere" },
            ],
          },
        },
      ]);
      expect(merged.pages?.map((page) => page.id)).toEqual(["ok"]);
      expect(() => mergeNav(builtIn, merged, false)).not.toThrow();
    } finally {
      console.error = original;
    }
  });
});

describe("the extension build", () => {
  it("leaves React and the UI kit to the page, and compiles its own classes", async () => {
    const built = await buildDashboardExtension(entry);
    expect(built.js).toContain('from "@brickkit/cli/dashboard"');
    expect(built.js).toMatch(/from "react\/jsx(-dev)?-runtime"/);
    // React's internals object: React 18 and 19 name it differently.
    expect(built.js).not.toMatch(/__(SECRET|CLIENT)_INTERNALS/);
    expect(built.css).toContain(".bg-chart-3");
    expect(built.css).toContain("var(--chart-3)");
    expect(built.css).toContain(".p-7");
    // Utilities only: the dashboard's stylesheet has the base styles and tokens.
    expect(built.css).not.toContain("--background:");
  });

  it("brick build writes it beside the server", async () => {
    // In the package, where the server bundle finds @brickkit/core.
    const outdir = join(import.meta.dir, "fixtures", ".dashboard-build");
    try {
      const result = await buildApplication({
        entry: join(import.meta.dir, "fixtures/compiler-app.ts"),
        outdir,
        dashboard: { extension: entry },
      });
      expect(result.dashboard).toBe(join(outdir, "dashboard"));
      expect(
        readFileSync(join(outdir, "dashboard/extension.js"), "utf8"),
      ).toContain("@brickkit/cli/dashboard");
      expect(existsSync(join(outdir, "dashboard/extension.css"))).toBe(true);
      await expect(
        buildApplication({
          entry: join(import.meta.dir, "fixtures/compiler-app.ts"),
          outdir,
          dashboard: { theme: { light: { nope: "red" } } },
        }),
      ).rejects.toThrow('no token "nope"');
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});

describe("the dashboard server with an extension", () => {
  async function start(
    options: Partial<Parameters<typeof startDevDashboard>[0]> = {},
  ) {
    const store = new DevTelemetryStore();
    const dashboard = await startDevDashboard({ port: 0, store, ...options });
    return { store, dashboard, base: `http://localhost:${dashboard.port}` };
  }

  it("serves the extension, its styles and the theme, and names them in the page", async () => {
    const { dashboard, base } = await start({
      dashboard: { extension: entry, theme: { radius: "0" } },
    });
    try {
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain('"@brickkit/cli/dashboard":"/assets/kit.js"');
      expect(page).toContain(
        '"react-dom/client":"/assets/react-dom-client.js"',
      );
      expect(page).toContain(
        '<meta name="brick-extension" data-revision="1" data-src="/assets/extension.js?v=1">',
      );
      expect(page).toContain('href="/assets/extension.css?v=1"');
      expect(page).toContain('href="/assets/brick-theme.css" data-brick-theme');
      const js = await fetch(`${base}/assets/extension.js`);
      expect(js.headers.get("content-type")).toContain("text/javascript");
      expect(await js.text()).toContain("@brickkit/cli/dashboard");
      expect(
        await (await fetch(`${base}/assets/extension.css`)).text(),
      ).toContain(".p-7");
      expect(
        await (await fetch(`${base}/assets/brick-theme.css`)).text(),
      ).toContain("--radius: 0;");
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(state.extension).toEqual({ revision: 1 });
    } finally {
      dashboard.stop();
    }
  });

  it("reports a failed build instead of failing to start", async () => {
    const { dashboard, base } = await start({
      dashboard: { extension: join(fixture, "missing.tsx") },
    });
    try {
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain('<meta name="brick-extension" data-revision="1">');
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(state.extension.error).toContain("does not exist");
    } finally {
      dashboard.stop();
    }
  });

  it("refuses a theme with a token theme.css does not have", async () => {
    await expect(
      start({ dashboard: { theme: { dark: { primry: "red" } } } }),
    ).rejects.toThrow('no token "primry"');
  });

  it("rebuilds as the extension changes, and tells the page", async () => {
    const folder = mkdtempSync(join(tmpdir(), "brick-extension-"));
    cpSync(fixture, folder, { recursive: true });
    const { dashboard, base } = await start({
      dashboard: { extension: join(folder, "index.tsx") },
    });
    const abort = new AbortController();
    try {
      const events = await fetch(`${base}/api/events`, {
        signal: abort.signal,
      });
      const reader = events.body!.getReader();
      await reader.read(); // the snapshot
      writeFileSync(
        join(folder, "index.tsx"),
        readFileSync(join(folder, "index.tsx"), "utf8").replace(
          'title="Queues"',
          'title="Waiting jobs"',
        ),
      );
      let text = "";
      while (!text.includes("event: extension")) {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain('"revision":2');
      expect(
        await (await fetch(`${base}/assets/extension.js`)).text(),
      ).toContain("Waiting jobs");
    } finally {
      abort.abort();
      dashboard.stop();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  describe("/app", () => {
    async function withApp(
      run: (app: { url: string; seen: Request[] }) => Promise<void>,
    ) {
      const seen: Request[] = [];
      const app = Bun.serve({
        port: 0,
        fetch(request) {
          // A copy: Bun lets go of the request's headers once it is answered.
          seen.push(
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
            }),
          );
          return Response.json(
            {
              path: new URL(request.url).pathname,
              search: new URL(request.url).search,
            },
            { headers: { "set-cookie": "app=1" } },
          );
        },
      });
      try {
        await run({ url: `http://127.0.0.1:${app.port}`, seen });
      } finally {
        app.stop(true);
      }
    }

    it("passes requests from the dashboard's page on to the app", async () => {
      await withApp(async (app) => {
        const { dashboard, base } = await start({ appUrl: app.url });
        try {
          const response = await fetch(`${base}/app/api/queues?state=waiting`, {
            method: "POST",
            headers: { "sec-fetch-site": "same-origin", cookie: "mine=1" },
            body: "{}",
          });
          expect(await response.json()).toEqual({
            path: "/api/queues",
            search: "?state=waiting",
          });
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(app.seen[0]?.method).toBe("POST");
          expect(app.seen[0]?.headers.get("cookie")).toBeNull();
          const cross = await fetch(`${base}/app/api/queues`, {
            headers: { "sec-fetch-site": "cross-site" },
          });
          expect(cross.status).toBe(403);
        } finally {
          dashboard.stop();
        }
      });
    });

    it("waits for the app before it has an address", async () => {
      const { dashboard, base } = await start();
      try {
        expect((await fetch(`${base}/app/x`)).status).toBe(503);
      } finally {
        dashboard.stop();
      }
    });

    it("is open in production only with an extension, behind auth, without the dashboard's credential", async () => {
      await withApp(async (app) => {
        const token = "0123456789abcdef-secret";
        const headers = { authorization: `Bearer ${token}` };
        const plain = await start({
          mode: "production",
          auth: { token },
          appUrl: app.url,
        });
        const extended = await start({
          mode: "production",
          auth: { token },
          appUrl: app.url,
          dashboard: { extension: entry },
        });
        try {
          expect(
            (await fetch(`${plain.base}/app/api/queues`, { headers })).status,
          ).toBe(404);
          expect((await fetch(`${extended.base}/app/api/queues`)).status).toBe(
            401,
          );
          const response = await fetch(`${extended.base}/app/api/queues`, {
            headers,
          });
          expect(response.status).toBe(200);
          expect(app.seen.at(-1)?.headers.get("authorization")).toBeNull();
          expect(
            (await fetch(`${extended.base}/assets/extension.js`, { headers }))
              .status,
          ).toBe(200);
        } finally {
          plain.dashboard.stop();
          extended.dashboard.stop();
        }
      });
    });

    it("signs who authorize let in onto the request, replacing any copy the page sent", async () => {
      await withApp(async (app) => {
        const token = "0123456789abcdef-secret";
        const { dashboard, base } = await start({
          mode: "production",
          auth: {
            token,
            authorize: (request) =>
              request.headers.get("x-session") === "ada"
                ? { user: { id: "u1", name: "Ada" } }
                : false,
          },
          appUrl: app.url,
          dashboard: { extension: entry },
        });
        try {
          const forged = signDashboardIdentity({
            user: { id: "root" },
          }).replace(/^./, "A");
          const response = await fetch(`${base}/app/api/queues`, {
            headers: {
              "x-session": "ada",
              [DASHBOARD_IDENTITY_HEADER]: forged,
            },
          });
          expect(response.status).toBe(200);
          const sent = app.seen.at(-1)!;
          expect(sent.headers.get(DASHBOARD_IDENTITY_HEADER)).not.toBe(forged);
          expect(dashboardUser(sent)).toEqual({ id: "u1", name: "Ada" });

          // In by token: through the dashboard, but no user.
          await fetch(`${base}/app/api/queues`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(
            app.seen.at(-1)!.headers.get(DASHBOARD_IDENTITY_HEADER),
          ).toBeTruthy();
          expect(dashboardUser(app.seen.at(-1)!)).toBeUndefined();
        } finally {
          dashboard.stop();
        }
      });
    });
  });
});

describe("plugin dashboard extensions", () => {
  it("the page merges the listed parts and isolates one that fails", async () => {
    const folder = mkdtempSync(join(tmpdir(), "brick-plugin-ext-"));
    try {
      const write = (name: string, source: string) =>
        writeFileSync(join(folder, name), source);
      write(
        "app.js",
        `export default { pages: [{ id: "queues", label: "Queues", url: "/q", after: "overview" }], slots: { "topbar.end": "app", "request.drawer.tabs": [{ id: "a" }] } };`,
      );
      write(
        "plugin.js",
        `export default { pages: [{ id: "comments", label: "Comments", url: "/c" }, { id: "queues", label: "Dup", url: "/d" }], slots: { "topbar.end": "plugin", "request.drawer.tabs": [{ id: "b" }] }, sidebar: [{ label: "Docs", href: "https://x" }] };`,
      );
      write("broken.js", `throw new Error("boom");`);
      const errors: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args);
      let merged: DashboardExtension;
      try {
        merged = await loadParts(
          [
            { name: "app", src: "./app.js", plugin: false },
            { name: "@acme/brick-comments", src: "./plugin.js", plugin: true },
            { name: "@acme/broken", src: "./broken.js", plugin: true },
          ],
          pathToFileURL(join(folder, "extension.js")).href,
        );
      } finally {
        console.error = original;
      }
      expect(merged.pages?.map((page) => [page.id, page.section])).toEqual([
        ["queues", undefined],
        ["comments", "@acme/brick-comments"],
      ]);
      expect(merged.slots?.["topbar.end"]).toBe("app" as never);
      expect(merged.slots?.["request.drawer.tabs"]?.map((t) => t.id)).toEqual([
        "a",
        "b",
      ]);
      expect(merged.sidebar).toHaveLength(1);
      expect(String(errors.map((args) => args[0]))).toContain("@acme/broken");
      expect(String(errors.map((args) => args[0]))).toContain(
        "page id queues is taken",
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("brick dev serves the app's extension with its plugins', and keeps going when one fails", async () => {
    const store = new DevTelemetryStore();
    const dashboard = await startDevDashboard({
      port: 0,
      store,
      dashboard: { extension: entry },
    });
    const base = `http://localhost:${dashboard.port}`;
    try {
      await dashboard.setPluginExtensions([
        {
          name: "@acme/brick-comments",
          dashboard: join(
            import.meta.dir,
            "fixtures/plugin-dashboard/index.tsx",
          ),
        },
        { name: "@acme/no-dashboard" },
        { name: "@acme/broken", dashboard: join(fixture, "missing.tsx") },
      ]);
      const loader = await (await fetch(`${base}/assets/extension.js`)).text();
      expect(loader).toContain('"name":"app"');
      expect(loader).toContain('"name":"@acme/brick-comments"');
      expect(loader).not.toContain("@acme/broken");
      expect(
        await (await fetch(`${base}/assets/extension-1.js`)).text(),
      ).toContain("From a plugin");
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(state.extension.error).toContain("@acme/broken:");
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain(`data-revision="${state.extension.revision}"`);
    } finally {
      dashboard.stop();
    }
  });

  it("serves a plugin's extension when the app has none", async () => {
    const store = new DevTelemetryStore();
    const dashboard = await startDevDashboard({ port: 0, store });
    const base = `http://localhost:${dashboard.port}`;
    try {
      expect((await (await fetch(`${base}/api/state`)).json()).extension).toBe(
        null,
      );
      await dashboard.setPluginExtensions([
        {
          name: "@acme/brick-comments",
          dashboard: join(
            import.meta.dir,
            "fixtures/plugin-dashboard/index.tsx",
          ),
        },
      ]);
      const loader = await (await fetch(`${base}/assets/extension.js`)).text();
      expect(loader).toContain('"plugin":true');
      expect(
        (await (await fetch(`${base}/api/state`)).json()).extension,
      ).toEqual({
        revision: expect.any(Number),
      });
    } finally {
      dashboard.stop();
    }
  });

  const pluginApp = join(import.meta.dir, "fixtures/plugin-app.ts");
  const comments = {
    name: "@acme/brick-comments",
    dashboard: join(import.meta.dir, "fixtures/plugin-dashboard/index.tsx"),
  };

  it("brick build writes the app's and its plugins' parts and a loader, and production serves them", async () => {
    const outdir = join(import.meta.dir, "fixtures", ".plugin-build");
    try {
      const result = await buildApplication({
        entry: pluginApp,
        outdir,
        dashboard: { extension: entry },
      });
      const folder = join(outdir, "dashboard");
      expect(result.dashboard).toBe(folder);
      const loader = readFileSync(join(folder, "extension.js"), "utf8");
      expect(loader).toContain(
        '[{"name":"app","src":"./extension-0.js","plugin":false},{"name":"@acme/brick-comments","src":"./extension-1.js","plugin":true}]',
      );
      expect(readFileSync(join(folder, "extension-1.js"), "utf8")).toContain(
        "From a plugin",
      );
      expect(readFileSync(join(folder, "extension.css"), "utf8")).toContain(
        ".p-7",
      );

      const dashboard = await startDevDashboard({
        port: 0,
        store: new DevTelemetryStore(),
        mode: "production",
        dashboard: { extension: folder },
      });
      const base = `http://localhost:${dashboard.port}`;
      try {
        expect(await (await fetch(`${base}/assets/extension.js`)).text()).toBe(
          loader,
        );
        expect(
          await (await fetch(`${base}/assets/extension-0.js`)).text(),
        ).toContain("@brickkit/cli/dashboard");
        expect(
          await (await fetch(`${base}/assets/extension-1.js`)).text(),
        ).toContain("From a plugin");
        // The folder already holds its plugins: they are not added again.
        await dashboard.setPluginExtensions([comments]);
        expect(await (await fetch(`${base}/assets/extension.js`)).text()).toBe(
          loader,
        );
        expect(
          await (await fetch(`${base}/assets/extension-0.js`)).text(),
        ).toContain("@brickkit/cli/dashboard");
      } finally {
        dashboard.stop();
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("brick build writes a plugin's extension when the app has none", async () => {
    const outdir = join(import.meta.dir, "fixtures", ".plugin-only-build");
    try {
      const result = await buildApplication({ entry: pluginApp, outdir });
      const folder = join(outdir, "dashboard");
      expect(result.dashboard).toBe(folder);
      expect(readFileSync(join(folder, "extension.js"), "utf8")).toContain(
        '[{"name":"@acme/brick-comments","src":"./extension-0.js","plugin":true}]',
      );
      expect(readFileSync(join(folder, "extension-0.js"), "utf8")).toContain(
        "From a plugin",
      );
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("brick build fails, naming the plugin, when its extension does not build", async () => {
    const outdir = join(import.meta.dir, "fixtures", ".plugin-broken-build");
    try {
      await expect(
        buildApplication({
          entry: join(import.meta.dir, "fixtures/plugin-app-broken.ts"),
          outdir,
        }),
      ).rejects.toThrow("plugin @acme/brick-broken failed to build");
      expect(existsSync(outdir)).toBe(false);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("the production dashboard builds plugins' extensions from source", async () => {
    const dashboard = await startDevDashboard({
      port: 0,
      store: new DevTelemetryStore(),
      mode: "production",
      plugins: [comments, { name: "@acme/no-dashboard" }],
    });
    const base = `http://localhost:${dashboard.port}`;
    try {
      expect(
        (await (await fetch(`${base}/api/state`)).json()).extension,
      ).toEqual({ revision: expect.any(Number) });
      expect(
        await (await fetch(`${base}/assets/extension.js`)).text(),
      ).toContain('"plugin":true');
      expect(
        await (await fetch(`${base}/assets/extension-0.js`)).text(),
      ).toContain("From a plugin");
      // `/app` is served now that an extension is active.
      expect((await fetch(`${base}/app/`)).status).not.toBe(404);
    } finally {
      dashboard.stop();
    }
  });

  it("the production dashboard has no extension when no plugin ships one", async () => {
    const dashboard = await startDevDashboard({
      port: 0,
      store: new DevTelemetryStore(),
      mode: "production",
      plugins: [{ name: "@acme/no-dashboard" }],
    });
    const base = `http://localhost:${dashboard.port}`;
    try {
      expect(
        (await (await fetch(`${base}/api/state`)).json()).extension,
      ).toBeNull();
      expect((await fetch(`${base}/app/`)).status).toBe(404);
    } finally {
      dashboard.stop();
    }
  });
});

describe("createAppClient", () => {
  it("calls the app through the dashboard's /app proxy", async () => {
    const { createAppClient } = await import("../dashboard/extension");
    const original = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      value: { origin: "http://dashboard.test" },
      configurable: true,
    });
    try {
      const urls: string[] = [];
      const api = createAppClient<any>({
        fetch: (async (url: string | URL | Request) => {
          urls.push(String(url));
          return Response.json({ ok: true });
        }) as typeof fetch,
      });
      expect(await api.orders.order.list({})).toEqual({ ok: true });
      expect(urls[0]).toStartWith("http://dashboard.test/app/api/orders/");
    } finally {
      if (original) Object.defineProperty(globalThis, "location", original);
      else delete (globalThis as { location?: unknown }).location;
    }
  });
});
