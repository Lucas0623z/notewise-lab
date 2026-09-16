import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Job, Project } from "../types";
import { api, DEMO } from "../services/api";
import {
  fetchJobAndRefreshProject,
  isTerminalJob,
  latestJobSnapshot,
} from "./jobSync";

/** Polling is the source-of-truth fallback; SSE only makes real changes arrive sooner. */
export function useProjectJob(project?: Project) {
  const client = useQueryClient();
  const jobId = project?.latestJobId ?? null;
  const projectId = project?.id;
  const [streamError, setStreamError] = useState<Error | null>(null);
  const query = useQuery({
    queryKey: ["job", jobId],
    queryFn: () =>
      fetchJobAndRefreshProject(client, projectId, () => api.getJob(jobId!)),
    enabled: !!jobId,
    refetchInterval: (current) =>
      DEMO || isTerminalJob(current.state.data) ? false : 2500,
    retry: 1,
  });
  const isTerminal = isTerminalJob(query.data);

  useEffect(() => {
    setStreamError(null);
  }, [jobId]);

  useEffect(() => {
    if (!jobId || !projectId || DEMO || isTerminal) return;
    let active = true;
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ["project", projectId] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    };
    const subscription = api.subscribeToJob(jobId, {
      onEvent(event) {
        if (!active) return;
        if (event.type !== "track.ready") {
          const incoming = event.data;
          client.setQueryData<Job>(["job", jobId], (current) =>
            latestJobSnapshot(current, incoming),
          );
        }
        setStreamError(null);
        refresh();
      },
      onConnectionChange(state) {
        if (!active) return;
        if (state === "open") {
          setStreamError(null);
          void client.invalidateQueries({
            queryKey: ["job", jobId],
            exact: true,
          });
          refresh();
        }
        if (state === "reconnecting")
          setStreamError(
            new Error("实时连接暂时中断，正在重连；仍会定期读取任务状态。"),
          );
        if (state === "closed")
          void client.invalidateQueries({ queryKey: ["job", jobId] });
      },
      onInvalidEvent() {
        if (!active) return;
        setStreamError(new Error("任务事件暂时无法读取，正在获取最新状态。"));
        void client.invalidateQueries({ queryKey: ["job", jobId] });
        refresh();
      },
    });
    return () => {
      active = false;
      subscription.close();
    };
  }, [client, jobId, projectId, isTerminal]);

  useEffect(() => {
    if (isTerminal) setStreamError(null);
  }, [isTerminal]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!jobId) throw new Error("项目尚未创建任务。");
      return api.cancelJob(jobId);
    },
    onSuccess(job) {
      client.setQueryData(["job", job.id], job);
      void client.invalidateQueries({ queryKey: ["project", projectId] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  return {
    job: query.data,
    isLoading: !!jobId && query.isLoading,
    error: mutation.error ?? query.error ?? streamError,
    cancel: mutation.mutateAsync,
    isCancelling: mutation.isPending,
  };
}
