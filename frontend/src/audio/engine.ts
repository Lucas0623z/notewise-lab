import * as Tone from "tone";
import type { Note, Project, Track } from "../types";
import { drumTriggerNotes, mergeOverlappingNotes } from "../lib/music";

export type PlaybackMode = "audio" | "midi";

type Clock = ReturnType<typeof Tone.getContext>;
type Gain = ReturnType<Clock["createGain"]>;
type Panner = ReturnType<Clock["createStereoPanner"]>;
type Source =
  | ReturnType<Clock["createBufferSource"]>
  | ReturnType<Clock["createOscillator"]>;
type Mix = Pick<Track, "volume" | "pan" | "muted" | "solo">;
type Bus = { gain: Gain; pan: Panner };
type ScheduledNote = {
  trackId: string;
  note: Note;
  end: number;
  isDrum: boolean;
};

const bounded = (value: number, min: number, max: number, fallback = min) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/**
 * One Tone/Web Audio clock drives every stem and every synthesized note.
 * MIDI playback is a simple oscillator preview, not sampled instrument audio.
 * No HTMLAudioElement is used for playback. WaveSurfer is visual-only.
 */
export class AudioEngine {
  private clock: Clock | null = null;
  private project: Project | null = null;
  private mode: PlaybackMode = "audio";
  private playing = false;
  private offset = 0;
  private startedAt = 0;
  private duration = 0;
  private generation = 0;
  private request: AbortController | null = null;
  private timer: number | null = null;
  private buses = new Map<string, Bus>();
  private mix = new Map<string, Mix>();
  private sources = new Set<Source>();
  private envelopes = new Set<Gain>();
  private master: Gain | null = null;
  private limiter: ReturnType<Clock["createDynamicsCompressor"]> | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private drumBuffers = new Map<number, AudioBuffer>();
  private bufferProjectId: string | null = null;
  private listeners = new Set<() => void>();
  private notes: ScheduledNote[] = [];
  private nextNote = 0;

