import type { Track } from "../types";
import type { PlaybackMode } from "../audio/engine";

/** Unknown analysis on older projects must never be guessed from the note count. */
export function lowSignalLabel(track: Track): string | null {
  if (!track.analysis?.lowSignal) return null;
  return track.analysis.autoTranscriptionSkipped
    ? "近乎静音 · 已跳过自动识别"
    : "近乎静音 · 原音频保留";
}

export function mixSilenceReason(track: Track, tracks: Track[]): string | null {
  if (track.muted) return "已静音";
  if (track.volume <= 0) return "音量为 0";
  if (tracks.some((item) => item.solo) && !track.solo)
    return "其他轨独奏，暂时静音";
  return null;
}

export function arrangementLayer(track: Track, mode: PlaybackMode) {
  if (mode === "audio") return track.audioUrl ? "waveform" : "empty";
  return track.notes.length ? "notes" : "empty";
}

export function soloFeedback(tracks: Track[], mode: PlaybackMode) {
  const solo = tracks.filter((track) => track.solo);
  if (!solo.length) return null;
  const available = solo.filter((track) => !track.muted && track.volume > 0);
  let warning: string | null = null;
  if (!available.length) {
    warning = "独奏轨已静音或音量为 0，当前不会发声。";
  } else if (mode === "audio" && available.every((track) => !track.audioUrl)) {
    warning = "当前独奏轨没有音频文件。";
  } else if (
    mode === "audio" &&
    available.every((track) => !track.audioUrl || track.analysis?.lowSignal)
  ) {
    warning =
      "当前独奏轨的音频近乎静音，可能听不到声音；退出独奏可恢复其他音轨。";
  } else if (
    mode === "midi" &&
    available.every(
      (track) =>
        !track.notes.length ||
        ((track.isDrum || track.kind === "drums") &&
          track.transcriptionStatus !== "completed"),
    )
  ) {
    warning = "当前独奏轨没有可试听的音符或鼓点。";
  }
  return { names: solo.map((track) => track.name).join("、"), warning };
}
