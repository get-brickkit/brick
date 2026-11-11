import { ROUTES } from "../src/dashboard-protocol";

/**
 * Ask the dev server to run a schedule now.
 *
 * @returns What to tell the developer when it did not start, or `null` when it did.
 * Never rejects: a server that is down or restarting is a message too.
 */
export async function runSchedule(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(
      `${ROUTES.schedules.path}/${encodeURIComponent(name)}`,
      { method: "POST" },
    );
    if (!response.ok) return await response.text();
    const { started } = (await response.json()) as { started: boolean };
    return started
      ? null
      : `'${name}' is running now, so it was not started again.`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
