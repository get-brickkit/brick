import { sql } from "drizzle-orm";

/** Prepared statements kept per database, the oldest dropped past this many. */
const CACHE_LIMIT = 128;

/**
 * Builds one call's statement. When it can be cached, bound values become
 * placeholders, and the statement is prepared once per key: `identity` plus
 * the query part and the shape recorded while building it.
 */
export function statements() {
  const prepared = new WeakMap<object, Map<string, any>>();
  const prepare = (db: any, key: string, build: () => any) => {
    let cache = prepared.get(db);
    if (!cache) {
      cache = new Map();
      prepared.set(db, cache);
    }
    let statement = cache.get(key);
    if (!statement) {
      statement = build().prepare();
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(key, statement);
    }
    return statement;
  };
  return (cacheable: boolean, identity: unknown[]) => {
    const params: Record<string, unknown> = {};
    const shape: unknown[] = [];
    let parameter = 0;
    const key = (part: string) => JSON.stringify([...identity, part, shape]);
    return {
      shape,
      bind(value: unknown): any {
        if (!cacheable) return value;
        const name = `p${parameter++}`;
        params[name] = value;
        return sql.placeholder(name);
      },
      async run(db: any, part: string, build: () => any): Promise<any> {
        if (cacheable && db.$client?.prepare)
          return prepare(db, key(part), build).execute(params);
        return await build();
      },
      /** Prepares the statement `run` would use, without running it. */
      warm(db: any, part: string, build: () => any): void {
        prepare(db, key(part), build);
      },
    };
  };
}
