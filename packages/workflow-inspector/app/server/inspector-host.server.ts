import type { World } from "@workflow/world";
import { createContext } from "react-router";

/** The host's world, set on each request's router context. */
export const worldContext = createContext<World>();
