import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import {
  brick,
  brickVersion,
  defineAction,
  defineDatabase,
  defineListener,
  definePlugin,
  defineSecret,
  defineService,
  emitEvent,
  port,
  generateOpenApiSpec,
  getTableName,
  resetGlobalRegistry,
  satisfiesRange,
  sqliteTable,
  syncSchema,
  t,
  text,
} from "../src";

beforeEach(resetGlobalRegistry);

const pages = sqliteTable("dp_pages", { id: text("id").primaryKey() });
function host(engine: "sqlite" | "postgres" = "sqlite") {
  const sqlite = () => defineDatabase({ tables: { pages } });
  // Postgres is only built here, never connected; typed as SQLite for brevity.
  const database =
    engine === "sqlite"
      ? sqlite()
      : (defineDatabase({
          engine: "postgres",
          url: "postgres://unused",
        }) as unknown as ReturnType<typeof sqlite>);
  const service = defineService("pages", { database });
  const page = service.resource({ name: "page", table: pages, id: pages.id });
  return { database, service, page };
}

const notes = definePlugin({
  name: "@acme/brick-notes",
  brick: ">=0.10.0",
  options: t.Object({
    maxLength: t.Integer({ default: 2000, minimum: 1 }),
    access: t.Union([t.Literal("public"), t.Literal("signed-in")], {
      default: "signed-in",
    }),
  }),
  tables: ({ table, text, timestamp }) => ({
    notes: table("notes", {
      id: text("id").primaryKey(),
      targetId: text("target_id").notNull(),
      createdAt: timestamp("created_at").notNull(),
    }),
    tags: table("tags", { id: text("id").primaryKey() }),
  }),
  events: { added: t.Object({ id: t.String() }) },
  resource: ({ options, tables, events }) => ({
    noteOptions: options,
    noteTables: tables,
    noteEvents: events,
  }),
});

