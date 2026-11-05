/**
 * The world's Redis key layout, the one place storage, streams, the queue and
 * the reaper build key names from. A key added here that belongs to a run must
 * also go in `ownedByRun`, or the reaper leaks it.
 */
export function keys(prefix: string) {
  const k = {
    runKey: (id: string) => `${prefix}run:${id}`,
    runAttributesKey: (id: string) => `${prefix}run:attrs:${id}`,
    // `<status>|<specVersion>`, read by scripts that must check status atomically.
    runMetaKey: (id: string) => `${prefix}run:meta:${id}`,
    runsIndexKey: () => `${prefix}runs:index`,
    runsByNameKey: (name: string) => `${prefix}runs:by_name:${name}`,
    runsByStatusKey: (status: string) => `${prefix}runs:by_status:${status}`,

    eventsKey: (runId: string) => `${prefix}events:data:${runId}`,
    // A correlation id is only unique within its run.
    eventsByCorrelationKey: (runId: string, correlationId: string) =>
      `${prefix}events:by_correlation:${runId}:${correlationId}`,
    resumeClaimKey: (runId: string, resumeId: string) =>
      `${prefix}events:resume:${runId}:${resumeId}`,

    stepKey: (runId: string, stepId: string) =>
      `${prefix}step:${runId}:${stepId}`,
    stepsIndexKey: (runId: string) => `${prefix}steps:by_run:${runId}`,
    // `<status>|<attempt>`, kept beside the step so a script can check it atomically.
    stepStatusKey: (runId: string, stepId: string) =>
      `${prefix}step:status:${runId}:${stepId}`,

    hookKey: (hookId: string) => `${prefix}hook:${hookId}`,
    hooksByTokenKey: (token: string) => `${prefix}hooks:by_token:${token}`,
    hooksIndexKey: (runId: string) => `${prefix}hooks:by_run:${runId}`,
    hooksTokenMapKey: (runId: string) => `${prefix}hooks:tokens:${runId}`,

    // Run IDs (`wrun_<ulid>`) never contain ':', so the first ':' after the run
    // ID always starts the stream name, even if the name contains colons itself.
    streamKey: (runId: string, name: string) =>
      `${prefix}stream:${runId}:${name}`,
    streamsByRunKey: (runId: string) => `${prefix}streams:by_run:${runId}`,
    streamChannel: `${prefix}stream_notify`,

    reaperLockKey: `${prefix}reaper:lock`,
    /** The list queue's ready list; its other keys extend this name. */
    queueKey: `${prefix}queue:flows`,

    /**
     * Every key a run owns except its run, meta and index entries, which the
     * reaper deletes last. Resume claims are not indexed: scan `resumeClaimKey(runId, "*")`.
     */
    ownedByRun(
      runId: string,
      ids: {
        correlationIds: Iterable<string>;
        stepIds: string[];
        hookIds: string[];
        streamNames: string[];
      },
    ): string[] {
      return [
        k.eventsKey(runId),
        k.runAttributesKey(runId),
        k.stepsIndexKey(runId),
        k.hooksIndexKey(runId),
        k.hooksTokenMapKey(runId),
        k.streamsByRunKey(runId),
        ...[...ids.correlationIds].map((id) =>
          k.eventsByCorrelationKey(runId, id),
        ),
        ...ids.stepIds.flatMap((id) => [
          k.stepKey(runId, id),
          k.stepStatusKey(runId, id),
        ]),
        ...ids.hookIds.map(k.hookKey),
        ...ids.streamNames.map((name) => k.streamKey(runId, name)),
      ];
    },
  };
  return k;
}
