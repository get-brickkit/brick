import { defineService, type Identity } from "../src";

interface User {
  id: string;
  email: string;
  orgId: string;
}
declare function readUser(request: Request): Promise<User | undefined>;

defineService("crm", {
  deps: { region: "eu" },
  context: async ({ request }) => ({ user: await readUser(request) }),
  identity: (ctx) => {
    const region: string = ctx.deps.region;
    void region;
    // @ts-expect-error not a declared dep
    void ctx.deps.other;
    // @ts-expect-error not on the context
    void ctx.account;
    return (
      ctx.user && {
        id: ctx.user.id,
        label: ctx.user.email,
        tenant: ctx.tenantId,
      }
    );
  },
});

defineService("sync", {
  context: () => ({ key: "k" }),
  identity: (ctx): Identity => ({ id: ctx.key }),
});

defineService("wrong", {
  context: () => ({ n: 1 }),
  // @ts-expect-error id must be a string
  identity: (ctx) => ({ id: ctx.n }),
});

// A hook may return a whole user: it compiles, and Brick keeps only id, label and tenant.
interface Account {
  id: string;
  email: string;
  passwordHash: string;
}
declare function readAccount(): Account | undefined;
defineService("whole", {
  context: () => ({ user: readAccount() }),
  identity: (ctx) => ctx.user,
});