  /** Call directly from a click/keypress handler to satisfy autoplay rules. */
  async play(
    project: Project,
    mode: PlaybackMode,
    offsetSeconds = 0,
  ): Promise<void> {
    this.pause();
    const session = ++this.generation;
    this.project = project;
    this.mode = mode;
    this.mix = new Map(
      project.tracks.map((track) => [track.id, this.trackMix(track)]),
    );
    this.offset = Math.max(
      0,
      Number.isFinite(offsetSeconds) ? offsetSeconds : 0,
    );
    // A seek can arrive while Tone.start() or audio decoding is still pending.
    // Never clamp it using the previous project's duration.
    this.duration = Math.max(
      0,
      Number.isFinite(project.durationSeconds) ? project.durationSeconds : 0,
    );
    if (mode === "midi") {
      for (const track of project.tracks) {
        for (const note of track.notes) {
          const end = note.startSeconds + note.durationSeconds;
          if (Number.isFinite(end))
            this.duration = Math.max(this.duration, end);
        }
      }
    }

    if (this.bufferProjectId !== project.id) {
      this.buffers.clear();
      this.bufferProjectId = project.id;
    }

    // Start before the first await: this method must retain the user gesture.
    const ready = Tone.start();
    this.clock = Tone.getContext();
    const request = new AbortController();
    this.request = request;

    try {
      await ready;
      if (session !== this.generation) return;

      const audioTracks = project.tracks.filter((track) =>
        Boolean(track.audioUrl),
      );
      const loaded: Array<{ track: Track; buffer: AudioBuffer }> = [];
      this.notes = [];
      this.nextNote = 0;

      if (mode === "audio") {
        if (!audioTracks.length) {
          throw new Error(
            "这个工程没有可试听的分轨音频。请先上传并处理音频，或切换到 MIDI 合成试听。",
          );
        }
        // Decode sequentially to avoid fetching all large WAV files at once.
        // Every source is started only after all buffers are ready.
        for (const track of audioTracks) {
          const buffer = await this.loadBuffer(track.audioUrl!, request.signal);
          if (session !== this.generation) return;
          loaded.push({ track, buffer });
          this.duration = Math.max(this.duration, buffer.duration);
        }
      } else {
        this.notes = project.tracks
          .flatMap((track) => {
            const isDrum = track.isDrum || track.kind === "drums";
            if (isDrum && track.transcriptionStatus !== "completed") return [];
            const valid = track.notes.filter(
              (note) =>
                Number.isFinite(note.pitch) &&
                note.pitch >= 0 &&
                note.pitch <= 127 &&
                Number.isFinite(note.startSeconds) &&
                note.startSeconds >= 0 &&
                Number.isFinite(note.durationSeconds) &&
                note.durationSeconds > 0 &&
                Number.isFinite(note.velocity) &&
                note.velocity > 0,
            );
            return (
              isDrum ? drumTriggerNotes(valid) : mergeOverlappingNotes(valid)
            ).map((note) => ({
              trackId: track.id,
              note,
              end: note.startSeconds + note.durationSeconds,
              isDrum,
            }));
          })
          .sort((a, b) => a.note.startSeconds - b.note.startSeconds);
        if (!this.notes.length) {
          throw new Error(
            "这个工程还没有可试听的音符或鼓点。请完成转录或添加音符。",
          );
        }
        for (const event of this.notes)
          this.duration = Math.max(this.duration, event.end);
      }

      if (session !== this.generation) return;
      this.request = null;
      this.offset = bounded(this.offset, 0, this.duration);
      if (this.duration <= 0 || this.offset >= this.duration) {
        this.emit();
        return;
      }

      const clock = this.clock;
      this.createMixer(project.tracks);
      this.startedAt = clock.currentTime + 0.06;
      this.playing = true;

      if (mode === "audio") {
        for (const { track, buffer } of loaded) {
          if (this.offset >= buffer.duration) continue;
          const source = clock.createBufferSource();
          source.buffer = buffer;
          source.connect(this.buses.get(track.id)!.gain);
          this.sources.add(source);
          source.onended = () => {
            this.sources.delete(source);
            source.disconnect();
          };
          // All stems share this exact start timestamp and source offset.
          source.start(this.startedAt, this.offset);
        }
      } else {
        this.notes = this.notes.filter((event) => event.end > this.offset);
        this.scheduleNotes();
        // Tone's context ticker uses the audio clock and a worker; audio is
        // scheduled ahead, not timed by React renders or individual play calls.
        this.timer = clock.setInterval(() => this.scheduleNotes(), 0.05);
      }

      // A silent source provides an audio-clock end event, including silent tails.
      // It is not a wall-clock timeout, so context suspension cannot desync it.
      const marker = clock.createBufferSource();
      marker.buffer = clock.createBuffer(1, 1, clock.sampleRate);
      marker.loop = true;
      marker.connect(this.master!);
      this.sources.add(marker);
      marker.onended = () => {
        if (session !== this.generation || !this.playing) return;
        this.offset = this.duration;
        this.playing = false;
        ++this.generation;
        this.releaseNodes();
        this.emit();
      };
      marker.start(this.startedAt);
      marker.stop(this.startedAt + this.duration - this.offset);
      this.emit();
    } catch (error) {
      if (session !== this.generation) return;
      ++this.generation;
      this.playing = false;
      this.request?.abort();
      this.request = null;
      this.releaseNodes();
      this.emit();
      throw error instanceof Error
        ? error
        : new Error("试听启动失败，请重新尝试。");
    }
  }

  /** Retains the precise playhead and cancels an in-flight audio download. */
  pause = (): number => {
    this.offset = this.position();
    this.playing = false;
    ++this.generation;
    this.request?.abort();
    this.request = null;
    this.releaseNodes();
    this.emit();
    return this.offset;
  };

  stop = (): void => {
    this.pause();
    this.offset = 0;
    this.emit();
  };

  /** Seeks the last project snapshot. Pass a fresh project to play after edits. */
  async seek(seconds: number): Promise<void> {
    const target = bounded(seconds, 0, this.project ? this.duration : Infinity);
    if ((this.playing || this.request) && this.project) {
      await this.play(this.project, this.mode, target);
    } else {
      this.offset = target;
      this.emit();
    }
  }

