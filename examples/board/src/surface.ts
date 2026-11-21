import type { Surface } from "./derive";

// The only surface definition. It names what the Board model offers; the HTTP
// routes, the MCP tools and the CLI subcommands all come from these names and
// from the schemas of the actions they point at (see board.ts).
export const BoardApi = {
  name: "board",
  service: "board",
  commands: {
    StartThread: "thread.start",
    CreateTask: "task.create",
    PostMessage: "thread.post",
    LabelThread: "thread.label",
    ScheduleFollowUp: "thread.scheduleFollowUp",
    ClaimTask: "task.claim",
    RenewLease: "task.renew",
    CompleteTask: "task.complete",
    ReleaseTask: "task.release",
  },
  views: {
    ThreadSummary: "threadSummary",
    ThreadTimeline: "threadTimeline",
    ChannelBoard: "channelBoard",
  },
  queries: { ReadyTasks: "readyTasks" },
} as const satisfies Surface;
