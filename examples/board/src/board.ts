import {
  and,
  asc,
  brick,
  defineDatabase,
  defineListener,
  defineService,
  desc,
  emitEvent,
  eq,
  inArray,
  lte,
  or,
  sql,
  syncSchema,
  t,
} from "@brickkit/core";
import { boardEvents } from "./events";
import { messages, outbox, tasks, threads } from "./schema";

export interface Actor {
  id: string;
}

export interface BoardOptions {
  /** SQLite file, or `:memory:`. */
  path: string;
  /** Bearer tokens by actor id. Every call needs one of them. */
  tokens: Record<string, string>;
}

const LEASE_MIN_MS = 30_000;
const LEASE_MAX_MS = 3_600_000;
const LEASE_DEFAULT_MS = 900_000;

const Labels = t.Record(t.String(), t.String());
const TaskState = t.Union([
  t.Literal("ready"),
  t.Literal("claimed"),
  t.Literal("completed"),
]);
const TaskInfo = t.Object({
  state: TaskState,
  holder: t.Union([t.String(), t.Null()]),
  epoch: t.Number(),
  leaseUntil: t.Union([t.Number(), t.Null()]),
  result: t.Union([t.String(), t.Null()]),
});
const Claim = t.Object({
  id: t.String(),
  holder: t.String(),
  epoch: t.Number(),
  leaseUntil: t.Number(),
});
const TaskRow = t.Object({
  id: t.String(),
  channel: t.String(),
  text: t.String(),
  labels: Labels,
  createdAt: t.Number(),
});

const claimErrors = {
  TASK_NOT_CLAIMABLE: {
    status: 409,
    message: "The task is held by someone, or already completed",
  },
  CLAIM_LOST: {
    status: 409,
    message:
      "You hold no live claim on this task: it ended, or another took it",
  },
} as const;

/**
 * The Board domain model: one service whose resources, commands, views and
 * query are everything the HTTP API, the MCP server and the CLI offer.
 */
