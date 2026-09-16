import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

export interface WaveformProps {
  url: string | null;
  color: string;
  height?: number;
  pixelsPerSecond?: number;
}

/** Visual-only waveform. All audible playback belongs to audioEngine. */
export function Waveform({
  url,
  color,
  height = 48,
  pixelsPerSecond = 64,
}: WaveformProps) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<WaveSurfer | null>(null);
  const [status, setStatus] = useState<"empty" | "loading" | "ready" | "error">(
    "empty",
  );
  const safeHeight = Number.isFinite(height) ? Math.max(20, height) : 48;

  useEffect(() => {
    if (!url || !container.current) {
      setStatus("empty");
      return;
    }
    let alive = true;
    setStatus("loading");
    const wave = WaveSurfer.create({
      container: container.current,
      waveColor: color,
      progressColor: color,
      cursorWidth: 0,
      height: safeHeight,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      normalize: false,
      fillParent: false,
      minPxPerSec: pixelsPerSecond,
      interact: false,
      dragToSeek: false,
      mediaControls: false,
      autoplay: false,
      autoScroll: false,
      hideScrollbar: true,
      fetchParams: { credentials: "same-origin" },
    });
    instance.current = wave;
    // The hidden media element must never become a second playback engine.
    wave.setMuted(true);
    wave.on("play", () => wave.pause());
    wave.on("ready", () => {
      if (alive) setStatus("ready");
    });
    wave.on("error", () => {
      if (alive) setStatus("error");
    });
    void wave.load(url).catch(() => {
      if (alive) setStatus("error");
    });
    return () => {
      alive = false;
      instance.current = null;
      wave.destroy();
    };
  }, [url, color, safeHeight, pixelsPerSecond]);

  const message =
    !url || status === "empty"
      ? "暂无音频波形"
      : status === "error"
        ? "波形加载失败"
        : status === "loading"
          ? "正在读取真实音频…"
          : null;

  return (
    <div
      className="waveform"
      style={{ minHeight: safeHeight, position: "relative", width: "100%" }}
    >
      <div
        ref={container}
        role="img"
        aria-label={status === "ready" ? "真实音频波形" : undefined}
        aria-hidden={status !== "ready"}
        style={{
          height: safeHeight,
          opacity: status === "ready" ? 0.85 : 0,
          pointerEvents: "none",
        }}
      />
      {message && (
        <span
          role="status"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            opacity: 0.55,
            padding: "0 8px",
          }}
        >
          {message}
        </span>
      )}
    </div>
  );
}

export default Waveform;
