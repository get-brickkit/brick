import type { World } from "@workflow/world";
import { createContext } from "react-router";

import type { InspectorCaller } from "../../server/handler";

/** The host's world, set on each request's router context. */
export const worldContext = createContext<World>();

export const callerContext = createContext<InspectorCaller | undefined>(
  undefined,
);
