import { definePlugin, defineService, t } from "../src";

type Mailer = { send(to: string): Promise<void> };
const mailer: Mailer = { send: async () => undefined };

export const notify = definePlugin({
  name: "@acme/brick-notify",
  deps: { mailer: {} as Mailer },
  service: ({ service, deps }) => {
    const send: Mailer["send"] = deps.mailer.send;
    void send;
    // @ts-expect-error not a declared dep
    void deps.mailr;
    service.action({
      name: "notify.send",
      input: t.Object({ to: t.String() }),
      execute: async ({ input, ctx }) => {
        await ctx.deps.mailer.send(input.to);
        // @ts-expect-error not a declared dep
        void ctx.deps.mailr;
        return { ok: true };
      },
    });
  },
  resource: ({ resource, deps, routes, hooks }) => {
    void deps.mailer;
    resource.action({
      name: "ping",
      execute: ({ ctx }) => {
        void ctx.deps.mailer.send;
        // @ts-expect-error not a declared dep
        void ctx.deps.other;
        return null;
      },
    });
    routes.endpoint({
      name: "hook",
      path: "/hook",
      method: "POST",
      handler: ({ ctx }) => ctx.deps.mailer.send("a"),
    });
    hooks.afterCreate(({ ctx }) => {
      void ctx.deps.mailer;
      // @ts-expect-error not a declared dep
      void ctx.deps.other;
    });
    return {};
  },
  app: ({ deps, on }) => {
    void deps.mailer;
    on("start", (context) => void context.deps.mailer);
  },
});

const orders = defineService("orders", {});
orders.use(notify({}, { deps: { mailer } }));
orders.use(notify(undefined, { deps: { mailer }, prefix: "x_" }));
// @ts-expect-error deps.mailer is required
orders.use(notify());
// @ts-expect-error deps.mailer is required
orders.use(notify({}, {}));
// @ts-expect-error deps.mailer is required
orders.use(notify({}, { deps: {} }));
// @ts-expect-error extra keys are an error
orders.use(notify({}, { deps: { mailer, extra: 1 } }));
// @ts-expect-error the dep has the wrong type
orders.use(notify({}, { deps: { mailer: 1 } }));

// A plugin without deps: nothing changes, and ctx.deps is {}.
export const plain = definePlugin({
  name: "@acme/brick-plain",
  service: ({ service, deps }) => {
    const none: {} = deps;
    void none;
    service.action({
      name: "plain.run",
      execute: ({ ctx }) => {
        const own: {} = ctx.deps;
        // @ts-expect-error a plugin without deps has none
        void ctx.deps.carrier;
        // The rest of the host context stays loose.
        void ctx.user;
        return own;
      },
    });
  },
});
orders.use(plain());
orders.use(plain({}, { prefix: "p_" }));
// @ts-expect-error a plugin without deps takes none
orders.use(plain({}, { deps: { mailer } }));