  position = (): number => {
    if (!this.playing || !this.clock) return this.offset;
    return bounded(
      this.offset + Math.max(0, this.clock.currentTime - this.startedAt),
      0,
      this.duration,
    );
  };

  isPlaying = (): boolean => this.playing;

  /** State notifications only. Use requestAnimationFrame + position() for a cursor. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Applies live gain/pan/mute/solo without restarting any source. */
  updateMix = (tracks: Track[]): void => {
    this.mix = new Map(tracks.map((track) => [track.id, this.trackMix(track)]));
    // seek() restarts the saved snapshot. Keep its mixer settings fresh while
    // retaining its note snapshot: editing notes needs a fresh play(project).
    if (this.project) {
      this.project = {
        ...this.project,
        tracks: this.project.tracks.map((track) => ({
          ...track,
          ...this.mix.get(track.id),
        })),
      };
    }
    this.applyMix();
  };

  dispose = (): void => {
    this.stop();
    this.buffers.clear();
    this.bufferProjectId = null;
    this.project = null;
    this.mix.clear();
    this.listeners.clear();
    // Do not close Tone's shared context: route remounts and other components
    // can keep using it. All nodes owned by this engine have been released.
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private trackMix(track: Track): Mix {
    return {
      volume: track.volume,
      pan: track.pan,
      muted: track.muted,
      solo: track.solo,
    };
  }

  private async loadBuffer(
    url: string,
    signal: AbortSignal,
  ): Promise<AudioBuffer> {
    const existing = this.buffers.get(url);
    if (existing) return existing;
    let response: Response;
    try {
      response = await fetch(url, { signal, credentials: "same-origin" });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error("分轨音频加载失败，请检查本地服务是否正在运行。");
    }
    if (!response.ok)
      throw new Error(
        `分轨音频加载失败（HTTP ${response.status}）。请刷新工程后重试。`,
      );
    const bytes = await response.arrayBuffer();
    let buffer: AudioBuffer;
    try {
      buffer = await this.clock!.decodeAudioData(bytes);
    } catch {
      throw new Error(
        "浏览器无法解码这条分轨音频，文件可能损坏或格式不受支持。",
      );
    }
    if (signal.aborted)
      throw new DOMException("Playback cancelled", "AbortError");
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0)
      throw new Error("分轨音频为空，无法试听。");
    this.buffers.set(url, buffer);
    return buffer;
  }

  private createMixer(tracks: Track[]): void {
    const clock = this.clock!;
    this.master = clock.createGain();
    this.master.gain.value = this.mode === "midi" ? 0.7 : 1;
    this.limiter = clock.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    this.master.connect(this.limiter);
    this.limiter.connect(clock.rawContext.destination);
    for (const track of tracks) {
      const gain = clock.createGain();
      const pan = clock.createStereoPanner();
      gain.gain.value = 0;
      gain.connect(pan);
      pan.connect(this.master);
      this.buses.set(track.id, { gain, pan });
    }
    this.applyMix();
  }

  private applyMix(): void {
    if (!this.clock) return;
    const now = this.clock.currentTime;
    const hasSolo = [...this.mix.values()].some((mix) => mix.solo);
    for (const [id, bus] of this.buses) {
      const mix = this.mix.get(id);
      const audible = mix && !mix.muted && (!hasSolo || mix.solo);
      const gain = audible ? bounded(mix.volume, 0, 1, 1) : 0;
      bus.gain.gain.cancelScheduledValues(now);
      bus.gain.gain.setTargetAtTime(gain, now, 0.008);
      bus.pan.pan.cancelScheduledValues(now);
      bus.pan.pan.setTargetAtTime(
        mix ? bounded(mix.pan, -1, 1, 0) : 0,
        now,
        0.008,
      );
    }
  }