export function createBoard(options: BoardOptions) {
  const database = defineDatabase({
    path: options.path,
    tables: { threads, messages, tasks, outbox },
  });
  syncSchema(database.tables, database.getDb());

  const actors = new Map(
    Object.entries(options.tokens).map(([id, token]) => [token, { id }]),
  );

  const board = defineService("board", {
    database,
    events: boardEvents,
    // Identity comes from the bearer token, for HTTP and MCP alike.
    context: ({ request }): { user: Actor | null } => {
      const token = /^Bearer (.+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      return { user: (token && actors.get(token)) || null };
    },
  });
  // `authorize: signedIn` runs first, so a user is there.
  const who = (ctx: { user: Actor | null }) => ctx.user!.id;
  const signedIn = ({ user }: { user?: Actor | null }) => user != null;

  // ── Threads ────────────────────────────────────────────────────────────
  const thread = board.resource({
    name: "thread",
    table: threads,
    id: threads.id,
    children: { messages: { table: messages, parent: messages.threadId } },
  });

  thread.action({
    name: "start",
    description: "Start a thread in a channel.",
    input: t.Object({
      channel: t.String({ minLength: 1, description: "Channel name" }),
      text: t.String({ minLength: 1, description: "The root message" }),
      labels: t.Optional(Labels),
    }),
    output: t.Object({ id: t.String() }),
    authorize: signedIn,
    execute: async ({ input, ctx }) => {
      const [row] = await ctx.db
        .insert(threads)
        .values({
          channel: input.channel,
          text: input.text,
          author: who(ctx),
          labels: input.labels ?? {},
        })
        .returning({ id: threads.id });
      await emitEvent(ctx, board.events.threadStarted, {
        id: row!.id,
        channel: input.channel,
      });
      return { id: row!.id };
    },
  });

  thread.action({
    name: "post",
    record: true,
    access: "public",
    description: "Post a message in a thread, as the caller.",
    input: t.Object({ text: t.String({ minLength: 1 }) }),
    output: t.Object({ id: t.String() }),
    authorize: signedIn,
    execute: async ({ input, ctx }) => {
      const [row] = await ctx.db
        .insert(messages)
        .values({
          threadId: String(input.id),
          author: who(ctx),
          text: input.text,
        })
        .returning({ id: messages.id });
      await emitEvent(ctx, board.events.messagePosted, {
        threadId: String(input.id),
        author: who(ctx),
      });
      return { id: row!.id };
    },
  });

  // Commands: pure rules over the row. Brick writes the change and records
  // the event in one transaction.
  thread.command("label", {
    description:
      "Add or change labels. Keys under `board.` are the board's own.",
    access: "public",
    input: t.Object({ labels: Labels }),
    output: t.Object({ id: t.String(), labels: Labels }),
    authorize: signedIn,
    errors: {
      RESERVED_LABEL: {
        status: 422,
        message: "Labels under board. are the board's own",
      },
    },
    decide: (row, input, { error }) =>
      Object.keys(input.labels).some((key) => key.startsWith("board."))
        ? error.RESERVED_LABEL()
        : {
            set: { labels: { ...row.labels, ...input.labels } },
            emit: {
              threadLabeled: {
                id: row.id,
                labels: { ...row.labels, ...input.labels },
              },
            },
          },
  });

  thread.command("scheduleFollowUp", {
    description: "Ask for a follow-up on a thread at a time.",
    access: "public",
    input: t.Object({
      at: t.String({ description: "When, as an ISO 8601 time" }),
    }),
    output: t.Object({ id: t.String(), followUpAt: t.Number() }),
    authorize: signedIn,
    errors: {
      INVALID_TIME: { status: 422, message: "`at` is not an ISO 8601 time" },
    },
    decide: (row, input, { error }) => {
      const at = Date.parse(input.at);
      return Number.isNaN(at)
        ? error.INVALID_TIME()
        : {
            set: { followUpAt: at },
            emit: { followUpScheduled: { id: row.id, at } },
          };
    },
  });

  // ── Tasks ──────────────────────────────────────────────────────────────
  const task = board.resource({ name: "task", table: tasks, id: tasks.id });

  task.action({
    name: "create",
    description: "Create a task: a thread that someone's agents are to do.",
    input: t.Object({
      channel: t.String({ minLength: 1 }),
      text: t.String({ minLength: 1, description: "What is to be done" }),
      labels: t.Optional(Labels),
    }),
    output: t.Object({ id: t.String() }),
    authorize: signedIn,
    execute: async ({ input, ctx }) => {
      const id = crypto.randomUUID();
      ctx.db.transaction((tx) => {
        tx.insert(threads)
          .values({
            id,
            channel: input.channel,
            text: input.text,
            author: who(ctx),
            labels: input.labels ?? {},
          })
          .run();
        tx.insert(tasks).values({ id, channel: input.channel }).run();
      });
      await emitEvent(ctx, board.events.taskCreated, {
        id,
        channel: input.channel,
      });
      return { id };
    },
  });

  // A claim is a lease with an epoch. Each write below is one conditional
  // UPDATE, so of claims that race exactly one lands, and a claim that ended
  // can no longer write.
  const live = (id: string, holder: string, epoch: number, now: number) =>
    and(
      eq(tasks.id, id),
      eq(tasks.state, "claimed"),
      eq(tasks.holder, holder),
      eq(tasks.epoch, epoch),
      sql`${tasks.leaseUntil} > ${now}`,
    );

  task.action({
    name: "claim",
    record: true,
    access: "public",
    description:
      "Claim a task as the caller. A lease: renew it before it ends, or another may take the task.",
    input: t.Object({
      leaseMs: t.Optional(
        t.Integer({
          minimum: LEASE_MIN_MS,
          maximum: LEASE_MAX_MS,
          description: "Lease length in ms (default 15 minutes)",
        }),
      ),
    }),
    output: Claim,
    errors: claimErrors,
    authorize: signedIn,
    execute: async ({ input, ctx, error }) => {
      const now = Date.now();
      const leaseUntil = now + (input.leaseMs ?? LEASE_DEFAULT_MS);
      const [won] = await ctx.db
        .update(tasks)
        .set({
          state: "claimed",
          holder: who(ctx),
          epoch: sql`${tasks.epoch} + 1`,
          leaseUntil,
        })
        .where(
          and(
            eq(tasks.id, String(input.id)),
            or(
              eq(tasks.state, "ready"),
              and(eq(tasks.state, "claimed"), lte(tasks.leaseUntil, now)),
            ),
          ),
        )
        .returning();
      if (!won) return error.TASK_NOT_CLAIMABLE();
      await emitEvent(ctx, board.events.taskClaimed, {
        id: won.id,
        holder: who(ctx),
        epoch: won.epoch,
      });
      return { id: won.id, holder: who(ctx), epoch: won.epoch, leaseUntil };
    },
  });

  task.action({
    name: "renew",
    record: true,
    access: "public",
    description:
      "Extend a lease you hold, from now. Pass the epoch the claim gave.",
    input: t.Object({
      epoch: t.Integer(),
      leaseMs: t.Optional(
        t.Integer({ minimum: LEASE_MIN_MS, maximum: LEASE_MAX_MS }),
      ),
    }),
    output: Claim,
    errors: claimErrors,
    authorize: signedIn,
    execute: async ({ input, ctx, error }) => {
      const now = Date.now();
      const leaseUntil = now + (input.leaseMs ?? LEASE_DEFAULT_MS);
      const [row] = await ctx.db
        .update(tasks)
        .set({ leaseUntil })
        .where(live(String(input.id), who(ctx), input.epoch, now))
        .returning();
      if (!row) return error.CLAIM_LOST();
      await emitEvent(ctx, board.events.leaseRenewed, {
        id: row.id,
        epoch: row.epoch,
      });
      return { id: row.id, holder: who(ctx), epoch: row.epoch, leaseUntil };
    },
  });

  task.action({
    name: "complete",
    record: true,
    access: "public",
    description: "Finish a task you hold, with its result.",
    input: t.Object({ epoch: t.Integer(), result: t.Optional(t.String()) }),
    output: t.Object({ id: t.String(), state: t.Literal("completed") }),
    errors: claimErrors,
    authorize: signedIn,
    execute: async ({ input, ctx, error }) => {
      const [row] = await ctx.db
        .update(tasks)
        .set({
          state: "completed",
          result: input.result ?? null,
          leaseUntil: null,
        })
        .where(live(String(input.id), who(ctx), input.epoch, Date.now()))
        .returning();
      if (!row) return error.CLAIM_LOST();
      await emitEvent(ctx, board.events.taskCompleted, {
        id: row.id,
        holder: who(ctx),
      });
      return { id: row.id, state: "completed" as const };
    },
  });

  task.action({
    name: "release",
    record: true,
    access: "public",
    description: "Hand a task you hold back, ready again.",
    input: t.Object({ epoch: t.Integer() }),
    output: t.Object({ id: t.String(), state: t.Literal("ready") }),
    errors: claimErrors,
    authorize: signedIn,
    execute: async ({ input, ctx, error }) => {
      const [row] = await ctx.db
        .update(tasks)
        .set({ state: "ready", holder: null, leaseUntil: null })
        .where(live(String(input.id), who(ctx), input.epoch, Date.now()))
        .returning();
      if (!row) return error.CLAIM_LOST();
      await emitEvent(ctx, board.events.taskReleased, {
        id: row.id,
        holder: who(ctx),
      });
      return { id: row.id, state: "ready" as const };
    },
  });

  // ── Views and the query: reads, never writes ────────────────────────────
  const taskOf = (row: typeof tasks.$inferSelect | undefined) =>
    row
      ? {
          state: row.state as "ready" | "claimed" | "completed",
          holder: row.holder,
          epoch: row.epoch,
          leaseUntil: row.leaseUntil,
          result: row.result,
        }
      : null;

  board.action({
    name: "threadSummary",
    description: "A thread in brief: its root, counts, labels and task state.",
    input: t.Object({ id: t.String() }),
    output: t.Object({
      id: t.String(),
      channel: t.String(),
      text: t.String(),
      author: t.String(),
      labels: Labels,
      followUpAt: t.Union([t.Number(), t.Null()]),
      messageCount: t.Number(),
      lastActivityAt: t.Number(),
      task: t.Union([TaskInfo, t.Null()]),
    }),
    authorize: signedIn,
    execute: async ({ input, ctx, error }) => {
      const [row] = await ctx.db
        .select()
        .from(threads)
        .where(eq(threads.id, input.id));
      if (!row) return error.NOT_FOUND(`thread '${input.id}' not found`);
      const replies = await ctx.db
        .select()
        .from(messages)
        .where(eq(messages.threadId, row.id));
      const [own] = await ctx.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, row.id));
      return {
        id: row.id,
        channel: row.channel,
        text: row.text,
        author: row.author,
        labels: row.labels,
        followUpAt: row.followUpAt,
        messageCount: replies.length,
        lastActivityAt: Math.max(
          row.createdAt,
          ...replies.map((m) => m.createdAt),
        ),
        task: taskOf(own),
      };
    },
  });

  board.action({
    name: "threadTimeline",
    description: "A thread's root and replies, oldest first.",
    input: t.Object({ id: t.String() }),
    output: t.Object({
      id: t.String(),
      entries: t.Array(
        t.Object({
          at: t.Number(),
          kind: t.Union([t.Literal("root"), t.Literal("message")]),
          author: t.String(),
          text: t.String(),
        }),
      ),
    }),
    authorize: signedIn,
    execute: async ({ input, ctx, error }) => {
      const [row] = await ctx.db
        .select()
        .from(threads)
        .where(eq(threads.id, input.id));
      if (!row) return error.NOT_FOUND(`thread '${input.id}' not found`);
      const replies = await ctx.db
        .select()
        .from(messages)
        .where(eq(messages.threadId, row.id))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      return {
        id: row.id,
        entries: [
          {
            at: row.createdAt,
            kind: "root" as const,
            author: row.author,
            text: row.text,
          },
          ...replies.map((m) => ({
            at: m.createdAt,
            kind: "message" as const,
            author: m.author,
            text: m.text,
          })),
        ],
      };
    },
  });

  board.action({
    name: "channelBoard",
    description:
      "A channel's threads, newest first, with reply counts and task state.",
    input: t.Object({
      channel: t.String(),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
    }),
    output: t.Object({
      channel: t.String(),
      threads: t.Array(
        t.Object({
          id: t.String(),
          text: t.String(),
          author: t.String(),
          labels: Labels,
          replies: t.Number(),
          taskState: t.Union([TaskState, t.Null()]),
          createdAt: t.Number(),
        }),
      ),
    }),
    authorize: signedIn,
    execute: async ({ input, ctx }) => {
      const rows = await ctx.db
        .select()
        .from(threads)
        .where(eq(threads.channel, input.channel))
        .orderBy(desc(threads.createdAt))
        .limit(input.limit ?? 50);
      const ids = rows.map((row) => row.id);
      const replies = ids.length
        ? await ctx.db
            .select({ threadId: messages.threadId })
            .from(messages)
            .where(inArray(messages.threadId, ids))
        : [];
      const owned = ids.length
        ? await ctx.db.select().from(tasks).where(inArray(tasks.id, ids))
        : [];
      return {
        channel: input.channel,
        threads: rows.map((row) => ({
          id: row.id,
          text: row.text,
          author: row.author,
          labels: row.labels,
          replies: replies.filter((m) => m.threadId === row.id).length,
          taskState:
            taskOf(owned.find((own) => own.id === row.id))?.state ?? null,
          createdAt: row.createdAt,
        })),
      };
    },
  });

  board.action({
    name: "readyTasks",
    description:
      "Tasks that can be claimed now, oldest first. A task whose lease ran out counts as ready.",
    input: t.Object({
      channel: t.Optional(t.String()),
      label: t.Optional(
        t.String({ description: "key=value the task must carry" }),
      ),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
    }),
    output: t.Object({ tasks: t.Array(TaskRow) }),
    authorize: signedIn,
    execute: async ({ input, ctx }) => {
      const now = Date.now();
      const [key, ...rest] = (input.label ?? "").split("=");
      const rows = await ctx.db
        .select({ task: tasks, thread: threads })
        .from(tasks)
        .innerJoin(threads, eq(threads.id, tasks.id))
        .where(
          and(
            or(
              eq(tasks.state, "ready"),
              and(eq(tasks.state, "claimed"), lte(tasks.leaseUntil, now)),
            ),
            input.channel ? eq(tasks.channel, input.channel) : undefined,
          ),
        )
        .orderBy(asc(tasks.createdAt));
      return {
        tasks: rows
          .filter(
            ({ thread: { labels } }) =>
              !input.label || labels[key!] === rest.join("="),
          )
          .slice(0, input.limit ?? 50)
          .map(({ thread: row }) => ({
            id: row.id,
            channel: row.channel,
            text: row.text,
            labels: row.labels,
            createdAt: row.createdAt,
          })),
      };
    },
  });

  const app = brick({
    services: [board],
    events: {
      listeners: [
        defineListener({
          name: "board-log",
          on: "board.*",
          run: ({ name, payload }) => {
            console.log(`[event] ${name} ${JSON.stringify(payload)}`);
          },
        }),
      ],
      dispatch: { intervalMs: 250 },
    },
    requestLogging: false,
    docs: false,
  });

  return { app, board, database };
}
