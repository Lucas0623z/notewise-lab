import { Midi } from "@tonejs/midi";
import { describe, expect, it } from "vitest";
import type { Project, Track } from "../types";
import { projectMidi } from "./exportMidi";

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    name: id,
    kind: "piano",
    program: 0,
    isDrum: false,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    audioUrl: null,
    transcriptionStatus: "completed",
    warnings: [],
    notes: [
      {
        id: `${id}-note`,
        pitch: 60,
        startSeconds: 1.125,
        durationSeconds: 0.625,
        velocity: 96,
      },
    ],
    ...overrides,
  };
}

function project(tracks: Track[], bpm = 120): Project {
  return {
    id: "midi-export-test",
    title: "Export test",
    status: "ready",
    bpm,
    timeSignature: "4/4",
    durationSeconds: 10,
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sourceAudioUrl: null,
    latestJobId: null,
    tracks,
    warnings: [],
  };
}

describe("local MIDI export round trip", () => {
  it("preserves note seconds when BPM changes, while the MIDI tick positions change", () => {
    const slow = new Midi(projectMidi(project([track("piano")], 60)));
    const fast = new Midi(projectMidi(project([track("piano")], 180)));
    expect(slow.header.ppq).toBe(480);
    expect(slow.header.timeSignatures[0].timeSignature).toEqual([4, 4]);
    expect(slow.tracks[0].notes[0].time).toBeCloseTo(1.125, 3);
    expect(fast.tracks[0].notes[0].time).toBeCloseTo(1.125, 3);
    expect(slow.tracks[0].notes[0].duration).toBeCloseTo(0.625, 3);
    expect(fast.tracks[0].notes[0].duration).toBeCloseTo(0.625, 3);
    expect(fast.tracks[0].notes[0].ticks).toBe(
      slow.tracks[0].notes[0].ticks * 3,
    );
    expect(fast.tracks[0].notes[0].midi).toBe(60);
    expect(Math.round(fast.tracks[0].notes[0].velocity * 127)).toBe(96);
  });

  it("reserves channel 9 for drums even with more than nine melodic tracks", () => {
    const melodic = Array.from({ length: 12 }, (_, index) =>
      track(`melody-${index}`, { program: index }),
    );
    const source = [
      ...melodic.slice(0, 3),
      track("drums", { kind: "drums", isDrum: true }),
      ...melodic.slice(3),
    ];
    const decoded = new Midi(projectMidi(project(source)));
    expect(decoded.tracks.find((item) => item.name === "drums")?.channel).toBe(
      9,
    );
    const channels = decoded.tracks
      .filter((item) => item.name !== "drums")
      .map((item) => item.channel);
    expect(channels).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12]);
    expect(
      decoded.tracks.find((item) => item.name === "melody-11")?.instrument
        .number,
    ).toBe(11);
  });

  it("exports overlap unions with maximum velocity, without modifying the editable notes", () => {
    const source = project([
      track("piano", {
        notes: [
          {
            id: "a",
            pitch: 60,
            startSeconds: 0,
            durationSeconds: 1,
            velocity: 70,
          },
          {
            id: "b",
            pitch: 60,
            startSeconds: 0.5,
            durationSeconds: 1.5,
            velocity: 110,
          },
          {
            id: "c",
            pitch: 60,
            startSeconds: 2,
            durationSeconds: 0.5,
            velocity: 80,
          },
        ],
      }),
    ]);
    const before = structuredClone(source);
    const decoded = new Midi(projectMidi(source));
    expect(decoded.tracks[0].notes).toHaveLength(2);
    expect(decoded.tracks[0].notes[0].duration).toBeCloseTo(2, 5);
    expect(Math.round(decoded.tracks[0].notes[0].velocity * 127)).toBe(110);
    expect(decoded.tracks[0].notes[1].time).toBeCloseTo(2, 5);
    expect(source).toEqual(before);
  });

  it("carries mixer mute, solo, volume and pan into MIDI control changes", () => {
    const decoded = new Midi(
      projectMidi(
        project([
          track("solo", { solo: true, volume: 0.25, pan: -1 }),
          track("not-solo", { volume: 1, pan: 0 }),
          track("muted-solo", { solo: true, muted: true, volume: 1, pan: 1 }),
        ]),
      ),
    );
    expect(Math.round(decoded.tracks[0].controlChanges[7][0].value * 127)).toBe(
      32,
    );
    expect(Math.round(decoded.tracks[1].controlChanges[7][0].value * 127)).toBe(
      0,
    );
    expect(Math.round(decoded.tracks[2].controlChanges[7][0].value * 127)).toBe(
      0,
    );
    expect(
      decoded.tracks.map((item) =>
        Math.round(item.controlChanges[10][0].value * 127),
      ),
    ).toEqual([1, 64, 127]);
  });

  it("keeps very short notes alive for at least one MIDI tick", () => {
    const decoded = new Midi(
      projectMidi(
        project(
          [
            track("short", {
              notes: [
                {
                  id: "tiny",
                  pitch: 60,
                  startSeconds: 1,
                  durationSeconds: 0.00001,
                  velocity: 100,
                },
              ],
            }),
          ],
          20,
        ),
      ),
    );
    expect(decoded.tracks[0].notes[0].durationTicks).toBe(1);
  });

  it("writes Chinese project and track names as intact UTF-8 MIDI text", () => {
    const source = {
      ...project([track("piano", { name: "钢琴" })]),
      title: "我的作品",
    };
    const decoded = new Midi(projectMidi(source));
    const utf8 = (bytes: string) =>
      new TextDecoder().decode(
        Uint8Array.from(bytes, (character) => character.charCodeAt(0)),
      );
    expect(utf8(decoded.header.name)).toBe("我的作品");
    expect(utf8(decoded.tracks[0].name)).toBe("钢琴");
  });

  it("rejects excess melodic tracks instead of silently sharing instrument channels", () => {
    const fifteen = Array.from({ length: 15 }, (_, index) =>
      track(`track-${index}`),
    );
    const decoded = new Midi(projectMidi(project(fifteen)));
    expect(new Set(decoded.tracks.map((item) => item.channel)).size).toBe(15);
    expect(decoded.tracks.every((item) => item.channel !== 9)).toBe(true);
    expect(() => projectMidi(project([...fifteen, track("overflow")]))).toThrow(
      "15",
    );
  });
});

it("retains separate cymbal attacks on channel 10 even when trigger lengths overlap", () => {
  const drum = track("cymbal", {
    isDrum: true,
    kind: "drums",
    notes: [0.1, 0.15, 0.2].map((start, i) => ({
      id: String(i),
      pitch: 49,
      startSeconds: start,
      durationSeconds: 0.1,
      velocity: 96,
    })),
  });
  const original = structuredClone(drum);
  const decoded = new Midi(projectMidi(project([drum])));
  expect(decoded.tracks[0].channel).toBe(9);
  expect(decoded.tracks[0].notes).toHaveLength(3);
  decoded.tracks[0].notes.forEach((n, i) =>
    expect(n.time).toBeCloseTo([0.1, 0.15, 0.2][i], 3),
  );
  expect(drum).toEqual(original);
});
