import type { Column } from "drizzle-orm";

/**
 * A JSON value as its column stores it: an ISO string becomes a Date for a date
 * column, an integer string a BigInt for a bigint column. Other values pass
 * through.
 *
 * @returns `undefined` when the string can't be a value of the column.
 */
export function columnValue(column: Column, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (column.dataType === "date") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (column.dataType === "bigint")
    return /^-?\d+$/.test(value) ? BigInt(value) : undefined;
  return value;
}
