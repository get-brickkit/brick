import {
  ActionExecutionError,
  definePlugin,
  emitEvent,
  eq,
  t,
} from "@brickkit/core";
import { crud } from "@brickkit/crud";

/**
 * Comments on any resource. The plugin owns its table (`<resource>_comments`,
 * created in the host's database for its engine), deletes a record's comments
 * with it through the host's own CRUD hooks, and emits `comments.added`.
 */
export const comments = definePlugin({
  name: "@brick-examples/comments",
  description: "Comments on any resource, with CRUD routes of their own.",
  brick: ">=0.10.0",
  requires: ["@brickkit/crud"],
  options: t.Object({
    maxLength: t.Integer({
      default: 2000,
      minimum: 1,
      description: "The longest comment body, in characters.",
    }),
  }),
  tables: ({ table, text, timestamp }) => ({
    comments: table("comments", {
      id: text("id")
        .primaryKey()
        .$defaultFn(() => crypto.randomUUID()),
      targetId: text("target_id").notNull(),
      body: text("body").notNull(),
      createdAt: timestamp("created_at")
        .notNull()
        .$defaultFn(() => new Date()),
    }),
  }),
  events: { added: t.Object({ id: t.String(), targetId: t.String() }) },

  resource: ({ resource, service, tables, options, events, hooks }) => {
    const table = tables.comments;
    const clean = (body: unknown) => {
      const text = String(body ?? "").trim();
      if (!text)
        throw new ActionExecutionError(
          "BAD_REQUEST",
          "Comment body cannot be blank",
          400,
        );
      if (text.length > options.maxLength)
        throw new ActionExecutionError(
          "BAD_REQUEST",
          `Comment body is longer than ${options.maxLength} characters`,
          400,
        );
      return text;
    };

    // The host's lifecycle: a deleted record takes its comments along, in
    // the same transaction.
    hooks.afterDelete(({ id, tx }) =>
      tx.delete(table).where(eq(table.targetId, String(id))),
    );

    const comment = service
      .resource({ name: `${resource.name}Comment`, table, id: table.id })
      .use(
        crud({
          access: "public",
          fields: {
            id: { read: true, filter: ["eq"] },
            targetId: { read: true, create: true, filter: ["eq"] },
            body: {
              read: true,
              create: true,
              update: true,
              filter: ["contains"],
            },
            createdAt: { read: true, sort: true },
          },
          hooks: {
            beforeCreate: async ({ data, tx }) => {
              data.body = clean(data.body);
              const parents = await tx
                .select({ id: resource.id })
                .from(resource.table)
                .where(eq(resource.id, data.targetId))
                .limit(1);
              if (!parents.length)
                throw new ActionExecutionError(
                  "NOT_FOUND",
                  "Comment target not found",
                  404,
                );
            },
            beforeUpdate: ({ data }) => {
              if (data.body !== undefined) data.body = clean(data.body);
            },
            // Recorded only when the app records events (brick({ events })).
            afterCreate: async ({ row, ctx, tx }) => {
              if (service.recorder)
                await emitEvent(
                  ctx,
                  events.added,
                  { id: String(row.id), targetId: String(row.targetId) },
                  { tx },
                );
            },
          },
        }),
      );
    return { comments: comment };
  },

  dashboard: "./dashboard.tsx",
});
