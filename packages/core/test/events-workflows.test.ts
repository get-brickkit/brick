import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  brick,
  defineDatabase,
  defineListener,
  definePlugin,
  defineService,
  EventsHub,
  outboxTable,
  port,
  syncSchema,
  useDeps,
  type EventsWorld,
} from "../src";

const items = sqliteTable("wf_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
});
const outbox = outboxTable("sqlite");

const WORKFLOW_ID = "workflow//./src/fulfil//fulfil";

interface FakeSdk {
  starts: { workflow: unknown; args: unknown[]; options: any }[];
  worlds: unknown[];
  failNextStart?: Error;
}

declare global {
  var __fakeWorkflow: FakeSdk;
}

let serial = 0;
const roots: string[] = [];
const hubs: EventsHub[] = [];

/**
 * A project with a stand-in Workflow SDK and a bundle, so the runtime's wiring
 * can be checked without Redis or the real SDK.
 */
function project(
  options: {
    sdk?: boolean;
    bundle?: boolean;
    manifest?: unknown;
    flow?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "brick-workflows-"));
  roots.push(root);
  const { sdk = true, bundle = true } = options;
  writeFileSync(join(root, "package.json"), "{}");
  if (sdk) {
    const pkg = join(root, "node_modules", "workflow");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "workflow",
        version: "0.0.0",
        type: "module",
        exports: { "./api": "./api.js", "./runtime": "./runtime.js" },
      }),
    );
    writeFileSync(
      join(pkg, "api.js"),
      `export async function start(workflow, args, options) {
         const sdk = globalThis.__fakeWorkflow;
         if (sdk.failNextStart) { const error = sdk.failNextStart; sdk.failNextStart = undefined; throw error; }
         sdk.starts.push({ workflow, args, options });
         return { runId: "wrun_" + options.runKey };
       }`,
    );
    writeFileSync(
      join(pkg, "runtime.js"),
      "export function setWorld(world) { globalThis.__fakeWorkflow.worlds.push(world); }",
    );
  }
  const dir = join(root, ".well-known", "workflow", "v1");
  if (bundle) writeBundle(root, options.manifest, options.flow);
  return { root, dir };
}

function writeBundle(root: string, manifest?: unknown, flow?: string) {
  const dir = join(root, ".well-known", "workflow", "v1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "flow.mjs"),
    flow ?? "export async function POST() { return new Response('ok'); }",
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      manifest ?? {
        steps: {},
        workflows: {
          "src/fulfil.ts": { fulfil: { workflowId: WORKFLOW_ID } },
        },
      },
    ),
  );
}

function transformed(id: string | undefined = WORKFLOW_ID) {
  return Object.assign(
    async (_event: unknown) => ({}),
    id ? { workflowId: id } : {},
  );
}

function fakeWorld(overrides: Partial<EventsWorld> = {}) {
  const calls = { start: 0, close: 0, handlers: [] as [string, unknown][] };
  const world: EventsWorld = {
    createRunId: () => "unused",
    start: async () => void calls.start++,
    close: async () => void calls.close++,
    registerHandler: (prefix: string, handler: unknown) =>
      void calls.handlers.push([prefix, handler]),
    ...overrides,
  };
  return { world, calls };
}

function setup(
  config: {
    world?: EventsWorld;
    root: string;
    workflow?: ReturnType<typeof transformed>;
    maxAttempts?: number;
  },
  dispatch = {},
) {
  const database = defineDatabase({ tables: { items, outbox } });
  const db: any = database.getDb();
  syncSchema([items, outbox], db);
  const service = defineService(`wf_events_${++serial}`, { database });
  const workflow = config.workflow ?? transformed();
  const hub = new EventsHub({
    listeners: [
      defineListener({
        name: "fulfil",
        on: "item.create",
        workflow,
        ...(config.maxAttempts ? { maxAttempts: config.maxAttempts } : {}),
      }),
    ],
    world: config.world,
    workflows: { root: config.root },
    dispatch: { timer: false, maxBackoffMs: 1, ...dispatch },
  }).attach([service]);
  hubs.push(hub);
  const record = (label = "a") =>
    service.recorder!.transaction(db, { traceId: "tr_1" }, async (tx, rec) => {
      await tx.insert(items).values({ label });
      await rec("item.create", { id: 1, row: { label } });
    });
  return { db, hub, record, workflow };
}

const rows = (db: any) => db.select().from(outbox).all();