  private scheduleNotes(): void {
    if (!this.playing || !this.clock) return;
    const clock = this.clock;
    const now = clock.currentTime;
    const horizon = this.offset + Math.max(0, now - this.startedAt) + 0.25;
    while (this.nextNote < this.notes.length) {
      const event = this.notes[this.nextNote];
      if (event.note.startSeconds > horizon) break;
      this.nextNote += 1;
      const bus = this.buses.get(event.trackId);
      if (!bus) continue;
      // A percussion attack before a seek position must not be struck again.
      if (event.isDrum && event.note.startSeconds < this.offset) continue;
      const start = Math.max(
        this.startedAt,
        now + 0.002,
        this.startedAt + event.note.startSeconds - this.offset,
      );
      const end = this.startedAt + event.end - this.offset;
      // If the browser was delayed, skip elapsed notes rather than bunching them.
      if (end <= start) continue;
      if (event.isDrum) {
        this.scheduleDrum(event.note, bus, start);
        continue;
      }
      const oscillator = clock.createOscillator();
      const envelope = clock.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = 440 * 2 ** ((event.note.pitch - 69) / 12);
      oscillator.connect(envelope);
      envelope.connect(bus.gain);
      const level = 0.11 * bounded(event.note.velocity / 127, 0, 1);
      const attack = Math.min(0.012, (end - start) / 3);
      const release = Math.min(0.025, (end - start) / 3);
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(level, start + attack);
      envelope.gain.setValueAtTime(level, end - release);
      envelope.gain.linearRampToValueAtTime(0, end);
      this.sources.add(oscillator);
      this.envelopes.add(envelope);
      oscillator.onended = () => {
        this.sources.delete(oscillator);
        this.envelopes.delete(envelope);
        oscillator.disconnect();
        envelope.disconnect();
      };
      oscillator.start(start);
      oscillator.stop(end);
    }
  }

  /** Simple noise-based GM percussion preview, not an instrument classifier. */
  private scheduleDrum(note: Note, bus: Bus, start: number): void {
    const clock = this.clock!;
    let buffer = this.drumBuffers.get(note.pitch);
    if (!buffer) {
      const seconds =
        note.pitch === 42
          ? 0.09
          : note.pitch === 46
            ? 0.5
            : note.pitch === 49
              ? 1.3
              : note.pitch === 51
                ? 0.65
                : 0.18;
      buffer = clock.createBuffer(
        1,
        Math.ceil(clock.sampleRate * seconds),
        clock.sampleRate,
      );
      const samples = buffer.getChannelData(0);
      let seed = 12345,
        previous = 0;
      for (let i = 0; i < samples.length; i++) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        const noise = seed / 2147483648 - 1;
        const t = i / samples.length;
        samples[i] =
          (noise - previous) *
          0.25 *
          Math.exp(-7 * t) *
          Math.min(1, i / (clock.sampleRate * 0.002));
        previous = noise;
      }
      this.drumBuffers.set(note.pitch, buffer);
    }
    const source = clock.createBufferSource();
    const envelope = clock.createGain();
    source.buffer = buffer;
    envelope.gain.value = 0.55 * bounded(note.velocity / 127, 0, 1);
    source.connect(envelope);
    envelope.connect(bus.gain);
    this.sources.add(source);
    this.envelopes.add(envelope);
    source.onended = () => {
      this.sources.delete(source);
      this.envelopes.delete(envelope);
      source.disconnect();
      envelope.disconnect();
    };
    source.start(start);
  }

  private releaseNodes(): void {
    if (this.timer !== null && this.clock) this.clock.clearInterval(this.timer);
    this.timer = null;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already ended, or never started after an error. */
      }
      source.disconnect();
    }
    this.sources.clear();
    for (const envelope of this.envelopes) envelope.disconnect();
    this.envelopes.clear();
    for (const bus of this.buses.values()) {
      bus.gain.disconnect();
      bus.pan.disconnect();
    }
    this.buses.clear();
    this.master?.disconnect();
    this.limiter?.disconnect();
    this.master = null;
    this.limiter = null;
    this.notes = [];
    this.nextNote = 0;
  }
}

export const audioEngine = new AudioEngine();
