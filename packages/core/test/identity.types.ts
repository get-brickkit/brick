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
    // @ts-expect-error
    void ctx.deps.other;
    // @ts-expect-error
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
  // @ts-expect-error
  identity: (ctx) => ({ id: ctx.n }),
});

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
