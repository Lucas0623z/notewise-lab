import type { Track } from "../types";

export const CYMBAL_VOICES = [
  { pitch: 42, name: "闭合踩镲", short: "闭镲" },
  { pitch: 46, name: "开放踩镲", short: "开镲" },
  { pitch: 49, name: "吊镲 1", short: "吊镲" },
  { pitch: 51, name: "叮叮镲", short: "叮镲" },
] as const;

export const isDrumTrack = (track: Track | null | undefined) =>
  !!track && (track.isDrum || track.kind === "drums");

export function drumVoiceName(pitch: number): string {
  return (
    CYMBAL_VOICES.find((voice) => voice.pitch === pitch)?.name ??
    `GM 鼓音 ${pitch}`
  );
}

export function drumRowLabel(pitch: number): string {
  const voice = CYMBAL_VOICES.find((item) => item.pitch === pitch);
  return voice ? `${pitch} ${voice.short}` : `GM ${pitch}`;
}

export function canEditTrackNotes(track: Track | null | undefined): boolean {
  return (
    !!track &&
    (!isDrumTrack(track) || track.transcriptionStatus === "completed")
  );
}

export function transcriptionEngineLabel(track: Track): string {
  if (track.analysis?.autoTranscriptionSkipped)
    return "近乎静音 · 已跳过自动转录";
  switch (track.transcriptionEngine) {
    case "basic_pitch":
      return "Basic Pitch · 通用音符初稿";
    case "piano_highres":
      return "钢琴专用识别 · 高分辨率";
    case "cymbal_onsets":
      return "镲片击打点检测 · 非鼓组分类";
    default:
      return "旧工程未记录识别引擎";
  }
}

/** Only changes the requested drum voice; no timing, velocity or provenance edits. */
export function remapDrumVoice(track: Track, pitch: number) {
  if (
    !isDrumTrack(track) ||
    !CYMBAL_VOICES.some((voice) => voice.pitch === pitch)
  )
    return track.notes;
  return track.notes.map((note) => ({ ...note, pitch }));
}
