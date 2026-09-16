import { describe, expect, it } from "vitest";
import type { Note } from "../types";
import {
  formatTime,
  mergeOverlappingNotes,
  pitchName,
  snapSeconds,
} from "./music";

const note = (
  id: string,
  pitch: number,
  startSeconds: number,
  durationSeconds: number,
  velocity = 80,
): Note => ({ id, pitch, startSeconds, durationSeconds, velocity });

describe("timeline display and snapping", () => {
  it("uses quarter-note BPM consistently across supported subdivisions", () => {
    expect(snapSeconds(0.38, 120, "1/4")).toBe(0.5);
    expect(snapSeconds(0.38, 120, "1/8")).toBe(0.5);
    expect(snapSeconds(0.38, 120, "1/16")).toBe(0.375);
    expect(snapSeconds(0.38, 120, "off")).toBe(0.38);
    expect(snapSeconds(-2, 120, "1/8")).toBe(0);
    expect(snapSeconds(0.3, 0, "1/8")).toBe(0.3);
    expect(snapSeconds(Number.NaN, 120, "1/8")).toBe(0);
  });

  it("formats timeline times and standard MIDI octaves at the boundaries", () => {
    expect(formatTime(125.9)).toBe("2:05");
    expect(formatTime(-1)).toBe("0:00");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(pitchName(0)).toBe("C-1");
    expect(pitchName(60)).toBe("C4");
    expect(pitchName(61)).toBe("C♯4");
    expect(pitchName(127)).toBe("G9");
  });
});

describe("mergeOverlappingNotes", () => {
  it("matches backend overlap unions, maximum velocity, pitch ordering and first ID", () => {
    const notes = [
      note("middle", 60, 1, 1.5, 100),
      note("other-pitch", 64, 0, 5, 70),
      note("earliest", 60, 0, 1.5, 80),
      note("nested", 60, 0.3, 0.1, 110),
      note("touching", 60, 2.5, 0.5, 90),
    ];
    const before = structuredClone(notes);
    expect(mergeOverlappingNotes(notes)).toEqual([
      note("earliest", 60, 0, 2.5, 110),
      note("touching", 60, 2.5, 0.5, 90),
      note("other-pitch", 64, 0, 5, 70),
    ]);
    expect(notes).toEqual(before);
  });

  it("does not merge separate pitches or repeated notes touching at their endpoints", () => {
    const source = [
      note("a", 60, 0, 1),
      note("b", 60, 1, 1),
      note("c", 61, 0, 2),
    ];
    const merged = mergeOverlappingNotes(source);
    expect(merged).toEqual(source);
    expect(merged[0]).not.toBe(source[0]);
    expect(mergeOverlappingNotes([])).toEqual([]);
  });
});
