import {
  hydrateResourceIOAsync,
  waitEventsToWaitEntity,
} from "@workflow/web-shared";
import type { Event, Hook, Step, WorkflowRun } from "@workflow/world";
import {
  unwrapOrThrow,
  WorkflowWebAPIError,
} from "~/lib/client/workflow-errors";
import { fetchEvents, fetchHook, fetchRun, fetchStep } from "~/lib/rpc-client";
import type { EnvMap } from "~/lib/types";

// Helper function to fetch resource and get correlation ID
async function fetchResourceWithCorrelationId(
  env: EnvMap,
  resource: "run" | "step" | "hook",
  resourceId: string,
  options: {
    runId?: string;
    resolveData?: "none" | "all";
  } = {},
): Promise<{
  data: WorkflowRun | Step | Hook;
  correlationId: string;
}> {
  const resolveData = options.resolveData ?? "all";
  let resourceData: WorkflowRun | Step | Hook;
  let correlationId: string;

  if (resource === "run") {
    resourceData = await unwrapOrThrow(fetchRun(env, resourceId, resolveData));
    correlationId = (resourceData as WorkflowRun).runId;
  } else if (resource === "step") {
    const { runId } = options;
    if (!runId) {
      throw new WorkflowWebAPIError("runId is required for step resource", {
        layer: "client",
      });
    }
    resourceData = await unwrapOrThrow(
      fetchStep(env, runId, resourceId, resolveData),
    );
    correlationId = (resourceData as Step).stepId;
  } else if (resource === "hook") {
    resourceData = await unwrapOrThrow(fetchHook(env, resourceId, resolveData));
    correlationId = (resourceData as Hook).hookId;
  } else {
    throw new WorkflowWebAPIError(`Unknown resource type: ${resource}`, {
      layer: "client",
    });
  }

  return { data: resourceData, correlationId };
}

export async function fetchSpanDetailResource(
  env: EnvMap,
  selection: {
    resource: "run" | "step" | "hook" | "sleep";
    resourceId: string;
    runId?: string;
  },
  options: { encryptionKey?: Uint8Array } = {},
): Promise<WorkflowRun | Step | Hook | Event> {
  const { resource, resourceId, runId } = selection;
  const { encryptionKey } = options;
  const hydrate = async <T>(value: T): Promise<T> =>
    hydrateResourceIOAsync(value, encryptionKey);

  if (resource === "hook") {
    const result = await unwrapOrThrow(fetchHook(env, resourceId, "all"));
    return hydrate(result);
  }

  if (resource === "sleep") {
    if (!runId) {
      throw new WorkflowWebAPIError(
        "runId is required for loading sleep details",
        { layer: "client" },
      );
    }
    const result = await unwrapOrThrow(
      fetchEvents(env, runId, {
        sortOrder: "asc",
        limit: 1000,
        withData: true,
      }),
    );
    // `correlationId` is a top-level event field, untouched by hydration, so
    // filter first and only hydrate the wait's own events. Hydrating the
    // whole page would needlessly decrypt every event in the run when a key
    // is present.
    const waitEvents = await Promise.all(
      (result.data as unknown as Event[])
        .filter((e) => e.correlationId === resourceId)
        .map(hydrate),
    );
    const data = waitEventsToWaitEntity(waitEvents);
    if (data === null) {
      throw new WorkflowWebAPIError(
        `Failed to load ${resource} details: missing required event data`,
        { layer: "client" },
      );
    }
    return data as unknown as Event;
  }

  const { data } = await fetchResourceWithCorrelationId(
    env,
    resource,
    resourceId,
    {
      runId,
    },
  );
  return hydrate(data);
}
