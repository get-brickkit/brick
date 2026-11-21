import { t } from "@brickkit/core";

/** The board's event catalog. Each event is recorded as `board.<name>`. */
export const boardEvents = {
  threadStarted: t.Object({ id: t.String(), channel: t.String() }),
  taskCreated: t.Object({ id: t.String(), channel: t.String() }),
  messagePosted: t.Object({ threadId: t.String(), author: t.String() }),
  threadLabeled: t.Object({
    id: t.String(),
    labels: t.Record(t.String(), t.String()),
  }),
  followUpScheduled: t.Object({ id: t.String(), at: t.Number() }),
  taskClaimed: t.Object({
    id: t.String(),
    holder: t.String(),
    epoch: t.Number(),
  }),
  leaseRenewed: t.Object({ id: t.String(), epoch: t.Number() }),
  taskCompleted: t.Object({ id: t.String(), holder: t.String() }),
  taskReleased: t.Object({ id: t.String(), holder: t.String() }),
};
