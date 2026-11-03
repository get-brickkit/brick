import { crud } from "@brickkit/crud";
import { ActionExecutionError, defineService, eq } from "@brickkit/core";

import { appDb } from "../../../db";
import { pagesTable } from "./model";

export * from "./model";

// 2. Define Service with the shared Postgres database. ctx.user comes from the
// app's `auth.resolve` (session cookie or MCP access token), see app.ts.
export const pagesService = defineService("pages", {
  database: appDb,
});

export const pagesResource = pagesService
  .resource({
    name: "page",
    table: pagesTable,
    id: pagesTable.id,
  })
  .use(
    crud({
      fields: {
        id: { read: true, filter: ["eq", "in"] },
        slug: {
          read: true,
          create: true,
          update: true,
          filter: ["eq", "contains"],
          sort: true,
        },
        title: {
          read: true,
          create: true,
          update: true,
          filter: ["eq", "contains"],
          sort: true,
        },
        content: { read: true, create: true, update: true },
        contentType: { read: true, create: true, update: true },
        theme: { read: true, create: true, update: true },
        isPublic: { read: true, create: true, update: true, filter: ["eq"] },
        userId: { read: true },
        createdAt: { read: true, sort: true },
        updatedAt: { read: true, sort: true },
      },
      defaultLimit: 20,
      maxLimit: 100,
      access: {
        authorize: ({ ctx }) =>
          !!(ctx as { user?: { id?: string } | null }).user?.id,
        scope: ({ operation, ctx }) =>
          operation === "create"
            ? undefined
            : eq(pagesTable.userId, (ctx as { user: { id: string } }).user.id),
      },
      hooks: {
        beforeCreate: async ({ data, ctx, tx }) => {
          const exists = await tx
            .select()
            .from(pagesTable)
            .where(eq(pagesTable.slug, String(data.slug)));
          if (exists.length)
            throw new ActionExecutionError(
              "CONFLICT",
              `Slug '${data.slug}' is already taken`,
              409,
            );
          data.id = crypto.randomUUID();
          data.userId = (ctx as { user: { id: string } }).user.id;
          data.createdAt = data.updatedAt = new Date().toISOString();
        },
        beforeUpdate: ({ data }) => {
          data.updatedAt = new Date().toISOString();
        },
      },
    }),
  );
