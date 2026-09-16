import type { Note } from "../types";

export type Snap = "off" | "1/4" | "1/8" | "1/16";

/** Minutes and seconds for timeline labels; invalid/negative values display zero. */
export function formatTime(seconds: number): string {
  const whole = Math.floor(Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Scientific pitch notation, with MIDI 60 = C4. */
export function pitchName(midi: number): string {
  const pitch = Math.max(
    0,
    Math.min(127, Math.round(Number.isFinite(midi) ? midi : 0)),
  );
  const names = [
    "C",
    "C♯",
    "D",
    "D♯",
    "E",
    "F",
    "F♯",
    "G",
    "G♯",
    "A",
    "A♯",
    "B",
  ];
  return `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** BPM describes quarter notes. Snapping never returns a negative timeline position. */
export function snapSeconds(seconds: number, bpm: number, snap: Snap): number {
  const position = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (snap === "off" || !Number.isFinite(bpm) || bpm <= 0) return position;
  const beatFraction = snap === "1/4" ? 1 : snap === "1/8" ? 0.5 : 0.25;
  const step = (60 / bpm) * beatFraction;
  return Math.max(0, Math.round(position / step) * step);
}

/**
 * Matches backend MIDI export: union strictly overlapping notes of one pitch,
 * retain the first note's ID, and use the largest velocity. Touching notes remain
 * distinct. Returns new objects and never changes the editable source notes.
 */
export function mergeOverlappingNotes(notes: readonly Note[]): Note[] {
  const ordered = notes
    .map((note) => ({ ...note }))
    .sort((a, b) => a.pitch - b.pitch || a.startSeconds - b.startSeconds);
  const merged: Note[] = [];
  for (const note of ordered) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.pitch === note.pitch &&
      note.startSeconds < previous.startSeconds + previous.durationSeconds
    ) {
      const end = Math.max(
        previous.startSeconds + previous.durationSeconds,
        note.startSeconds + note.durationSeconds,
      );
      previous.durationSeconds = end - previous.startSeconds;
      previous.velocity = Math.max(previous.velocity, note.velocity);
    } else {
      merged.push(note);
    }
  }
  return merged;
}

/** Preserve each percussion attack; trim overlapping trigger lengths only. */
export function drumTriggerNotes(notes: readonly Note[]): Note[] {
  const ordered = notes
    .map((note) => ({ ...note }))
    .sort((a, b) => a.pitch - b.pitch || a.startSeconds - b.startSeconds);
  for (let i = 0; i + 1 < ordered.length; i++) {
    const next = ordered[i + 1],
      current = ordered[i];
    if (
      current.pitch === next.pitch &&
      next.startSeconds > current.startSeconds
    ) {
      current.durationSeconds = Math.min(
        current.durationSeconds,
        next.startSeconds - current.startSeconds,
      );
    }
  }
  return ordered;
}