async function settle(hub: EventsHub, done: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  for (;;) {
    await hub.drain();
    if (await done()) return;
    if (Date.now() > deadline) throw new Error("did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let quiet: ReturnType<typeof spyOn>;

beforeEach(() => {
  globalThis.__fakeWorkflow = { starts: [], worlds: [] };
  quiet = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  quiet.mockRestore();
});

describe("workflow listeners", () => {
  it("refuses a listener with both or neither of run and workflow", () => {
    expect(() =>
      defineListener({
        name: "a",
        on: "x",
        run: () => {},
        workflow: transformed(),
      } as any),
    ).toThrow("both run and workflow");
    expect(() => defineListener({ name: "a", on: "x" } as any)).toThrow(
      "needs a run handler or a workflow",
    );
    expect(() =>
      defineListener({ name: "a", on: "x", workflow: "nope" } as any),
    ).toThrow("workflow must be a function");
    expect(
      () =>
        new EventsHub({
          listeners: [{ name: "raw", on: ["x"] }],
        }),
    ).toThrow("exactly one of run and workflow");
  });

  it("needs a world", () => {
    expect(
      () =>
        new EventsHub({
          listeners: [
            defineListener({ name: "a", on: "x", workflow: transformed() }),
          ],
        }),
    ).toThrow("events needs a world");
  });

  it("describes a listener as a workflow, and tells the CLI where the bundle goes", () => {
    const { root } = project();
    const { world } = fakeWorld();
    const { hub } = setup({ world, root });
    expect(hub.describe().listeners).toEqual([
      { name: "fulfil", on: ["item.create"], kind: "workflow" },
    ]);
    expect(hub.workflows).toEqual({
      root,
      dir: join(root, ".well-known", "workflow", "v1"),
      world,
    });
    expect(
      new EventsHub({
        listeners: [defineListener({ name: "h", on: "x", run: () => {} })],
      }).workflows,
    ).toBeUndefined();
  });

  it("starts one run per delivery, named after the delivery and timed at the event", async () => {
    const { root } = project();
    const { world, calls } = fakeWorld();
    const { hub, db, record, workflow } = setup({ world, root });
    await record();
    const [pending] = rows(db);

    await hub.drain();

    expect(globalThis.__fakeWorkflow.starts).toHaveLength(1);
    const [{ workflow: started, args, options }] =
      globalThis.__fakeWorkflow.starts;
    expect(started).toBe(workflow);
    expect(options).toEqual({
      world,
      runKey: `${pending.eventId}:fulfil`,
      runKeyTime: pending.occurredAt.getTime(),
    });
    expect(args).toEqual([
      {
        id: pending.eventId,
        name: "item.create",
        payload: { id: 1, row: { label: "a" } },
        occurredAt: pending.occurredAt.toISOString(),
        traceId: "tr_1",
        listener: "fulfil",
        deliveryId: `${pending.eventId}:fulfil`,
      },
    ]);
    expect(args[0]).not.toHaveProperty("attempt");
    expect(rows(db)[0]).toMatchObject({ status: "delivered" });

    expect(globalThis.__fakeWorkflow.worlds).toEqual([world]);
    expect(calls.start).toBe(1);
    expect(calls.handlers).toHaveLength(1);
    expect(calls.handlers[0]![0]).toBe("__wkf_workflow_");
    expect(typeof calls.handlers[0]![1]).toBe("function");
  });

  it("starts the world once however many deliveries there are", async () => {
    const { root } = project();
    const { world, calls } = fakeWorld();
    const { hub, record } = setup({ world, root });
    await record("a");
    await record("b");
    await record("c");
    await hub.drain();
    expect(globalThis.__fakeWorkflow.starts).toHaveLength(3);
    expect(calls.start).toBe(1);
    expect(calls.handlers).toHaveLength(1);
  });

  it("names the run the same on a retry, so a failed start is not a second run", async () => {
    const { root } = project();
    const { world } = fakeWorld();
    const { hub, db, record } = setup({ world, root });
    await record();
    globalThis.__fakeWorkflow.failNextStart = new Error("redis is down");

    await settle(hub, () => globalThis.__fakeWorkflow.starts.length === 1);

    expect(rows(db)[0]).toMatchObject({ status: "delivered", attempts: 2 });
    expect(globalThis.__fakeWorkflow.starts[0]!.options.runKey).toBe(
      rows(db)[0].id,
    );
  });

  describe("added by a plugin", () => {
    const PLUGIN_ID = "workflow//./plugin/sync//sync";
    const manifest = {
      steps: {},
      workflows: {
        "src/fulfil.ts": { fulfil: { workflowId: WORKFLOW_ID } },
        "plugin/sync.ts": { sync: { workflowId: PLUGIN_ID } },
      },
    };
    // The bundle answers with the deps its steps would see.
    const flow =
      "export async function POST() { return Response.json(globalThis.__readDeps()); }";

    function app(world: EventsWorld, root: string, pluginWorkflow: unknown) {
      (globalThis as any).__readDeps = () => useDeps();
      const sync = definePlugin({
        name: "@acme/sync",
        deps: { mailer: port<string>() },
        app: ({ listeners }) =>
          listeners(
            defineListener({
              name: "sync",
              on: "item.*",
              workflow: pluginWorkflow as never,
            }),
          ),
      });
      const host = defineService(`wf_plugin_${++serial}`, {
        deps: { carrier: port<string>() },
      });
      const made = brick({
        services: [host],
        deps: { carrier: "app" },
        requestLogging: false,
        docs: false,
        plugins: [sync({}, { deps: { mailer: "plugin" } })],
        events: {
          world,
          workflows: { root },
          dispatch: { timer: false },
          listeners: [
            defineListener({
              name: "fulfil",
              on: "item.create",
              workflow: transformed(),
            }),
          ],
        },
      });
      hubs.push(made.events!);
      return made.events!;
    }

    it("runs each workflow's steps with the deps of the app or plugin that listens", async () => {
      const { root } = project({ manifest, flow });
      const { world, calls } = fakeWorld();
      const hub = app(world, root, transformed(PLUGIN_ID));
      hub.start();
      await settle(hub, () => calls.handlers.length === 1);
      const handler = calls.handlers[0]![1] as (
        r: Request,
      ) => Promise<Response>;
      const depsFor = async (id: string) =>
        (
          await handler(
            new Request("http://x", {
              method: "POST",
              headers: { "x-vqs-queue-name": `__wkf_workflow_${id}` },
            }),
          )
        ).json();
      expect(await depsFor(PLUGIN_ID)).toEqual({ mailer: "plugin" });
      expect(await depsFor(WORKFLOW_ID)).toEqual({ carrier: "app" });
    });

    it("refuses one workflow run by an app listener and a plugin listener", async () => {
      const { root } = project({ manifest, flow });
      const { world, calls } = fakeWorld();
      const hub = app(world, root, transformed());
      hub.start();
      await settle(hub, () =>
        quiet.mock.calls.some((call) =>
          String(call[0]).includes("is run by listeners with different deps"),
        ),
      );
      expect(calls.handlers).toHaveLength(0);
    });
  });

  it("starts the world when events start, and closes it when they stop", async () => {
    const { root } = project();
    const { world, calls } = fakeWorld();
    const { hub } = setup({ world, root });
    hub.start();
    await settle(hub, () => calls.start === 1);
    expect(calls.handlers).toHaveLength(1);
    await hub.stop();
    expect(calls.close).toBe(1);
  });

  it("closes the world once when two stops overlap", async () => {
    const { root } = project();
    const { world, calls } = fakeWorld();
    const { hub } = setup({ world, root });
    hub.start();
    await settle(hub, () => calls.start === 1);
    await Promise.all([hub.stop(), hub.stop()]);
    expect(calls.close).toBe(1);
  });

  it("does not start the world in a process that only records", async () => {
    const { root } = project();
    const { world, calls } = fakeWorld();
    const hub = new EventsHub({
      listeners: [
        defineListener({
          name: "fulfil",
          on: "item.create",
          workflow: transformed(),
        }),
      ],
      world,
      workflows: { root },
      dispatch: false,
    });
    hubs.push(hub);
    hub.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.start).toBe(0);
  });

  it("refuses a world that cannot name a run", async () => {
    const { root } = project();
    const { world } = fakeWorld({ createRunId: undefined });
    const { hub, db, record } = setup({ world, root });
    await record();
    await hub.drain();
    expect(rows(db)[0]).toMatchObject({ status: "pending" });
    expect(rows(db)[0].lastError).toContain("cannot name a run");
    expect(globalThis.__fakeWorkflow.starts).toHaveLength(0);
  });

  it("explains a workflow that was never transformed", async () => {
    const { root } = project();
    const { hub, db, record } = setup({
      world: fakeWorld().world,
      root,
      workflow: transformed(""),
    });
    await record();
    await hub.drain();
    expect(rows(db)[0].lastError).toContain("was not transformed");
  });

  it("explains a bundle that does not know the workflow", async () => {
    const { root } = project({ manifest: { steps: {}, workflows: {} } });
    const { hub, db, record } = setup({ world: fakeWorld().world, root });
    await record();
    await hub.drain();
    expect(rows(db)[0].lastError).toContain("does not contain");
    expect(rows(db)[0].lastError).toContain(WORKFLOW_ID);
  });

  it("explains a missing bundle, and delivers once it exists", async () => {
    const { root } = project({ bundle: false });
    const { hub, db, record } = setup({ world: fakeWorld().world, root });
    await record();
    await hub.drain();
    expect(rows(db)[0].lastError).toContain("No workflow bundle");

    writeBundle(root);
    await settle(hub, () => rows(db)[0].status === "delivered");
    expect(globalThis.__fakeWorkflow.starts).toHaveLength(1);
  });

  it("explains a missing SDK", async () => {
    const { root } = project({ sdk: false });
    const { hub, db, record } = setup({ world: fakeWorld().world, root });
    await record();
    await hub.drain();
    expect(rows(db)[0].lastError).toContain("not installed");
    expect(rows(db)[0].lastError).toContain("bun add workflow");
  });

  it("keeps the app's steps when the bundle registers its own copies", async () => {
    const registry = Symbol.for("@workflow/core//registeredSteps");
    const steps = new Map<string, unknown>([["step//book", "app copy"]]);
    (globalThis as Record<symbol, unknown>)[registry] = steps;
    try {
      const { root } = project({
        flow: `
          const registry = globalThis[Symbol.for("@workflow/core//registeredSteps")];
          registry.set("step//book", "bundle copy");
          registry.set("step//only-in-bundle", "bundle copy");
          export async function POST() { return new Response("ok"); }
        `,
      });
      const { hub, record } = setup({ world: fakeWorld().world, root });
      await record();
      await hub.drain();
      expect(globalThis.__fakeWorkflow.starts).toHaveLength(1);
      expect(steps.get("step//book")).toBe("app copy");
      expect(steps.get("step//only-in-bundle")).toBe("bundle copy");
    } finally {
      delete (globalThis as Record<symbol, unknown>)[registry];
    }
  });

  it("cannot run workflows after the events were stopped", async () => {
    const { root } = project();
    const { hub, db, record } = setup({ world: fakeWorld().world, root });
    await hub.stop();
    await record();
    await hub.drain();
    expect(rows(db)[0].lastError).toContain("were stopped");
  });
});

describe("webhooks", () => {
  const resumed = `export const POST = (request) =>
    new Response("resumed " + new URL(request.url).pathname.split("/").pop());`;

  function webhookProject() {
    const { root, dir } = project();
    writeFileSync(join(dir, "webhook.mjs"), resumed);
    return root;
  }

  it("resumes through the bundle's handler, with the world set but not started", async () => {
    const root = webhookProject();
    const { world, calls } = fakeWorld();
    const { hub } = setup({ world, root });

    const response = await hub.webhook(
      new Request("http://x/.well-known/workflow/v1/webhook/tok_1", {
        method: "POST",
      }),
    );

    expect(await response.text()).toBe("resumed tok_1");
    expect(globalThis.__fakeWorkflow.worlds).toEqual([world]);
    expect(calls.start).toBe(0);
  });

  it("answers 405 for a method the bundle does not handle, and fails clearly without a bundle", async () => {
    const root = webhookProject();
    const { hub } = setup({ world: fakeWorld().world, root });
    const get = await hub.webhook(
      new Request("http://x/.well-known/workflow/v1/webhook/t"),
    );
    expect(get.status).toBe(405);

    const bare = project();
    const { hub: other } = setup({ world: fakeWorld().world, root: bare.root });
    await expect(
      other.webhook(new Request("http://x/webhook/t", { method: "POST" })),
    ).rejects.toThrow("No webhook bundle");
  });

  it("is served by the app on the route the SDK puts in webhook URLs, even when it only records events", async () => {
    const root = webhookProject();
    const service = defineService(`wf_events_${++serial}`, {
      database: defineDatabase({ tables: { items, outbox } }),
    });
    const app = brick({
      services: [service],
      events: {
        world: fakeWorld().world,
        workflows: { root },
        listeners: [
          defineListener({
            name: "fulfil",
            on: "item.create",
            workflow: transformed(),
          }),
        ],
        dispatch: false,
      },
      requestLogging: false,
      docs: false,
    });
    try {
      const response = await app.handle(
        new Request("http://x/.well-known/workflow/v1/webhook/tok_2", {
          method: "POST",
          body: "{}",
        }),
      );
      expect(await response.text()).toBe("resumed tok_2");
    } finally {
      await app.events?.stop();
    }
  });
});
