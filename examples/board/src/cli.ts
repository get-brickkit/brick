import { toCli } from "./derive";
import { BoardApi } from "./surface";

// examples/board/src/cli.ts — one subcommand per surface entry.
const cli = toCli(BoardApi, {
  name: "board",
  baseUrl: process.env.BOARD_URL ?? "http://127.0.0.1:4100",
  headers: () => ({ authorization: `Bearer ${process.env.BOARD_TOKEN ?? ""}` }),
});

process.exit(await cli.run(process.argv.slice(2)));
