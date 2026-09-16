import { create } from "zustand";
import type { PlaybackMode } from "../audio/engine";

export interface TransportState {
  mode: PlaybackMode;
  /** Last user seek or engine state transition. Do not update this every frame. */
  cursorSeconds: number;
  isPlaying: boolean;
  setMode(mode: PlaybackMode): void;
  setCursorSeconds(seconds: number): void;
  setIsPlaying(isPlaying: boolean): void;
  reset(mode?: PlaybackMode): void;
}

const validPosition = (seconds: number) =>
  Number.isFinite(seconds) ? Math.max(0, seconds) : 0;

/** UI transport state; the audio engine remains the authority for elapsed time. */
export const useTransportStore = create<TransportState>((set) => ({
  mode: "audio",
  cursorSeconds: 0,
  isPlaying: false,
  // Mode changes do not start/pause audio. The click handler controls the engine
  // so Tone.start() remains inside a user gesture.
  setMode: (mode) => set({ mode }),
  setCursorSeconds: (seconds) => set({ cursorSeconds: validPosition(seconds) }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  reset: (mode = "audio") => set({ mode, cursorSeconds: 0, isPlaying: false }),
}));

export interface TransportEngine {
  isPlaying(): boolean;
  position(): number;
  subscribe(listener: () => void): () => void;
}

/**
 * Bind once in the editor effect and return this cleanup function.
 * Captures pause, stop, failed start and natural completion, including the final
 * cursor at the end of a song. Canvas/DOM animation still reads engine.position()
 * from requestAnimationFrame and never routes high-frequency ticks through React.
 */
export function bindTransportEngine(engine: TransportEngine): () => void {
  const sync = () =>
    useTransportStore.setState({
      isPlaying: engine.isPlaying(),
      cursorSeconds: validPosition(engine.position()),
    });
  const unsubscribe = engine.subscribe(sync);
  // Preserve a seek made before this engine has ever played. An inactive engine
  // may still contain the previous project's position when this effect mounts.
  if (engine.isPlaying()) sync();
  else useTransportStore.getState().setIsPlaying(false);
  return unsubscribe;
}
