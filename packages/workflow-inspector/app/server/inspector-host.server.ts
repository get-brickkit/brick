import type { InspectorHost } from "../../server/handler";

// Routes read the host's world from their load context.
declare module "react-router" {
  interface AppLoadContext extends InspectorHost {}
}
