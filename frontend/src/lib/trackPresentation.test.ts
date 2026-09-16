import { describe, expect, it } from "vitest";
import type { Track } from "../types";
import {
  arrangementLayer,
  lowSignalLabel,
  mixSilenceReason,
  soloFeedback,
} from "./trackPresentation";

function track(patch: Partial<Track> = {}): Track {
  return {
    id: "voice",
    name: "人声",
    kind: "vocal",
    program: 53,
    isDrum: false,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    audioUrl: "/api/v1/audio.wav",
    transcriptionStatus: "completed",
    warnings: [],
    notes: [
      {
        id: "n1",
        pitch: 60,
        startSeconds: 0,
        durationSeconds: 1,
        velocity: 90,
      },
    ],
    ...patch,
  };
}

const lowSignal = {
  rmsDbfs: -70,
  peakDbfs: -60,
  relativeRmsDb: -50,
  lowSignal: true,
  autoTranscriptionSkipped: true,
};

describe("honest stem presentation", () => {
  it("shows the selected playback content instead of stacking notes over an audio waveform", () => {
    expect(arrangementLayer(track(), "audio")).toBe("waveform");
    expect(arrangementLayer(track(), "midi")).toBe("notes");
    expect(arrangementLayer(track({ audioUrl: null }), "audio")).toBe("empty");
    expect(arrangementLayer(track({ notes: [] }), "midi")).toBe("empty");
  });

  it("does not guess low signal on old projects from zero notes or a missing file", () => {
    expect(lowSignalLabel(track({ notes: [], audioUrl: null }))).toBeNull();
    expect(lowSignalLabel(track({ analysis: null }))).toBeNull();
    expect(
      lowSignalLabel(track({ analysis: { ...lowSignal, lowSignal: false } })),
    ).toBeNull();
  });

  it("marks measured quiet audio while retaining edited MIDI notes", () => {
    const value = track({ analysis: lowSignal });
    expect(lowSignalLabel(value)).toBe("近乎静音 · 已跳过自动识别");
    expect(arrangementLayer(value, "audio")).toBe("waveform");
    expect(arrangementLayer(value, "midi")).toBe("notes");
    expect(value.notes).toHaveLength(1);
    expect(
      lowSignalLabel(
        track({ analysis: { ...lowSignal, autoTranscriptionSkipped: false } }),
      ),
    ).toBe("近乎静音 · 原音频保留");
  });

  it("explains mute taking priority over solo and other tracks being silenced", () => {
    const solo = track({ solo: true, muted: true });
    const other = track({ id: "other", kind: "other" });
    expect(mixSilenceReason(solo, [solo, other])).toBe("已静音");
    expect(mixSilenceReason(other, [solo, other])).toBe("其他轨独奏，暂时静音");
    expect(soloFeedback([solo, other], "audio")?.warning).toContain("不会发声");
    expect(soloFeedback([other], "audio")).toBeNull();
  });

  it("warns about quiet audio only with measured evidence, not because the source is named vocal", () => {
    expect(soloFeedback([track({ solo: true })], "audio")?.warning).toBeNull();
    expect(
      soloFeedback([track({ solo: true, analysis: lowSignal })], "audio")
        ?.warning,
    ).toContain("近乎静音");
    expect(
      soloFeedback([track({ solo: true, analysis: lowSignal })], "midi")
        ?.warning,
    ).toBeNull();
  });

  it("does not call a solo group silent when another selected track has audible content", () => {
    const quiet = track({ solo: true, analysis: lowSignal });
    const piano = track({
      id: "piano",
      name: "钢琴",
      kind: "piano",
      solo: true,
    });
    expect(soloFeedback([quiet, piano], "audio")).toEqual({
      names: "人声、钢琴",
      warning: null,
    });
    expect(
      soloFeedback(
        [track({ solo: true, notes: [], kind: "drums", isDrum: true })],
        "midi",
      )?.warning,
    ).toContain("没有可试听的音符或鼓点");
  });
  it("allows completed drum MIDI to solo and still warns for legacy unsupported tracks", () => {
    const drum = track({ solo: true, kind: "drums", isDrum: true });
    expect(soloFeedback([drum], "midi")?.warning).toBeNull();
    expect(
      soloFeedback([{ ...drum, transcriptionStatus: "unsupported" }], "midi")
        ?.warning,
    ).toContain("没有可试听");
  });
});
