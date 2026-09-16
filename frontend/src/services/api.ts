import { ApiError, StemStudioClient } from "../../../frontend-kit/src/index";
import type {
  CreateProjectInput,
  JobEventHandlers,
  JobSubscription,
  Project,
  UploadAudioInput,
} from "../types";
import {
  demoJobs,
  demoProjects,
  readDemoProjects,
  writeDemoProjects,
} from "../data/demo";

export { ApiError };
export const DEMO = window.desktop
  ? window.desktop.mode !== "api"
  : import.meta.env.VITE_DEMO_MODE !== "false";
export const SDK_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(
  /\/+$/,
  "",
);
const sdk = new StemStudioClient({ baseUrl: SDK_BASE });
let demoTransactions: Promise<void> = Promise.resolve();

/** Revision checks and persistent writes form one transaction in this renderer. */
function withDemoTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const next = demoTransactions.then(operation);
  demoTransactions = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError && /fetch|network|load/i.test(error.message))
    return "无法连接本机服务。请确认后端已启动，再重试。";
  if (error instanceof Error) return error.message;
  return "操作未完成，请重试。";
}

export function resolveAssetUrl(url: string | null | undefined): string | null {
  return url ? sdk.resolveAssetUrl(url) : null;
}

async function demoProject(id: string): Promise<Project> {
  const project = (await readDemoProjects()).find((item) => item.id === id);
  if (!project) throw new ApiError(404, "项目不存在", null);
  return project;
}

export const api = {
  async getServiceStatus() {
    return sdk.getServiceStatus({ signal: AbortSignal.timeout(5000) });
  },
  async listProjects(): Promise<{ items: Project[] }> {
    if (!DEMO) return sdk.listProjects();
    return {
      items: (await readDemoProjects()).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    };
  },
  async getProject(id: string): Promise<Project> {
    return DEMO ? demoProject(id) : sdk.getProject(id);
  },
  async createProject(input: CreateProjectInput): Promise<Project> {
    if (!DEMO) return sdk.createProject(input);
    return withDemoTransaction(async () => {
      const stamp = new Date().toISOString();
      const project: Project = {
        id: `demo-${crypto.randomUUID()}`,
        title: input.title.trim(),
        status: "empty",
        bpm: input.bpm ?? 120,
        timeSignature: "4/4",
        durationSeconds: 0,
        revision: 0,
        createdAt: stamp,
        updatedAt: stamp,
        sourceAudioUrl: null,
        latestJobId: null,
        tracks: [],
        warnings: ["本地演示工程，没有运行 AI 识别。"],
      };
      await writeDemoProjects([project, ...(await readDemoProjects())]);
      return structuredClone(project);
    });
  },
  async saveProject(project: Project): Promise<Project> {
    if (!DEMO)
      return sdk.saveProject(project.id, {
        expectedRevision: project.revision,
        title: project.title,
        bpm: project.bpm,
        timeSignature: project.timeSignature,
        tracks: project.tracks,
      });
    // Capture before queueing; subsequent local edits belong to a later save.
    const submitted = structuredClone(project);
    return withDemoTransaction(async () => {
      const projects = await readDemoProjects();
      const index = projects.findIndex((item) => item.id === submitted.id);
      if (index < 0) throw new ApiError(404, "项目不存在", null);
      if (projects[index].revision !== submitted.revision)
        throw new ApiError(
          409,
          "项目已在另一个页面修改。当前草稿已保留，请重新加载或比较修改。",
          null,
        );
      const baseDuration =
        demoProjects.find((item) => item.id === submitted.id)
          ?.durationSeconds ?? 0;
      const saved: Project = {
        ...submitted,
        revision: submitted.revision + 1,
        updatedAt: new Date().toISOString(),
        durationSeconds: submitted.tracks.reduce(
          (end, track) =>
            track.notes.reduce(
              (last, note) =>
                Math.max(last, note.startSeconds + note.durationSeconds),
              end,
            ),
          baseDuration,
        ),
        status: submitted.status,
      };
      projects[index] = saved;
      await writeDemoProjects(projects);
      return structuredClone(saved);
    });
  },
  async uploadAudio(id: string, input: UploadAudioInput) {
    if (DEMO)
      throw new Error(
        "演示模式不运行 AI 识别。请连接本机后端，或打开示例体验编辑。",
      );
    return sdk.uploadAudio(id, input);
  },
  async getJob(id: string) {
    if (!DEMO) return sdk.getJob(id);
    const job = demoJobs.find((item) => item.id === id);
    if (!job) throw new ApiError(404, "任务不存在", null);
    return structuredClone(job);
  },
  async cancelJob(id: string) {
    if (!DEMO) return sdk.cancelJob(id);
    return this.getJob(id);
  },
  subscribeToJob(id: string, handlers: JobEventHandlers): JobSubscription {
    if (!DEMO) return sdk.subscribeToJob(id, handlers);
    handlers.onConnectionChange?.("closed");
    return { close() {}, getLastEventId: () => null };
  },
  exportMidiUrl(id: string): string {
    if (DEMO) throw new Error("演示工程请使用编辑器的本地 MIDI 导出。");
    return sdk.projectMidiUrl(id);
  },
};
