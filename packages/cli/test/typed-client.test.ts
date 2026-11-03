import { beforeEach, expect, it } from "bun:test";
import {
  defineDatabase,
  defineService,
  syncSchema,
  sqliteTable,
  text,
  resetGlobalRegistry,
  brick,
} from "@brickkit/core";
import { crud } from "@brickkit/crud";
import { createBrickClient } from "@brickkit/core/client";
import { generateClientContract } from "../src/client-contract";
beforeEach(resetGlobalRegistry);
it("uses generated metadata for CRUD routes, namespaced calls and disabled exposure", async () => {
  const table = sqliteTable("client_notes", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
  });
  const database = defineDatabase({ tables: [table] }),
    db = database.getDb();
  syncSchema(database.tables, db);
  const service = defineService("notes", { database });
  const note = service.resource({ name: "note", table }).use(
    crud({
      access: "public",
      fields: {
        id: { read: true, create: true },
        title: { read: true, create: true, update: true },
      },
      routes: { count: false, list: { path: "/search" } },
    }),
  );
  const app = brick({
    services: [service],
    prefix: "/v2",
    requestLogging: false,
  });
  const source = generateClientContract(app);
  const serialized = source.match(/JSON\.parse\((".*")\);/)![1]!;
  const contract = JSON.parse(JSON.parse(serialized));
  const api = createBrickClient({
    baseUrl: "http://localhost",
    contract,
    fetch: ((url: any, options: any) =>
      app.handle(new Request(url, options))) as typeof fetch,
  });
  try {
    expect(contract.notes.note.list.config).toEqual({
      method: "POST",
      path: "/v2/notes/note/search",
    });
    expect(contract.notes.note.count).toBeUndefined();
    expect(await api.notes.note.create({ id: "one", title: "Hello" })).toEqual({
      id: "one",
      title: "Hello",
    });
    expect((await api.notes.note.list({})).items).toEqual([
      { id: "one", title: "Hello" },
    ]);
    expect(
      await api.notes.note.update({ id: "one", data: { title: "Edited" } }),
    ).toEqual({ id: "one", title: "Edited" });
    expect(await note.count.run({})).toEqual({ count: 1 });
    expect(await api.notes.note.delete({ id: "one" })).toEqual({
      success: true,
    });
  } finally {
    db.$client.close();
  }
});
