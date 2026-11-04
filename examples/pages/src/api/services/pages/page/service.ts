import { crud } from "@brickkit/crud";
import { ActionExecutionError, defineService, eq } from "@brickkit/core";

import { getAuth } from "../../../auth";
import { appDb } from "../../../db";
import { pagesTable } from "./model";

export * from "./model";

// 2. Define Service with the shared Postgres database + better-auth session loading.
// The context resolver runs once per request: it reads the session cookie
// via better-auth and injects user/session for all actions. An MCP call
// arrives with its access token's user already set (see ../../../mcp.ts), so
// that one is kept instead of being reset by the missing cookie.
export const pagesService = defineService("pages", {
  context: async ({ request, user }) => {
    const session = user
      ? null
      : await getAuth().api.getSession({ headers: request.headers });
    return {
      session: session?.session ?? null,
      user:
        (user as NonNullable<typeof session>["user"] | undefined) ??
        session?.user ??
        null,
    };
  },
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
