import {
  brick,
  defineDatabase,
  defineSchedule,
  defineService,
  desc,
  eq,
  syncSchema,
  t,
} from "@brickkit/core";
import { crud } from "@brickkit/crud";
import { Effect, type Layer } from "effect";
import { liveProbe, Probe } from "./probe";
import { checks, monitors, schedules } from "./schema";

export interface MonitorAppOptions {
  /** SQLite file, or `:memory:`. */
  path: string;
  /** How targets are reached. Tests pass a fake. */
  probe?: Layer.Layer<Probe>;
  /** Unique per app in one process. */
  serviceName?: string;
  /** Tests pass `{ timer: false }` and run schedules with `drain()`. */
  dispatch?: { timer?: boolean };
}

/** Strip credentials, query string and fragment, so a token in a URL never comes back on read. */
const publicUrl = (value: string) =>
  Effect.sync(() => {
    // A row with no valid URL reads as empty rather than failing the whole list.
    if (!URL.canParse(value)) return "";
    const url = new URL(value);
    url.username = url.password = url.search = url.hash = "";
    return url.toString();
  });

export function createMonitorApp(options: MonitorAppOptions) {
  const database = defineDatabase({
    path: options.path,
    tables: { monitors, checks, schedules },
  });
  const db = database.getDb();
  syncSchema(database.tables, db);
  const probeLayer = options.probe ?? liveProbe;
  // Every Effect handed to Brick must need nothing: services are provided here, once.
  const run = <A, E>(effect: Effect.Effect<A, E, Probe>) =>
    Effect.provide(effect, probeLayer);

  const service = defineService(options.serviceName ?? "uptime", {
    database,
    // A context hook may return an Effect too.
    // Demo only: anyone can send this header. A real app derives admin from a signed-in user.
    context: (ctx) =>
      Effect.sync(() => ({
        admin: ctx.request?.headers.get("x-admin") === "1",
      })),
  });

  service.resource({ name: "monitor", table: monitors, id: monitors.id }).use(
    crud({
      access: "public",
      operations: { update: false, delete: false },
      fields: {
        id: { read: true },
        name: { read: true, create: true },
        url: {
          read: true,
          create: true,
          // A scrubbed field reads as unknown unless it names its schema.
          schema: t.String(),
          scrub: ({ value }) => publicUrl(String(value)),
        },
      },
    }),
  );

  const load = (id: string) =>
    Effect.promise(() =>
      db.select().from(monitors).where(eq(monitors.id, id)).limit(1),
    ).pipe(Effect.map((rows) => rows[0]));

  /** Probe one monitor and record the outcome. A failed probe is a result, not an error. */
  const probe = (monitor: typeof monitors.$inferSelect) =>
    Effect.gen(function* () {
      const { get } = yield* Probe;
      const outcome = yield* get(monitor.url).pipe(
        Effect.map((answer) => ({
          ok: answer.status < 400,
          status: answer.status,
          latencyMs: answer.latencyMs,
          error: null,
        })),
        Effect.catchTag("ProbeFailed", (failed) =>
          Effect.succeed({
            ok: false,
            status: null,
            latencyMs: null,
            error: failed.reason,
          }),
        ),
      );
      yield* Effect.promise(() =>
        db.insert(checks).values({
          monitorId: monitor.id,
          checkedAt: Date.now(),
          ...outcome,
        }),
      );
      return outcome;
    });

  service.action({
    name: "check",
    input: t.Object({ id: t.String() }),
    output: t.Object({
      ok: t.Boolean(),
      status: t.Union([t.Number(), t.Null()]),
      latencyMs: t.Union([t.Number(), t.Null()]),
      error: t.Union([t.String(), t.Null()]),
    }),
    execute: ({ input, error }) =>
      run(
        Effect.gen(function* () {
          const monitor = yield* load(input.id);
          // A thrown Brick error keeps its code and status inside an Effect.
          if (!monitor) return error.NOT_FOUND("No such monitor");
          return yield* probe(monitor);
        }),
      ),
  });

  service.action({
    name: "status",
    method: "GET",
    input: t.Object({ id: t.String() }),
    execute: ({ input, error }) =>
      Effect.gen(function* () {
        const [last] = yield* Effect.promise(() =>
          db
            .select()
            .from(checks)
            .where(eq(checks.monitorId, input.id))
            .orderBy(desc(checks.checkedAt))
            .limit(1),
        );
        if (!last) return error.NOT_FOUND("Not checked yet");
        return last;
      }),
  });

  service.action({
    name: "clearChecks",
    // authorize may return an Effect of a boolean.
    authorize: ({ ctx }) =>
      Effect.succeed((ctx as { admin?: boolean }).admin === true),
    execute: () =>
      Effect.promise(() => db.delete(checks)).pipe(
        Effect.as({ cleared: true }),
      ),
  });

  const app = brick({
    services: [service],
    events: {
      schedules: [
        defineSchedule({
          name: "check-all",
          every: "1m",
          run: () =>
            run(
              Effect.promise(() => db.select().from(monitors)).pipe(
                Effect.flatMap((all) =>
                  Effect.forEach(all, probe, { concurrency: 4, discard: true }),
                ),
              ),
            ),
        }),
      ],
      ...(options.dispatch ? { dispatch: options.dispatch } : {}),
    },
    requestLogging: false,
    docs: false,
  });
  return { app, database };
}
