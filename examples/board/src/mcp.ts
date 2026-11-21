import { createMcpHandler } from "@brickkit/core";
import type { createBoard } from "./board";
import { toMcp } from "./derive";
import { BoardApi, exposed } from "./surface";

// examples/board/src/mcp.ts — one MCP tool per surface entry, served on POST /mcp.
// Every call carries the caller's bearer token, which the board's context reads.
export const boardMcp = (board: ReturnType<typeof createBoard>["board"]) =>
  createMcpHandler({
    registry: toMcp(BoardApi, board, { expose: exposed }),
    serverInfo: { name: "board", version: "0.1.0" },
    protocolVersions: ["2025-06-18", "2025-03-26", "2024-11-05"],
  });
