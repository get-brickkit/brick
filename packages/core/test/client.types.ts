import { defineAction, t } from "../src";
import type {
  BrickClient,
  InferActionErrorCodes,
  InferActionInput,
} from "../src/client";

const listPages = defineAction({
  name: "page.list",
  input: t.Object({ limit: t.Optional(t.Number()) }),
  execute: async () => [],
});
const createPage = defineAction({
  name: "page.create",
  input: t.Object({ title: t.String(), content: t.String() }),
  errors: { SLUG_EXISTS: { status: 409, message: "Slug already taken" } },
  execute: async ({ input }) => ({ id: "pg_1", title: input.title }),
});
const charge = defineAction({
  name: "charge",
  input: t.Object({ amount: t.Number() }),
  execute: async () => ({ ok: true }),
});
type AppServer = {
  page: { list: typeof listPages; create: typeof createPage };
  billing: { charge: typeof charge };
};

export const listInput: InferActionInput<typeof listPages> = { limit: 10 };
export const code: InferActionErrorCodes<typeof createPage> = "SLUG_EXISTS";

export function typeChecks(api: BrickClient<AppServer>) {
  // @ts-expect-error title must be a string
  void api.page.create({ title: 123, content: "World" });
  // @ts-expect-error amount is required
  void api.billing.charge({});
  // @ts-expect-error unknown namespaces do not exist
  void api.unknownNamespace.action({});
}
