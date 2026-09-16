import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindTransportEngine, useTransportStore } from "./transportStore";

beforeEach(() => useTransportStore.getState().reset());

describe("transport state transitions", () => {
  it("preserves a user seek before first playback and changes mode without resetting it", () => {
    const state = useTransportStore.getState();
    state.setCursorSeconds(7.25);
    const unbind = bindTransportEngine({
      isPlaying: () => false,
      position: () => 0,
      subscribe: () => () => {},
    });
    state.setMode("midi");
    expect(useTransportStore.getState()).toMatchObject({
      mode: "midi",
      cursorSeconds: 7.25,
      isPlaying: false,
    });
    unbind();
  });

  it("captures the engine final cursor only on notifications and releases its subscription", () => {
    let position = 3;
    let playing = true;
    let listener: (() => void) | null = null;
    const unsubscribe = vi.fn(() => {
      listener = null;
    });
    const unbind = bindTransportEngine({
      isPlaying: () => playing,
      position: () => position,
      subscribe: (next) => {
        listener = next;
        return unsubscribe;
      },
    });
    expect(useTransportStore.getState()).toMatchObject({
      cursorSeconds: 3,
      isPlaying: true,
    });
    position = 4;
    expect(useTransportStore.getState().cursorSeconds).toBe(3);
    position = 24;
    playing = false;
    listener!();
    expect(useTransportStore.getState()).toMatchObject({
      cursorSeconds: 24,
      isPlaying: false,
    });
    unbind();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