describe("satisfiesRange", () => {
  it.each([
    ["0.11.0", "^0.11.0", true],
    ["0.11.4", "^0.11.0", true],
    ["0.12.1", "^0.11.0", false],
    ["0.10.9", "^0.11.0", false],
    ["1.4.0", "^1.2.0", true],
    ["2.0.0", "^1.2.0", false],
    ["0.11.5", "~0.11.2", true],
    ["0.12.0", "~0.11.2", false],
    ["0.12.0", ">=0.11 <0.13", true],
    ["0.13.0", ">=0.11 <0.13", false],
    ["0.11.7", "0.11.x", true],
    ["0.12.1", "^0.10.0 || ^0.12.0", true],
    ["5.0.0", "*", true],
    ["0.11.0-beta.2", "^0.11.0", true],
  ])("%s in %s is %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});

describe("definePlugin manifest", () => {
  it("rejects an unsupported Brick version, naming both", () => {
    const old = definePlugin({
      name: "@acme/brick-old",
      brick: "^0.0.1",
      resource: () => ({}),
    });
    expect(() => old()).toThrow(
      `@acme/brick-old supports Brick ^0.0.1; this app runs ${brickVersion()}`,
    );
    expect(brickVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("fills option defaults and names the plugin and option on bad values", () => {
    const { page } = host();
    const api = page.use(notes({ maxLength: 500 }));
    expect(api.noteOptions).toEqual({ maxLength: 500, access: "signed-in" });
    expect(() => notes({ maxLength: 0 })).toThrow(
      /@acme\/brick-notes: option "maxLength"/,
    );
    // @ts-expect-error not one of the literals
    expect(() => notes({ access: "everyone" })).toThrow(
      /@acme\/brick-notes: option "access"/,
    );
  });

  it("checks requires on the same host", () => {
    const base = definePlugin({ name: "@acme/base", resource: () => ({}) });
    const needsBase = definePlugin({
      name: "@acme/needs-base",
      requires: ["@acme/base"],
      resource: () => ({ ok: true }),
    });
    const { page, service } = host();
    expect(() => page.use(needsBase())).toThrow(
      '@acme/needs-base requires @acme/base, installed on resource "page" before it',
    );
    const other = service.resource({
      name: "other",
      table: sqliteTable("dp_other", { id: text("id").primaryKey() }),
    });
    other.use(base());
    expect(() => page.use(needsBase())).toThrow(/requires @acme\/base/);
    expect(page.use(base()).use(needsBase()).ok).toBe(true);
  });

  it("refuses a host the plugin has no part for", () => {
    const { service } = host();
    expect(() => service.use(notes() as never)).toThrow(
      "@acme/brick-notes cannot be installed on a service; use resource.use()",
    );
    expect(() => brick({ services: [service], plugins: [notes()] })).toThrow(
      "@acme/brick-notes cannot be installed on the app; use resource.use()",
    );
  });

  it("lists capabilities and secrets for the directory and lint", () => {
    const withSecret = definePlugin({
      name: "@acme/brick-mod",
      secrets: { key: defineSecret("ACME_MOD_KEY", { default: "dev" }) },
      app: () => {},
      dashboard: "./dashboard.js",
    });
    expect(withSecret.info).toMatchObject({
      name: "@acme/brick-mod",
      secrets: ["ACME_MOD_KEY"],
      capabilities: ["app", "dashboard"],
    });
  });
});

describe("plugin tables", () => {
  it("prefixes names, joins the host database and schema sync (sqlite)", async () => {
    const { database, service, page } = host();
    const api = page.use(notes());
    expect(getTableName(api.noteTables.notes)).toBe("page_notes");
    expect(getTableName(api.noteTables.tags)).toBe("page_notes_tags");
    expect(Object.keys(database.tables)).toEqual([
      "pages",
      "page_notes",
      "page_notes_tags",
    ]);
    expect(service.introspect().databaseConfig?.plugins).toEqual({
      page_notes: "@acme/brick-notes",
      page_notes_tags: "@acme/brick-notes",
    });
    const db = database.getDb();
    syncSchema(service);
    await db.insert(api.noteTables.notes).values({
      id: "n1",
      targetId: "p1",
      createdAt: new Date(1_700_000_000_000),
    });
    const [row] = await db.select().from(api.noteTables.notes);
    expect(row!.createdAt).toEqual(new Date(1_700_000_000_000));
    // syncSchema(database.tables) sees them too.
    syncSchema(database.tables, db);
  });

  it("uses the install prefix and refuses a clash", () => {
    const { service, page } = host();
    const api = page.use(notes({}, { prefix: "blog_" }));
    expect(getTableName(api.noteTables.notes)).toBe("blog_notes");
    const second = service.resource({
      name: "second",
      table: sqliteTable("dp_second", { id: text("id").primaryKey() }),
    });
    const before = [...service.tables.keys()];
    expect(() => second.use(notes({}, { prefix: "blog_" }))).toThrow(
      /table "blog_notes" clashes/,
    );
    // The failed install left nothing behind.
    expect([...service.tables.keys()]).toEqual(before);
    expect(Object.keys(service.events)).toEqual(["notes.added"]);
  });

  it("builds Postgres tables for a Postgres host", () => {
    const { page } = host("postgres");
    const api = page.use(notes());
    const config = pgTableConfig(api.noteTables.notes as never);
    expect(config.name).toBe("page_notes");
    expect(
      config.columns.find((c) => c.name === "created_at")?.getSQLType(),
    ).toBe("timestamp with time zone");
  });

  it("needs a host database", () => {
    const bare = defineService("bare");
    const thing = bare.resource({ name: "thing", table: pages, id: pages.id });
    expect(() => thing.use(notes())).toThrow(
      '@acme/brick-notes owns tables, so service "bare" needs a database',
    );
  });
});

describe("plugin events", () => {
  it("join the host catalog under the plugin name", async () => {
    const { service, page } = host();
    const api = page.use(notes());
    expect(api.noteEvents.added.name).toBe("pages.notes.added");
    expect(Object.keys(service.events)).toEqual(["notes.added"]);
    expect(service.introspect().events).toEqual([
      {
        name: "pages.notes.added",
        schema: expect.any(Object),
        plugin: "@acme/brick-notes",
      },
    ]);
    const spec = generateOpenApiSpec({ services: [service] });
    expect(spec["x-brick-events"]["pages.notes.added"]["x-brick-plugin"]).toBe(
      "@acme/brick-notes",
    );
    // Checked against the plugin's schema like any catalog event.
    const ctx = await service.resolveContext();
    await expect(
      emitEvent(ctx, api.noteEvents.added, { id: 1 } as never),
    ).rejects.toThrow(/does not match its schema/);
  });
});

describe("app part and lifecycle", () => {
  it("starts in install order, stops in reverse, with middleware and listeners", async () => {
    const calls: string[] = [];
    const lifecycle = (name: string) =>
      definePlugin({
        name,
        options: t.Object({ label: t.String({ default: name }) }),
        app: ({ on, options }) => {
          on("start", async () => {
            await Bun.sleep(1);
            calls.push(`start ${options.label}`);
          });
          on("stop", () => {
            calls.push(`stop ${options.label}`);
          });
        },
        resource: () => ({}),
      });
    const first = lifecycle("@acme/first");
    const blocker = definePlugin({
      name: "@acme/blocker",
      app: ({ middleware, listeners }) => {
        middleware(({ request }) =>
          new URL(request.url).pathname === "/blocked"
            ? new Response("no", { status: 418 })
            : undefined,
        );
        listeners(
          defineListener({ name: "plugin-listener", on: "pages.*", run() {} }),
        );
      },
    });
    const { service, page } = host();
    page.use(first());
    const app = brick({
      services: [service],
      requestLogging: false,
      plugins: [lifecycle("@acme/second")(), blocker()],
    });
    expect(
      app.definition.plugins?.map(({ name, scope }) => [name, scope]),
    ).toEqual([
      ["@acme/first", "resource"],
      ["@acme/second", "app"],
      ["@acme/blocker", "app"],
    ]);
    expect(app.events?.describe().listeners.map((l) => l.name)).toEqual([
      "plugin-listener",
    ]);
    expect((await app.handle(new Request("http://x/blocked"))).status).toBe(
      418,
    );
    expect((await app.handle(new Request("http://x/_health"))).status).toBe(
      200,
    );
    await Promise.all([app.start(), app.start()]);
    await app.stop();
    expect(calls).toEqual([
      "start @acme/first",
      "start @acme/second",
      "stop @acme/second",
      "stop @acme/first",
    ]);
    await app.events?.stop();
  });

  it("adds a workflow listener, tagged with the plugin's deps for its steps", () => {
    const sync = Object.assign(async () => {}, { workflowId: "flows/sync" });
    const flows = definePlugin({
      name: "@acme/flows",
      deps: { mailer: port<string>() },
      app: ({ listeners }) => {
        listeners(
          defineListener({
            name: "flow-listener",
            on: "pages.*",
            workflow: sync,
          }),
        );
      },
    });
    const app = brick({
      services: [],
      requestLogging: false,
      plugins: [flows({}, { deps: { mailer: "plugin" } })],
      events: { world: { createRunId: () => "run" } },
    });
    expect(app.events?.describe().listeners).toEqual([
      { name: "flow-listener", on: ["pages.*"], kind: "workflow" },
    ]);
    // The workflow runtime reads this tag to run the steps with the plugin's deps.
    const listener = (app.events as any).byName.get("flow-listener");
    expect(listener[Symbol.for("brickkit.plugin.deps")]).toEqual({
      mailer: "plugin",
    });
  });

  it("refuses a plugin passed to brick() that a resource already installed", () => {
    const audit = definePlugin({
      name: "@acme/audit",
      app: () => {},
      resource: () => ({}),
    });
    const { service, page } = host();
    const instance = audit();
    page.use(instance);
    for (const again of [instance, audit()])
      expect(() =>
        brick({ services: [service], requestLogging: false, plugins: [again] }),
      ).toThrow(
        `Plugin @acme/audit is already installed with ${service.name}.${page.name}.use(), which runs its app part too; remove it from brick({ plugins })`,
      );
  });

  it("a failed start stops what started and rethrows", async () => {
    const calls: string[] = [];
    const ok = definePlugin({
      name: "@acme/ok",
      app: ({ on }) => {
        on("start", () => void calls.push("start ok"));
        on("stop", () => void calls.push("stop ok"));
      },
    });
    const broken = definePlugin({
      name: "@acme/broken",
      requires: ["@acme/ok"],
      app: ({ on }) => {
        on("start", () => {
          throw new Error("no connection");
        });
        on("stop", () => void calls.push("stop broken"));
      },
    });
    expect(() => brick({ services: [], plugins: [broken(), ok()] })).toThrow(
      "@acme/broken requires @acme/ok, installed in brick({ plugins }) before it",
    );
    const app = brick({
      services: [],
      requestLogging: false,
      plugins: [ok(), broken()],
    });
    await expect(app.start()).rejects.toThrow("no connection");
    expect(calls).toEqual(["start ok", "stop ok"]);
  });
  it("serve and listen both refuse to serve when a plugin fails to start", async () => {
    const broken = definePlugin({
      name: "@acme/broken",
      app: ({ on }) =>
        on("start", () => {
          throw new Error("no connection");
        }),
    });
    const create = () =>
      brick({ services: [], requestLogging: false, plugins: [broken()] });
    await expect(create().serve({ port: 0 })).rejects.toThrow("no connection");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const app = create().listen(0);
    const url = `http://localhost:${app.server!.port}/openapi.json`;
    try {
      for (let i = 0; i < 100 && app.server; i++) await Bun.sleep(5);
      await expect(fetch(url)).rejects.toThrow();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("serve starts plugins, listens, then delivers events; shutdown reverses it", async () => {
    const calls: string[] = [];
    const state = () => (app.server ? "listening" : "not listening");
    const order = definePlugin({
      name: "@acme/order",
      app: ({ on, listeners }) => {
        on("start", () => void calls.push(`plugins start, ${state()}`));
        on("stop", () => void calls.push(`plugins stop, ${state()}`));
        listeners(
          defineListener({ name: "order-listener", on: "pages.*", run() {} }),
        );
      },
    });
    const { service } = host();
    const app = brick({
      services: [service],
      requestLogging: false,
      plugins: [order()],
    });
    const events = app.events!;
    const start = events.start.bind(events);
    const stop = events.stop.bind(events);
    events.start = () => {
      calls.push(`events start, ${state()}`);
      start();
    };
    events.stop = async () => {
      calls.push(`events stop, ${state()}`);
      await stop();
    };
    await app.serve({ port: 0 });
    await app.shutdown(true);
    expect(calls).toEqual([
      "plugins start, not listening",
      "events start, listening",
      "events stop, listening",
      "plugins stop, not listening",
    ]);
  });

  it("resolves the dashboard extension next to the plugin's file", () => {
    const plugin = definePlugin({
      name: "@acme/dash",
      dashboard: "./fixtures/dashboard.js",
      app: () => {},
    });
    const app = brick({
      services: [],
      requestLogging: false,
      plugins: [plugin()],
    });
    expect(app.definition.plugins?.[0]?.dashboard).toBe(
      `${import.meta.dir}/fixtures/dashboard.js`,
    );
  });
});

describe("plugin deps", () => {
  interface Mailer {
    send(to: string): string;
  }
  const mailer = (from: string): Mailer => ({ send: (to) => `${from}:${to}` });
  const post = async (
    app: { handle(request: Request): Promise<Response> },
    path: string,
    body: unknown = {},
  ) =>
    (
      await app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    ).json();

  const seen: Record<string, unknown> = {};
  const notify = definePlugin({
    name: "@acme/brick-notify",
    deps: { mailer: port<Mailer>() },
    service: ({ service, deps }) => {
      seen.service = deps.mailer;
      service.action({
        name: "notifySend",
        input: t.Object({ to: t.String() }),
        authorize: ({ ctx }) => typeof ctx.deps.mailer.send === "function",
        execute: ({ input, ctx }) => ({
          sent: ctx.deps.mailer.send(input.to),
          keys: Object.keys(ctx.deps),
        }),
      });
      // A host action it calls with its ctx still gets the host's deps.
      service.action({
        name: "relay",
        execute: ({ ctx }) => service.getAction("own")!.run(undefined, ctx),
      });
    },
    resource: ({ resource, routes, deps }) => {
      seen.resource = deps.mailer;
      resource.action({
        name: "mail",
        execute: ({ ctx }) => ({ sent: ctx.deps.mailer.send("res") }),
      });
      routes.endpoint({
        name: "hook",
        path: "/hook",
        method: "POST",
        handler: ({ ctx }) => ({ sent: ctx.deps.mailer.send("endpoint") }),
      });
      return {};
    },
    app: ({ deps, on }) => {
      seen.app = deps.mailer;
      on("start", (context) => void (seen.start = context.deps.mailer));
    },
  });

  for (const compiler of [true, false])
    it(`gives the plugin's actions the deps passed at install, never the host's (compiler: ${compiler})`, async () => {
      const service = defineService("mail", {
        deps: { carrier: port<string>() },
      });
      service.action({
        name: "own",
        execute: ({ ctx }) => ({ keys: Object.keys(ctx.deps) }),
      });
      const passed = mailer("plugin");
      service.use(notify({}, { deps: { mailer: passed } }));
      const app = brick({
        services: [service],
        deps: { carrier: "host" },
        compiler,
        requestLogging: false,
        docs: false,
      });
      expect(seen.service).toBe(passed);
      expect(await post(app, "/api/mail/notify-send", { to: "a" })).toEqual({
        sent: "plugin:a",
        keys: ["mailer"],
      });
      expect(await post(app, "/api/mail/own")).toEqual({ keys: ["carrier"] });
      // A direct call too.
      expect(
        await (service.getAction("notifySend") as any).run({ to: "b" }),
      ).toEqual({ sent: "plugin:b", keys: ["mailer"] });
      expect(await (service.getAction("relay") as any).run()).toEqual({
        keys: ["carrier"],
      });
      await app.start();
      expect(seen.app).toBe(passed);
      expect(seen.start).toBe(passed);
      await app.stop();
    });

  it("reaches resource actions, endpoints and the setup's deps", async () => {
    const { service, page } = host();
    const passed = mailer("res");
    page.use(notify({}, { deps: { mailer: passed } }));
    expect(seen.resource).toBe(passed);
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    expect(await post(app, "/api/pages/page/mail")).toEqual({
      sent: "res:res",
    });
    expect(await post(app, "/api/pages/page/hook")).toEqual({
      sent: "res:endpoint",
    });
  });

  it("gives a plugin without deps an empty ctx.deps, not the host's", async () => {
    const plain = definePlugin({
      name: "@acme/plain",
      service: ({ service }) => {
        service.action({
          name: "plainKeys",
          execute: ({ ctx }) => ({ keys: Object.keys(ctx.deps) }),
        });
      },
    });
    const service = defineService("plainhost", {
      deps: { carrier: port<string>() },
    });
    service.use(plain());
    const app = brick({
      services: [service],
      deps: { carrier: "host" },
      requestLogging: false,
      docs: false,
    });
    expect(await post(app, "/api/plainhost/plain-keys")).toEqual({ keys: [] });
  });

  it("fails at install when a dep is missing, naming it and how to pass it", () => {
    expect(() => (notify as any)()).toThrow(
      "@acme/brick-notify needs deps.mailer; pass it when installing: notify(options, { deps: { mailer } })",
    );
    expect(() => (notify as any)({}, { deps: { mailer: undefined } })).toThrow(
      "needs deps.mailer",
    );
  });

  it("fails at install on deps the plugin does not declare", () => {
    expect(() =>
      (notify as any)({}, { deps: { mailer: mailer("x"), extra: 1, more: 2 } }),
    ).toThrow(
      "@acme/brick-notify does not declare deps.extra, deps.more; it takes mailer",
    );
    const none = definePlugin({ name: "@acme/none", app: () => {} });
    expect(() => (none as any)({}, { deps: { mailer: 1 } })).toThrow(
      "@acme/none does not declare deps.mailer; it takes no deps",
    );
    expect(notify.info.deps).toEqual(["mailer"]);
  });

  it("runs a plugin's sockets with the plugin's deps", async () => {
    const live = definePlugin({
      name: "@acme/live",
      deps: { mailer: port<Mailer>() },
      service: ({ service }) => {
        service.socket({
          name: "live",
          input: {},
          handlers: {},
          output: { hello: t.Object({ sent: t.String() }) },
          allowMissingOrigin: true,
          authorize: ({ ctx }) => Object.keys(ctx.deps).join() === "mailer",
          open: ({ ctx, socket }) =>
            socket.send("hello", { sent: ctx.deps.mailer.send("socket") }),
        });
      },
    });
    const service = defineService("livehost", {
      deps: { carrier: port<string>() },
    });
    service.use(live({}, { deps: { mailer: mailer("plugin") } }));
    const app = brick({
      services: [service],
      deps: { carrier: "host" },
      requestLogging: false,
      docs: false,
    }).listen(0);
    try {
      const ws = new WebSocket(
        `ws://localhost:${app.server!.port}/api/livehost/live`,
      );
      const first = await new Promise<unknown>((resolve, reject) => {
        ws.onmessage = ({ data }) => resolve(JSON.parse(String(data)));
        ws.onclose = () => reject(new Error("closed"));
      });
      ws.close();
      expect(first).toMatchObject({ data: { sent: "plugin:socket" } });
    } finally {
      await app.stop(true);
    }
  });

  it("gives a host action called with a plugin's ctx the host's deps, even outside brick()", async () => {
    const relay = definePlugin({
      name: "@acme/relay",
      deps: { mailer: port<Mailer>() },
      service: ({ service }) => {
        service.action({
          name: "relayOwn",
          execute: ({ ctx }) => service.getAction("own")!.run(undefined, ctx),
        });
      },
    });
    const service = defineService("bare");
    service.action({
      name: "own",
      execute: ({ ctx }) => ({ keys: Object.keys(ctx.deps) }),
    });
    service.use(relay({}, { deps: { mailer: mailer("x") } }));
    expect(await (service.getAction("relayOwn") as any).run()).toEqual({
      keys: [],
    });
  });

  it("refuses one action object shared by two installs with different deps", () => {
    const shared = defineAction({ name: "shared", execute: () => null });
    const sharing = definePlugin({
      name: "@acme/sharing",
      deps: { mailer: port<Mailer>() },
      service: ({ service }) => {
        service.action(shared);
      },
    });
    defineService("one").use(sharing({}, { deps: { mailer: mailer("a") } }));
    expect(() =>
      defineService("two").use(sharing({}, { deps: { mailer: mailer("b") } })),
    ).toThrow(
      '@acme/sharing: action "shared" is already bound to the deps of another install; create the action inside the setup so each install gets its own',
    );
  });
});
