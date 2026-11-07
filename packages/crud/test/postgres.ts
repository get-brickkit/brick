import { describe } from "bun:test";

export const url = process.env.TEST_DATABASE_URL;
if (!url)
  console.warn(
    "@brickkit/crud: Postgres suites skipped, set TEST_DATABASE_URL to run them",
  );
/** `describe`, or `describe.skip` when no test database is configured. */
export const suite = url ? describe : describe.skip;
