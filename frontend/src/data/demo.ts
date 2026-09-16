import type { Job, Note, Project, Track, TrackKind } from "../types";

/** Hand-composed fixture data. These notes are not the output of an AI model. */
export const DEMO_PROJECT_ID = "demo-nocturne";
export const DEMO_STORAGE_KEY = "stem-studio:demo-projects:v1";
export const DEMO_WARNING =
  "演示数据：音符由程序合成，用于体验编辑与 MIDI 试听，未经 AI 分轨或转录。";

const stamp = "2026-09-15T10:00:00.000Z";
const melody = [72, 76, 79, 76, 74, 71, 67, 71, 69, 72, 76, 72, 67, 71, 74, 71];
const roots = [48, 43, 45, 40, 48, 43, 45, 47];

function notesFor(kind: TrackKind, trackId: string): Note[] {
  const notes: Note[] = [];
  const add = (
    pitch: number,
    startSeconds: number,
    durationSeconds: number,
    velocity: number,
  ) => {
    notes.push({
      id: `${trackId}-n${notes.length}`,
      pitch,
      startSeconds,
      durationSeconds: Math.min(durationSeconds, 24 - startSeconds),
      velocity,
    });
  };
  if (kind === "drums") return notes;
  if (kind === "bass") {
    roots.forEach((root, bar) => {
      add(root - 12, bar * 3, 1.35, 84);
      add(root - 12, bar * 3 + 1.5, 1.25, 68);
    });
  } else if (kind === "piano") {
    roots.forEach((root, bar) => {
      [0, 4, 7, 12].forEach((interval, step) =>
        add(root + interval, bar * 3 + step * 0.375, 0.68, 63 + step * 4),
      );
      [7, 4, 12, 7].forEach((interval, step) =>
        add(root + interval, bar * 3 + 1.5 + step * 0.375, 0.6, 61 + step * 3),
      );
    });
  } else if (kind === "guitar") {
    roots.forEach((root, bar) =>
      [12, 16, 19].forEach((interval, voice) =>
        add(
          root + interval,
          bar * 3 + 0.75 + voice * 0.035,
          1.6,
          56 + voice * 5,
        ),
      ),
    );
  } else if (kind === "other") {
    roots.forEach((root, bar) =>
      [0, 7].forEach((interval) => add(root + interval + 12, bar * 3, 2.8, 43)),
    );
  } else {
    [...melody, ...melody].forEach((pitch, index) =>
      add(
        pitch,
        index * 0.75,
        index % 4 === 3 ? 0.57 : 0.65,
        74 + (index % 3) * 4,
      ),
    );
  }
  return notes;
}

function makeTrack(
  kind: TrackKind,
  name: string,
  program: number,
  volume: number,
  pan = 0,
): Track {
  const id = `demo-${kind}`;
  return {
    id,
    kind,
    name,
    program,
    isDrum: kind === "drums",
    muted: false,
    solo: false,
    volume,
    pan,
    audioUrl: null,
    notes: notesFor(kind, id),
    transcriptionStatus: kind === "drums" ? "unsupported" : "completed",
    warnings:
      kind === "drums"
        ? ["演示工程没有鼓音频；首版真实任务可保留鼓音频，但不识别鼓音符。"]
        : ["人工合成音符示例，不是模型识别结果。"],
  };
}

const tracks = [
  makeTrack("piano", "钢琴", 0, 0.75, -0.1),
  makeTrack("vocal", "旋律 · 人声示例", 80, 0.5),
  makeTrack("guitar", "木吉他", 24, 0.45, 0.28),
  makeTrack("bass", "贝斯", 33, 0.7),
  makeTrack("other", "其他乐器", 48, 0.36, -0.2),
  makeTrack("drums", "鼓", 0, 0.65),
];

export const demoProjects: Project[] = [
  {
    id: DEMO_PROJECT_ID,
    title: "午夜随想",
    status: "ready",
    bpm: 80,
    timeSignature: "4/4",
    durationSeconds: 24,
    revision: 0,
    createdAt: stamp,
    updatedAt: stamp,
    sourceAudioUrl: null,
    latestJobId: "demo-job-nocturne",
    tracks,
    warnings: [
      DEMO_WARNING,
      "示例 BPM 为手动设置的 80；没有原始录音或分轨录音。",
    ],
  },
  {
    id: "demo-cancelled",
    title: "窗边的雨 · 部分结果",
    status: "cancelled",
    bpm: 80,
    timeSignature: "4/4",
    durationSeconds: 24,
    revision: 0,
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    sourceAudioUrl: null,
    latestJobId: "demo-job-cancelled",
    tracks: tracks.filter((track) =>
      ["vocal", "bass", "other", "drums"].includes(track.kind),
    ),
    warnings: [
      DEMO_WARNING,
      "界面状态示例：任务已取消，已经完成的音轨仍保留。重新识别应建立新项目。",
    ],
  },
  {
    id: "demo-failed",
    title: "晚风草稿 · 部分结果",
    status: "failed",
    bpm: 80,
    timeSignature: "4/4",
    durationSeconds: 24,
    revision: 0,
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    sourceAudioUrl: null,
    latestJobId: "demo-job-failed",
    tracks: tracks.filter((track) => ["piano", "bass"].includes(track.kind)),
    warnings: [
      DEMO_WARNING,
      "界面状态示例：后续轨道识别失败，已完成的钢琴与贝斯仍可编辑。",
    ],
  },
];

export const demoJobs: Job[] = demoProjects.map((project): Job => {
  const status =
    project.status === "ready"
      ? "succeeded"
      : project.status === "cancelled"
        ? "cancelled"
        : "failed";
  return {
    id: project.latestJobId!,
    projectId: project.id,
    status,
    stage: status === "succeeded" ? "done" : status,
    progress: status === "succeeded" ? 1 : null,
    message:
      status === "succeeded"
        ? "演示工程 · 人工合成音符"
        : status === "cancelled"
          ? "演示状态：任务已取消，部分结果已保留"
          : "演示状态：任务失败，部分结果已保留",
    error:
      status === "failed" ? "这是失败状态演示，没有实际运行识别任务。" : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
});

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<Project>;
  return (
    typeof project.id === "string" &&
    typeof project.title === "string" &&
    typeof project.revision === "number" &&
    typeof project.bpm === "number" &&
    project.timeSignature === "4/4" &&
    Array.isArray(project.tracks) &&
    project.tracks.every(
      (track) => Array.isArray(track.notes) && Array.isArray(track.warnings),
    ) &&
    Array.isArray(project.warnings)
  );
}

export async function readDemoProjects(): Promise<Project[]> {
  if (window.desktop) {
    const saved = await window.desktop.readDemoProjects();
    return structuredClone(saved ?? demoProjects);
  }
  const raw = localStorage.getItem(DEMO_STORAGE_KEY);
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("本地演示工程无法读取，请保留浏览器数据后检查存储内容。");
    }
    if (!Array.isArray(parsed) || !parsed.every(isProject))
      throw new Error("本地演示工程格式不兼容，未覆盖已有数据。");
    return structuredClone(parsed);
  }
  return structuredClone(demoProjects);
}

export async function writeDemoProjects(projects: Project[]): Promise<void> {
  if (window.desktop) {
    await window.desktop.writeDemoProjects(projects);
    return;
  }
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    throw new Error(
      "保存失败：浏览器本地存储不可用或空间不足。当前草稿仍保留在编辑器中。",
    );
  }
}
