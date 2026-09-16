import type { Job, Project } from "./types.js";

export const DEMO_NOTICE = "演示数据：音符为人工编写，仅用于界面设计，并非 AI 识别结果；不包含音频。";

/** A new independent object per call; never send its IDs to the real API. */
export function createDemoProject(): Project {
  return {
    id: "demo-project-only",
    title: "演示数据 · 多轨编辑器",
    status: "ready",
    bpm: 100,
    timeSignature: "4/4",
    durationSeconds: 12,
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sourceAudioUrl: null,
    latestJobId: null,
    warnings: [DEMO_NOTICE, "BPM 为演示值，并非自动检测结果。"],
    tracks: [
      {
        id: "demo-piano-only",
        name: "钢琴 · 演示",
        kind: "piano",
        program: 0,
        isDrum: false,
        muted: false,
        solo: false,
        volume: 0.8,
        pan: -0.1,
        audioUrl: null,
        transcriptionStatus: "completed",
        warnings: [DEMO_NOTICE],
        notes: [
          { id: "demo-piano-note-1", pitch: 60, startSeconds: 0, durationSeconds: 0.55, velocity: 90 },
          { id: "demo-piano-note-2", pitch: 64, startSeconds: 0.6, durationSeconds: 0.55, velocity: 85 },
          { id: "demo-piano-note-3", pitch: 67, startSeconds: 1.2, durationSeconds: 1.1, velocity: 95 },
          { id: "demo-piano-note-4", pitch: 62, startSeconds: 2.4, durationSeconds: 0.55, velocity: 87 },
          { id: "demo-piano-note-5", pitch: 65, startSeconds: 3, durationSeconds: 0.55, velocity: 84 },
          { id: "demo-piano-note-6", pitch: 69, startSeconds: 3.6, durationSeconds: 1.1, velocity: 93 },
          { id: "demo-piano-note-7", pitch: 60, startSeconds: 4.8, durationSeconds: 2.2, velocity: 82 },
          { id: "demo-piano-note-8", pitch: 64, startSeconds: 4.8, durationSeconds: 2.2, velocity: 78 },
          { id: "demo-piano-note-9", pitch: 67, startSeconds: 4.8, durationSeconds: 2.2, velocity: 85 },
        ],
      },
      {
        id: "demo-bass-only",
        name: "贝斯 · 演示",
        kind: "bass",
        program: 33,
        isDrum: false,
        muted: false,
        solo: false,
        volume: 0.7,
        pan: 0,
        audioUrl: null,
        transcriptionStatus: "completed",
        warnings: [DEMO_NOTICE],
        notes: [
          { id: "demo-bass-note-1", pitch: 36, startSeconds: 0, durationSeconds: 1.1, velocity: 100 },
          { id: "demo-bass-note-2", pitch: 43, startSeconds: 1.2, durationSeconds: 1.1, velocity: 92 },
          { id: "demo-bass-note-3", pitch: 38, startSeconds: 2.4, durationSeconds: 1.1, velocity: 98 },
          { id: "demo-bass-note-4", pitch: 45, startSeconds: 3.6, durationSeconds: 1.1, velocity: 94 },
          { id: "demo-bass-note-5", pitch: 36, startSeconds: 4.8, durationSeconds: 2.2, velocity: 96 },
        ],
      },
      {
        id: "demo-drums-only",
        name: "鼓 · 暂未转录",
        kind: "drums",
        program: 0,
        isDrum: true,
        muted: false,
        solo: false,
        volume: 0.75,
        pan: 0,
        audioUrl: null,
        transcriptionStatus: "unsupported",
        notes: [],
        warnings: [DEMO_NOTICE, "当前基础模型未进行鼓转录；正式工程可保留已分离的鼓音频。"],
      },
    ],
  };
}

/** A static processing-state illustration, not a timer or a fake inference service. */
export function createDemoJob(): Job {
  return {
    id: "demo-job-only",
    projectId: "demo-project-only",
    status: "running",
    stage: "transcribe",
    progress: null,
    message: "演示状态：正在转录；此示例没有运行识别任务。",
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
