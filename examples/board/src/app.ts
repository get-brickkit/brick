import { mkdirSync } from "node:fs";
import { createBoard } from "./board";
import { boardMcp } from "./mcp";

// BOARD_TOKENS="julian=tok1,claude=tok2": the actors and their bearer tokens.
const tokens = Object.fromEntries(
  (process.env.BOARD_TOKENS ?? "demo=demo-token").split(",").map((pair) => {
    const at = pair.indexOf("=");
    return [pair.slice(0, at), pair.slice(at + 1)];
  }),
);
if (!process.env.BOARD_TOKENS)
  console.warn("BOARD_TOKENS is not set: using demo=demo-token");

const path = process.env.DB_PATH ?? ".data/board.sqlite";
if (path !== ":memory:") mkdirSync(".data", { recursive: true });

const { app, board } = createBoard({ path, tokens });

// The only handler Brick leaves to the app: MCP, as a POST route.
const mcp = boardMcp(board);
app.post("/mcp", ({ request }: { request: Request }) => mcp(request));

export default app;

if (import.meta.main) app.listen(Number(process.env.PORT ?? 4100));
