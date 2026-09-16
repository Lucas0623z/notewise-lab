import type { QueryClient } from "@tanstack/react-query";
import type { Job } from "../types";

export const isTerminalJob = (job?: Job): boolean =>
  !!job && ["succeeded", "failed", "cancelled"].includes(job.status);

/** A newly opened SSE stream may replay events older than the REST snapshot. */
export function latestJobSnapshot(
  current: Job | undefined,
  incoming: Job,
): Job {
  if (!current || current.id !== incoming.id) return incoming;
  if (isTerminalJob(current) && !isTerminalJob(incoming)) return current;
  if (Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt))
    return current;
  return incoming;
}

/** Track completion can change only Project, leaving every Job field unchanged. */
export async function fetchJobAndRefreshProject(
  client: QueryClient,
  projectId: string | undefined,
  loadJob: () => Promise<Job>,
): Promise<Job> {
  const job = await loadJob();
  if (projectId) {
    await Promise.all([
      client.invalidateQueries({
        queryKey: ["project", projectId],
        exact: true,
      }),
      client.invalidateQueries({ queryKey: ["projects"], exact: true }),
    ]);
  }
  return latestJobSnapshot(client.getQueryData<Job>(["job", job.id]), job);
}
