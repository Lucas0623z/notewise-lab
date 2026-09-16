import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Job } from "../types";
import { fetchJobAndRefreshProject, latestJobSnapshot } from "./jobSync";

const running: Job = {
  id: "job-1",
  projectId: "project-1",
  status: "running",
  stage: "transcribe",
  progress: 0.5,
  message: "识别中",
  error: null,
  createdAt: "2026-09-15T10:00:00Z",
  updatedAt: "2026-09-15T10:01:00Z",
};

describe("job polling and SSE recovery", () => {
  it("refreshes partial tracks on each poll even when every Job field stays unchanged", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let persistedTracks = ["piano"];
    const observer = new QueryObserver(client, {
      queryKey: ["project", running.projectId],
      queryFn: async () => ({ tracks: [...persistedTracks] }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data?.tracks).toEqual(["piano"]);
      persistedTracks = ["piano", "bass"];
      await fetchJobAndRefreshProject(
        client,
        running.projectId,
        async () => running,
      );
      expect(observer.getCurrentResult().data?.tracks).toEqual([
        "piano",
        "bass",
      ]);
      persistedTracks = ["piano", "bass", "guitar"];
      await fetchJobAndRefreshProject(
        client,
        running.projectId,
        async () => running,
      );
      expect(observer.getCurrentResult().data?.tracks).toEqual([
        "piano",
        "bass",
        "guitar",
      ]);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("does not let old replayed events regress a newer snapshot or reopen a terminal job", () => {
    expect(
      latestJobSnapshot(running, {
        ...running,
        stage: "decode",
        updatedAt: "2026-09-15T10:00:30Z",
      }),
    ).toBe(running);
    const done: Job = {
      ...running,
      status: "succeeded",
      stage: "done",
      progress: 1,
    };
    expect(latestJobSnapshot(done, running)).toBe(done);
    expect(latestJobSnapshot(running, done)).toBe(done);
  });

  it("keeps an SSE completion that arrives while the REST poll is still in flight", async () => {
    const client = new QueryClient();
    const done: Job = {
      ...running,
      status: "succeeded",
      stage: "done",
      progress: 1,
    };
    const result = await fetchJobAndRefreshProject(
      client,
      running.projectId,
      async () => {
        client.setQueryData(["job", running.id], done);
        return running;
      },
    );
    expect(result).toEqual(done);
    client.clear();
  });
});
