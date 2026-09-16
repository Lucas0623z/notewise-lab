import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types";

const tone = vi.hoisted(() => ({
  clock: null as unknown,
  start: vi.fn<() => Promise<void>>(),
}));
vi.mock("tone", () => ({ getContext: () => tone.clock, start: tone.start }));

import { AudioEngine } from "./engine";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function param() {
  const audioParam = {
    value: 0,
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn((value: number) => {
      // Model the settled value of the short gain ramp. This lets routing tests
      // inspect the signal carried by each independently decoded stem.
      audioParam.value = value;
    }),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  return audioParam;
}

function node() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}
function source(kind: "buffer" | "oscillator") {
  return {
    ...node(),
    kind,
    buffer: null as unknown,
    loop: false,
    type: "",
    frequency: param(),
    onended: null as (() => void) | null,
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function fakeClock() {
  const sources: ReturnType<typeof source>[] = [];
  const gains: Array<
    ReturnType<typeof node> & { gain: ReturnType<typeof param> }
  > = [];
  const panners: Array<
    ReturnType<typeof node> & { pan: ReturnType<typeof param> }
  > = [];
  let timerId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    currentTime: 100,
    sampleRate: 44100,
    rawContext: { destination: {} },
    sources,
    gains,
    panners,
    callbacks,
    createGain: () => {
      const gain = { ...node(), gain: param() };
      gains.push(gain);
      return gain;
    },
    createStereoPanner: () => {
      const pan = { ...node(), pan: param() };
      panners.push(pan);
      return pan;
    },
    createDynamicsCompressor: () => ({
      ...node(),
      threshold: param(),
      knee: param(),
      ratio: param(),
      attack: param(),
      release: param(),
    }),
    createBufferSource: () => {
      const s = source("buffer");
      sources.push(s);
      return s;
    },
    createOscillator: () => {
      const s = source("oscillator");
      sources.push(s);
      return s;
    },
    createBuffer: (channels = 1, frames = 1, sampleRate = 44100) => {
      const data = Array.from(
        { length: channels },
        () => new Float32Array(frames),
      );
      return {
        duration: frames / sampleRate,
        getChannelData: (channel: number) => data[channel],
      };
    },
    decodeAudioData: vi.fn(async () => ({ duration: 12 })),
    setInterval: (callback: () => void) => {
      callbacks.set(++timerId, callback);
      return timerId;
    },
    clearInterval: (id: number) => callbacks.delete(id),
  };
}

function project(id = "project"): Project {
  return {
    id,
    title: "Test",
    status: "ready",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 12,
    revision: 1,
    createdAt: "",
    updatedAt: "",
    latestJobId: null,
    sourceAudioUrl: null,
    warnings: [],
    tracks: [
      {
        id: "piano",
        name: "Piano",
        kind: "piano",
        program: 0,
        isDrum: false,
        muted: false,
        solo: false,
        volume: 0.8,
        pan: 0,
        audioUrl: "/piano.wav",
        transcriptionStatus: "completed",
        warnings: [],
        notes: [
          {
            id: "note",
            pitch: 60,
            startSeconds: 0,
            durationSeconds: 12,
            velocity: 90,
          },
        ],
      },
    ],
  };
}

function response() {
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
}

function sampledBuffer(samples: number[]) {
  return { duration: 12, samples: new Float32Array(samples) };
}

/** Inspect each source's real connection target, before the master limiter. */
function settledStemSignal(audioClock: ReturnType<typeof fakeClock>) {
  const active = audioClock.sources.filter(
    (s) => s.kind === "buffer" && !s.loop && !s.stop.mock.calls.length,
  );
  const result = new Array<number>(4).fill(0);
  for (const stem of active) {
    const samples = (stem.buffer as ReturnType<typeof sampledBuffer>).samples;
    const bus = stem.connect.mock.calls[0][0] as {
      gain: ReturnType<typeof param>;
    };
    for (let i = 0; i < samples.length; i++) {
      result[i] += samples[i] * bus.gain.value;
    }
  }
  return result;
}

let clock: ReturnType<typeof fakeClock>;
let engine: AudioEngine;

beforeEach(() => {
  clock = fakeClock();
  tone.clock = clock;
  tone.start.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
  engine = new AudioEngine();
});

afterEach(() => {
  engine.dispose();
  vi.unstubAllGlobals();
});

describe("shared audio clock", () => {
  it("waits for every stem to decode, then starts all with one timestamp and offset", async () => {
    const second = deferred<{ duration: number }>();
    const p = project();
    p.tracks.push({ ...p.tracks[0], id: "bass", audioUrl: "/bass.wav" });
    clock.decodeAudioData
      .mockResolvedValueOnce({ duration: 12 })
      .mockReturnValueOnce(second.promise);
    const pending = engine.play(p, "audio", 3);
    await vi.waitFor(() =>
      expect(clock.decodeAudioData).toHaveBeenCalledTimes(2),
    );
    expect(clock.sources).toHaveLength(0);
    second.resolve({ duration: 10 });
    await pending;
    const stems = clock.sources.filter((s) => !s.loop);
    expect(stems).toHaveLength(2);
    expect(stems[0].start).toHaveBeenCalledWith(100.06, 3);
    expect(stems[1].start).toHaveBeenCalledWith(100.06, 3);
    clock.currentTime = 103.56;
    expect(engine.pause()).toBeCloseTo(6.5);
    expect(stems.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
  });

  it("keeps the end cursor on natural completion; explicit stop rewinds it", async () => {
    const events: Array<{ playing: boolean; position: number }> = [];
    engine.subscribe(() =>
      events.push({ playing: engine.isPlaying(), position: engine.position() }),
    );
    await engine.play(project(), "midi", 2);
    const marker = clock.sources.find((s) => s.loop)!;
    expect(marker.stop).toHaveBeenCalledWith(110.06);
    clock.currentTime = 110.06;
    marker.onended!();
    expect(engine.isPlaying()).toBe(false);
    expect(engine.position()).toBe(12);
    expect(events.at(-1)).toEqual({ playing: false, position: 12 });
    expect(clock.callbacks.size).toBe(0);
    engine.stop();
    expect(engine.position()).toBe(0);
  });

  it("keeps live volume and pan after restarting at a seek position", async () => {
    const p = project();
    await engine.play(p, "midi");
    engine.updateMix([{ ...p.tracks[0], volume: 0.2, pan: -0.6 }]);
    await engine.seek(5);
    // The second-to-last gain is the track bus (last is the note envelope).
    expect(clock.gains.at(-2)!.gain.setTargetAtTime).toHaveBeenLastCalledWith(
      0.2,
      100,
      0.008,
    );
    expect(clock.panners.at(-1)!.pan.setTargetAtTime).toHaveBeenLastCalledWith(
      -0.6,
      100,
      0.008,
    );
    expect(engine.position()).toBe(5);
  });
});

describe("playback cancellation and mode changes", () => {
  it("does not resurrect an older audio request after switching to MIDI", async () => {
    const oldFetch = deferred<ReturnType<typeof response>>();
    vi.mocked(fetch).mockImplementationOnce(
      () => oldFetch.promise as Promise<Response>,
    );
    const oldPlay = engine.play(project(), "audio");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await engine.play(project(), "midi", 4);
    const activeSources = [...clock.sources];
    oldFetch.resolve(response());
    await oldPlay;
    expect(engine.isPlaying()).toBe(true);
    expect(engine.position()).toBe(4);
    expect(clock.sources).toEqual(activeSources);
    expect(activeSources.some((s) => s.kind === "oscillator")).toBe(true);
    expect(activeSources.filter((s) => s.kind === "buffer")).toHaveLength(1); // Silent end marker only.
  });

  it("cancels an in-flight decode without starting a source or losing the chosen cursor", async () => {
    const decoding = deferred<{ duration: number }>();
    clock.decodeAudioData.mockReturnValueOnce(decoding.promise);
    const pending = engine.play(project(), "audio", 6);
    await vi.waitFor(() =>
      expect(clock.decodeAudioData).toHaveBeenCalledOnce(),
    );
    expect(engine.pause()).toBe(6);
    decoding.resolve({ duration: 12 });
    await pending;
    expect(engine.isPlaying()).toBe(false);
    expect(clock.sources).toHaveLength(0);
  });

  it("uses the new project duration for seeks made while the audio context resumes", async () => {
    const ready = deferred<void>();
    tone.start.mockReturnValueOnce(ready.promise);
    const pending = engine.play(project(), "midi");
    await engine.seek(8);
    ready.resolve();
    await pending;
    expect(engine.isPlaying()).toBe(true);
    expect(engine.position()).toBe(8);
  });

  it("releases the previous MIDI sources before beginning audio playback", async () => {
    await engine.play(project(), "midi");
    const midi = [...clock.sources];
    await engine.play(project(), "audio");
    expect(
      midi.every(
        (s) =>
          s.stop.mock.calls.length > 0 && s.disconnect.mock.calls.length > 0,
      ),
    ).toBe(true);
    expect(clock.callbacks.size).toBe(0);
    expect(
      clock.sources.slice(midi.length).every((s) => s.kind === "buffer"),
    ).toBe(true);
  });

  it("rejects missing audio and unsupported drum MIDI without inventing sound", async () => {
    const p = project();
    p.tracks[0].audioUrl = null;
    await expect(engine.play(p, "audio")).rejects.toThrow(
      "没有可试听的分轨音频",
    );
    p.tracks[0].isDrum = true;
    p.tracks[0].kind = "drums";
    p.tracks[0].transcriptionStatus = "unsupported";
    await expect(engine.play(p, "midi")).rejects.toThrow(
      "还没有可试听的音符或鼓点",
    );
    expect(engine.isPlaying()).toBe(false);
    expect(clock.sources).toHaveLength(0);
  });
});

describe("stem routing, mute/solo, and buffer identity", () => {
  function mixProject() {
    const p = project();
    const base = { ...p.tracks[0], volume: 1 };
    p.tracks = [
      { ...base, id: "other", kind: "other", audioUrl: "/other.wav" },
      {
        ...base,
        id: "drums",
        kind: "drums",
        isDrum: true,
        audioUrl: "/drums.wav",
      },
      { ...base, id: "vocal", kind: "vocal", audioUrl: "/vocal.wav" },
    ];
    return p;
  }

  function loadDistinctStems() {
    const other = sampledBuffer([0.5, 0, -0.5, 0]);
    const drums = sampledBuffer([0, 0.25, 0, -0.25]);
    const vocal = sampledBuffer([0, 0, 0, 0]);
    clock.decodeAudioData
      .mockResolvedValueOnce(other)
      .mockResolvedValueOnce(drums)
      .mockResolvedValueOnce(vocal);
    return { other, drums, vocal };
  }

  it("routes distinct WAV buffers to the matching track buses and preserves a silent stem", async () => {
    const buffers = loadDistinctStems();
    await engine.play(mixProject(), "audio");
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      "/other.wav",
      "/drums.wav",
      "/vocal.wav",
    ]);
    expect(clock.sources.filter((s) => !s.loop).map((s) => s.buffer)).toEqual([
      buffers.other,
      buffers.drums,
      buffers.vocal,
    ]);
    expect(settledStemSignal(clock)).toEqual([0.5, 0.25, -0.5, -0.25]);
  });

  it("solo selects only the requested non-silent stem; soloing zero audio correctly produces silence", async () => {
    const p = mixProject();
    loadDistinctStems();
    await engine.play(p, "audio");
    const sourceCount = clock.sources.length;
    engine.updateMix(
      p.tracks.map((track) => ({ ...track, solo: track.id === "drums" })),
    );
    expect(settledStemSignal(clock)).toEqual([0, 0.25, 0, -0.25]);
    engine.updateMix(
      p.tracks.map((track) => ({ ...track, solo: track.id === "other" })),
    );
    expect(settledStemSignal(clock)).toEqual([0.5, 0, -0.5, 0]);
    engine.updateMix(
      p.tracks.map((track) => ({ ...track, solo: track.id === "vocal" })),
    );
    expect(settledStemSignal(clock)).toEqual([0, 0, 0, 0]);
    expect(clock.sources).toHaveLength(sourceCount);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("mute wins over solo, multiple solos combine, and releasing solo restores the mix", async () => {
    const p = mixProject();
    loadDistinctStems();
    await engine.play(p, "audio");
    engine.updateMix(
      p.tracks.map((track) => ({ ...track, solo: track.id !== "vocal" })),
    );
    expect(settledStemSignal(clock)).toEqual([0.5, 0.25, -0.5, -0.25]);
    engine.updateMix(
      p.tracks.map((track) => ({
        ...track,
        solo: track.id === "other",
        muted: track.id === "other",
      })),
    );
    expect(settledStemSignal(clock)).toEqual([0, 0, 0, 0]);
    engine.updateMix(
      p.tracks.map((track) => ({ ...track, muted: track.id === "other" })),
    );
    expect(settledStemSignal(clock)).toEqual([0, 0.25, 0, -0.25]);
    engine.updateMix(p.tracks);
    expect(settledStemSignal(clock)).toEqual([0.5, 0.25, -0.5, -0.25]);
  });

  it("preserves updated solo state through seek without swapping cached audio URLs", async () => {
    const p = mixProject();
    const buffers = loadDistinctStems();
    await engine.play(p, "audio");
    engine.updateMix(
      p.tracks.map((track) => ({ ...track, solo: track.id === "drums" })),
    );
    await engine.seek(2);
    const active = clock.sources.filter(
      (s) => !s.loop && !s.stop.mock.calls.length,
    );
    expect(active.map((s) => s.buffer)).toEqual([
      buffers.other,
      buffers.drums,
      buffers.vocal,
    ]);
    expect(active.every((s) => s.start.mock.calls[0][1] === 2)).toBe(true);
    expect(settledStemSignal(clock)).toEqual([0, 0.25, 0, -0.25]);
    expect(clock.decodeAudioData).toHaveBeenCalledTimes(3);
  });

  it("decodes a changed track URL in the same project and clears buffers when switching projects", async () => {
    const p = project();
    const first = sampledBuffer([0.5, 0, -0.5, 0]);
    const replacement = sampledBuffer([0, 0.25, 0, -0.25]);
    const anotherProject = sampledBuffer([0, 0, 0, 0]);
    clock.decodeAudioData
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(anotherProject);
    await engine.play(p, "audio");
    await engine.play(
      { ...p, tracks: [{ ...p.tracks[0], audioUrl: "/new-piano.wav" }] },
      "audio",
    );
    expect(clock.sources.filter((s) => !s.loop).at(-1)!.buffer).toBe(
      replacement,
    );
    await engine.play({ ...p, id: "different-project" }, "audio");
    expect(clock.sources.filter((s) => !s.loop).at(-1)!.buffer).toBe(
      anotherProject,
    );
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      "/piano.wav",
      "/new-piano.wav",
      "/piano.wav",
    ]);
  });
});

