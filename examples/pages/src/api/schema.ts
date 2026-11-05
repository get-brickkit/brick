import { appDb } from "./db";

// Drizzle Kit's schema entry point, backed by the same runtime definition.
export const {
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
} = appDb.schema;
