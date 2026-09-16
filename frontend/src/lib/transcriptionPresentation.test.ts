import { describe, expect, it } from "vitest";
import type { Project, Track } from "../types";
import { useEditorStore } from "../state/editorStore";
import {
  canEditTrackNotes,
  drumVoiceName,
  remapDrumVoice,
  transcriptionEngineLabel,
} from "./transcriptionPresentation";

const drum: Track = {
  id: "drum",
  name: "镲片",
  kind: "drums",
  isDrum: true,
  program: 0,
  muted: false,
  solo: false,
  volume: 1,
  pan: 0,
  audioUrl: null,
  transcriptionStatus: "completed",
  transcriptionEngine: "cymbal_onsets",
  warnings: [],
  notes: [
    {
      id: "a",
      pitch: 49,
      startSeconds: 0.37,
      durationSeconds: 0.1,
      velocity: 96,
    },
    {
      id: "b",
      pitch: 49,
      startSeconds: 1.58,
      durationSeconds: 0.1,
      velocity: 100,
    },
  ],
};
describe("transcription and percussion presentation", () => {
  it("does not infer an engine for a legacy project", () => {
    expect(
      transcriptionEngineLabel({ ...drum, transcriptionEngine: undefined }),
    ).toBe("旧工程未记录识别引擎");
    expect(transcriptionEngineLabel(drum)).toContain("非鼓组分类");
    expect(
      transcriptionEngineLabel({
        ...drum,
        transcriptionEngine: "piano_highres",
      }),
    ).toContain("钢琴专用");
  });
  it("identifies deliberately skipped quiet tracks without calling them legacy output", () => {
    expect(
      transcriptionEngineLabel({
        ...drum,
        transcriptionEngine: null,
        analysis: {
          rmsDbfs: -90,
          peakDbfs: -60,
          relativeRmsDb: -50,
          lowSignal: true,
          autoTranscriptionSkipped: true,
        },
      }),
    ).toBe("近乎静音 · 已跳过自动转录");
  });
  it("opens drum editing only for completed transcription", () => {
    expect(canEditTrackNotes(drum)).toBe(true);
    expect(
      canEditTrackNotes({ ...drum, transcriptionStatus: "unsupported" }),
    ).toBe(false);
    expect(canEditTrackNotes({ ...drum, transcriptionStatus: "failed" })).toBe(
      false,
    );
    expect(canEditTrackNotes(null)).toBe(false);
  });
  it("changes every drum voice without touching detected event timing or mutating the draft", () => {
    const remapped = remapDrumVoice(drum, 42);
    expect(remapped).toEqual(
      drum.notes.map((note) => ({ ...note, pitch: 42 })),
    );
    expect(drum.notes.map((note) => note.pitch)).toEqual([49, 49]);
    expect(remapDrumVoice(drum, 60)).toBe(drum.notes);
    expect(remapDrumVoice({ ...drum, kind: "piano", isDrum: false }, 42)).toBe(
      drum.notes,
    );
  });
  it("uses GM names with an honest fallback for other existing drum notes", () => {
    expect(drumVoiceName(49)).toBe("吊镲 1");
    expect(drumVoiceName(36)).toBe("GM 鼓音 36");
  });
  it("undoes an entire drum voice change in one step while preserving source metadata", () => {
    const project: Project = {
      id: "drum-remap-test",
      title: "Test",
      status: "ready",
      bpm: 120,
      timeSignature: "4/4",
      durationSeconds: 5,
      revision: 1,
      latestJobId: null,
      sourceAudioUrl: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      tracks: [structuredClone(drum)],
      warnings: [],
    };
    useEditorStore.getState().loadProject(project, true);
    useEditorStore
      .getState()
      .patchTrack(drum.id, { notes: remapDrumVoice(drum, 51) });
    expect(useEditorStore.getState().past).toHaveLength(1);
    expect(
      useEditorStore
        .getState()
        .project!.tracks[0]!.notes.map((note) => note.pitch),
    ).toEqual([51, 51]);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project!.tracks[0]).toEqual(drum);
    expect(useEditorStore.getState().dirty).toBe(false);
  });
});
