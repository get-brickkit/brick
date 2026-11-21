import { createMcpHandler } from "@brickkit/core";
import type { createBoard } from "./board";
import { toMcp } from "./derive";
import { BoardApi } from "./surface";

// examples/board/src/mcp.ts — one MCP tool per surface entry, served on POST /mcp.
// Every call carries the caller's bearer token, which the board's context reads.
export const boardMcp = (board: ReturnType<typeof createBoard>["board"]) =>
  createMcpHandler({
    registry: toMcp(BoardApi, board),
    serverInfo: { name: "board", version: "0.1.0" },
  });
