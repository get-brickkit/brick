import { defineDatabase } from "@brickkit/core";
import postgres from "postgres";

import {
  account,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  session,
  user,
  verification,
} from "./auth/schema";
import { databaseUrlSecret } from "./secrets";
import { pagesTable } from "./services/pages/page/model";

// The app owns one postgres-js pool; auth and pages reuse it.
// Pool size 10, as the Go and Rust bench services use.
export const appSql = postgres(databaseUrlSecret.require(), {
  max: 10,
  prepare: false,
});

// Postgres database shared by pages and auth (Node-safe: no bun:sqlite).
export const appDb = defineDatabase({
  engine: "postgres",
  name: "pages",
  tables: {
    account,
    jwks,
    oauthAccessToken,
    oauthClient,
    oauthClientAssertion,
    oauthClientResource,
    oauthConsent,
    oauthRefreshToken,
    oauthResource,
    pagesTable,
    session,
    user,
    verification,
  },
  client: appSql,
});

// Auth tables for isolated test databases (see test/database.ts).
// NOTE: src/auth/schema.ts is CLI-generated (`bun run db:schema`); keep
// hand-owned lists here so regeneration never wipes them.
export const authTables = [
  user,
  session,
  account,
  verification,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
];