describe("explicit percussion MIDI preview", () => {
  it("plays real completed drum events as nonzero noise without merging adjacent hits", async () => {
    const p = project();
    p.tracks = [
      {
        ...p.tracks[0],
        id: "cymbal",
        kind: "drums",
        isDrum: true,
        transcriptionEngine: "cymbal_onsets",
        audioUrl: null,
        notes: [0, 0.05].map((start, i) => ({
          id: `hit-${i}`,
          pitch: 49,
          startSeconds: start,
          durationSeconds: 0.1,
          velocity: 100,
        })),
      },
    ];
    await engine.play(p, "midi");
    const hits = clock.sources.filter((s) => s.kind === "buffer" && !s.loop);
    expect(hits).toHaveLength(2);
    expect(clock.sources.filter((s) => s.kind === "oscillator")).toHaveLength(
      0,
    );
    expect(
      hits[1].start.mock.calls[0][0] - hits[0].start.mock.calls[0][0],
    ).toBeCloseTo(0.05);
    const samples = (hits[0].buffer as AudioBuffer).getChannelData(0);
    expect(samples.some((v) => Math.abs(v) > 0.01)).toBe(true);
    engine.pause();
    expect(hits.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
  });

  it("does not restrike a past cymbal when seeking into its trigger", async () => {
    const p = project();
    p.tracks[0] = {
      ...p.tracks[0],
      kind: "drums",
      isDrum: true,
      notes: [
        {
          id: "past",
          pitch: 49,
          startSeconds: 0,
          durationSeconds: 0.1,
          velocity: 90,
        },
        {
          id: "next",
          pitch: 42,
          startSeconds: 0.2,
          durationSeconds: 0.1,
          velocity: 90,
        },
      ],
    };
    await engine.play(p, "midi", 0.04);
    expect(
      clock.sources.filter((s) => s.kind === "buffer" && !s.loop),
    ).toHaveLength(1);
  });
});
