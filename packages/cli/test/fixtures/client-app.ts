import { brick } from "@brickkit/core";
import { defineService, t } from "@brickkit/core";

const jsonValue = t.Recursive(
  (self) =>
    t.Union([
      t.Null(),
      t.Boolean(),
      t.Number(),
      t.String(),
      t.Array(self),
      t.Record(t.String(), self),
    ]),
  { title: "JsonValue" },
);

export const records = defineService("records");
records.tool({
  name: "get_value",
  http: true,
  path: "/:doctype/value",
  method: "POST",
  input: t.Object({
    doctype: t.Literal("CRMDeal"),
    fields: t.Array(t.String()),
  }),
  output: t.String(),
  errors: { MISSING: { status: 404, message: "Missing record" } },
  execute: ({ input }) => `${input.doctype}:${input.fields.join(",")}`,
});
records.tool({
  name: "search",
  http: true,
  method: "POST",
  input: t.Object({
    term: t.String(),
    limit: t.Optional(t.Number()),
    filters: t.Optional(jsonValue),
  }),
  output: t.Array(t.String()),
  execute: ({ input }) => [input.term],
});
records.tool({ name: "private_tool", execute: () => "__backend_only__" });

export const users = defineService("users");
users.tool({
  name: "profile.get",
  http: true,
  path: "/:id",
  method: "GET",
  input: t.Object({ id: t.String(), details: t.Optional(t.Boolean()) }),
  output: t.Object({
    id: t.String(),
    roles: t.Array(t.Union([t.Literal("admin"), t.Literal("member")])),
  }),
  execute: ({ input }) => ({ id: input.id, roles: ["member"] }),
});
users.tool({
  name: "update",
  http: true,
  path: "/update",
  method: "PATCH",
  input: t.Object({ id: t.String(), name: t.String() }),
  output: t.Boolean(),
  execute: () => true,
});

const unselected = defineService("unselected");
unselected.action({ name: "hidden", execute: () => "__unselected__" });
export default brick({
  services: [records, users],
  prefix: "/v2",
  requestLogging: false,
});
