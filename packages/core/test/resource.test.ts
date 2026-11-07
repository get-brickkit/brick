import { describe, expect, it } from "bun:test";
import {
  defineDatabase,
  defineService,
  defineResourcePlugin,
  sqliteTable,
  text,
  integer,
} from "../src";
import { portOf } from "../src/service-port";
import { defineElsewhere } from "./fixtures/define-elsewhere";
const rows = sqliteTable("generic_rows", {
  key: text("key").primaryKey(),
  label: text("label"),
});
describe("resource declarations", () => {
  it("declares identity without adding actions or changing schema", () => {
    const database = defineDatabase({ tables: { rows } });
    const service = defineService("declarations", { database });
    const host = service.resource({ name: "row", table: rows, id: rows.key });
    expect(host.id).toBe(rows.key);
    expect(host.idField).toBe("key");
    expect(service.listActions()).toEqual([]);
    expect(() => database.getDb().select().from(rows).all()).toThrow();
    expect("create" in host).toBe(false);
  });
  it("infers a single primary key and rejects foreign identifiers", () => {
    const service = defineService("identifiers");
    expect(service.resource({ name: "row", table: rows }).idField).toBe("key");
    const other = sqliteTable("other", { id: integer("id").primaryKey() });
    expect(() =>
      service.resource({ name: "foreign", table: rows, id: other.id }),
    ).toThrow("belonging");
  });
  it("rejects duplicate declarations and declarations after build", () => {
    const service = defineService("declaration_lifecycle");
    service.resource({ name: "row", table: rows });
    expect(() =>
      defineElsewhere(service, "resource", { name: "row", table: rows }),
    ).toThrow(`duplicate resource "row"`);
    service.build();
    expect(() => service.resource({ name: "late", table: rows })).toThrow(
      "before service build",
    );
  });
  it("rolls back plugin preparations with failed installations", () => {
    const service = defineService("preparation_rollback");
    const resource = service.resource({ name: "row", table: rows });
    expect(() =>
      resource.use(
        defineResourcePlugin({
          name: "failed",
          setup({ service }) {
            service.contributePreparation({
              name: "query",
              describe: () => ({ sql: "select 1" }),
              prepare: () => {},
            });
            throw new Error("failed");
          },
        }),
      ),
    ).toThrow("failed");
    expect(portOf(service).listPreparations()).toEqual([]);
  });
});
