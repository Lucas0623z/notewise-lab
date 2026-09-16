import { useEffect, useRef } from "react";
import type { Project } from "../types";
import { audioEngine } from "../audio/engine";
import type { PlaybackMode } from "../audio/engine";
import { useEditorStore } from "../state/editorStore";
import { TRACK_COLORS } from "../lib/tracks";
import { Waveform } from "./Waveform";
import { resolveAssetUrl } from "../services/api";
import {
  arrangementLayer,
  lowSignalLabel,
  mixSilenceReason,
} from "../lib/trackPresentation";
type Props = {
  project: Project;
  mode: PlaybackMode;
  cursorSeconds: number;
  onSeek: (seconds: number) => void;
};
export function Arrangement({ project, mode, cursorSeconds, onSeek }: Props) {
  const selected = useEditorStore((s) => s.selectedTrackId),
    select = useEditorStore((s) => s.selectTrack),
    patch = useEditorStore((s) => s.patchTrack),
    pps = useEditorStore((s) => s.pixelsPerSecond);
  const canvas = useRef<HTMLCanvasElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    cursor = useRef<HTMLDivElement>(null);
  const locked = project.status === "processing" || project.status === "queued";
  const width = Math.max(800, project.durationSeconds * pps),
    height = project.tracks.length * 80;
  useEffect(() => {
    const node = canvas.current,
      host = scroll.current;
    if (!node || !host) return;
    const draw = () => {
      const w = host.clientWidth,
        dpr = devicePixelRatio || 1;
      node.width = w * dpr;
      node.height = height * dpr;
      node.style.width = `${w}px`;
      node.style.height = `${height}px`;
      const c = node.getContext("2d")!;
      c.scale(dpr, dpr);
      const dark = document.documentElement.dataset.theme === "dark";
      c.fillStyle = dark ? "#1d1d21" : "#fff";
      c.fillRect(0, 0, w, height);
      const left = host.scrollLeft,
        beat = 60 / project.bpm;
      for (
        let i = Math.floor(left / pps / beat);
        i < (left + w) / pps / beat;
        i++
      ) {
        const x = i * beat * pps - left;
        c.strokeStyle =
          i % 4 === 0
            ? dark
              ? "#44444b"
              : "#dedee5"
            : dark
              ? "#2e2e34"
              : "#f0f0f4";
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, height);
        c.stroke();
      }
      project.tracks.forEach((t, index) => {
        const y = index * 80;
        c.fillStyle =
          t.id === selected
            ? dark
              ? "#0088ff1f"
              : "#0088ff12"
            : "transparent";
        c.fillRect(0, y, w, 80);
        c.strokeStyle = dark ? "#333339" : "#e9e9ed";
        c.beginPath();
        c.moveTo(0, y + 79);
        c.lineTo(w, y + 79);
        c.stroke();
        if (arrangementLayer(t, mode) !== "notes") return;
        c.save();
        c.beginPath();
        c.rect(0, y, w, 79);
        c.clip();
        c.fillStyle = t.analysis?.lowSignal ? "#9299a3" : TRACK_COLORS[t.kind];
        for (const n of t.notes) {
          const x = n.startSeconds * pps - left,
            nw = Math.max(3, n.durationSeconds * pps);
          if (x + nw < 0 || x > w) continue;
          c.globalAlpha = mixSilenceReason(t, project.tracks) ? 0.3 : 0.8;
          c.fillRect(x, y + 7 + (127 - n.pitch) * (64 / 127), nw, 4);
          c.globalAlpha = 1;
        }
        c.restore();
      });
    };
    draw();
    host.addEventListener("scroll", draw);
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      ro.disconnect();
      observer.disconnect();
      host.removeEventListener("scroll", draw);
    };
  }, [project, mode, selected, pps, height]);
  useEffect(() => {
    let frame = 0;
    const paint = () => {
      if (audioEngine.isPlaying() && scroll.current) {
        const x = audioEngine.position() * pps,
          h = scroll.current;
        if (x < h.scrollLeft || x > h.scrollLeft + h.clientWidth - 24)
          h.scrollLeft = Math.max(0, x - h.clientWidth * 0.2);
      }
      if (cursor.current)
        cursor.current.style.transform = `translateX(${(audioEngine.isPlaying() ? audioEngine.position() : cursorSeconds) * pps}px)`;
      frame = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frame);
  }, [cursorSeconds, pps]);
  useEffect(() => {
    const h = scroll.current;
    if (h && !audioEngine.isPlaying()) {
      const x = cursorSeconds * pps;
      if (x < h.scrollLeft || x > h.scrollLeft + h.clientWidth - 24)
        h.scrollLeft = Math.max(0, x - h.clientWidth * 0.2);
    }
  }, [cursorSeconds, pps]);
  return (
    <section className="arrangement" aria-label="多轨编排">
      <div className="track-controls">
        <div className="tracks-header">
          <strong>音轨</strong>
          <span title="M 静音本轨；S 仅播放已独奏轨；静音优先于独奏">
            M 静音 · S 独奏
          </span>
        </div>
        {project.tracks.map((t) => (
          <div
            className={`track-control ${selected === t.id ? "selected" : ""} ${t.analysis?.lowSignal ? "low-signal" : ""} ${mixSilenceReason(t, project.tracks) ? "mix-silent" : ""}`}
            key={t.id}
            onClick={() => select(t.id)}
          >
            <div className="track-top">
              <button
                className="track-name"
                title={t.name}
                onClick={() => select(t.id)}
              >
                <i style={{ background: TRACK_COLORS[t.kind] }} />
                <span>{t.name}</span>
              </button>
              <button
                disabled={locked}
                className={`tiny ${t.muted ? "active" : ""}`}
                aria-label={`${t.name}静音`}
                aria-pressed={t.muted}
                title={
                  t.muted
                    ? "取消静音：恢复本轨（仍受独奏选择和音量控制）"
                    : "静音本轨：即使独奏也不会发声"
                }
                onClick={() => patch(t.id, { muted: !t.muted })}
              >
                M
              </button>
              <button
                disabled={locked}
                className={`tiny ${t.solo ? "active" : ""}`}
                aria-label={`${t.name}独奏`}
                aria-pressed={t.solo}
                title={
                  t.solo
                    ? "取消本轨独奏"
                    : "独奏本轨：其他未独奏轨会暂时静音；可同时独奏多轨"
                }
                onClick={() => patch(t.id, { solo: !t.solo })}
              >
                S
              </button>
            </div>
            <div
              className="track-status"
              title={[lowSignalLabel(t), mixSilenceReason(t, project.tracks)]
                .filter(Boolean)
                .join("；")}
            >
              {lowSignalLabel(t) ||
                mixSilenceReason(t, project.tracks) ||
                (t.solo ? "独奏中" : "")}
            </div>
            <div className="track-mix">
              <label>
                音量
                <input
                  type="range"
                  disabled={locked}
                  aria-label={`${t.name}音量`}
                  min="0"
                  max="1"
                  step=".01"
                  value={t.volume}
                  onChange={(e) => patch(t.id, { volume: +e.target.value })}
                />
              </label>
              <label>
                声像
                <input
                  type="range"
                  disabled={locked}
                  aria-label={`${t.name}声像`}
                  min="-1"
                  max="1"
                  step=".1"
                  value={t.pan}
                  onChange={(e) => patch(t.id, { pan: +e.target.value })}
                />
              </label>
            </div>
          </div>
        ))}
      </div>
      <div
        ref={scroll}
        className="arrangement-scroll"
        style={{ height: height + 52 }}
      >
        <div style={{ width, position: "relative" }}>
          <div
            className="time-ruler"
            onClick={(e) =>
              onSeek(
                Math.min(project.durationSeconds, e.nativeEvent.offsetX / pps),
              )
            }
          >
            {Array.from(
              { length: Math.ceil(project.durationSeconds / 2) + 1 },
              (_, i) => (
                <span key={i} style={{ left: i * 2 * pps }}>
                  {String(Math.floor((i * 2) / 60)).padStart(2, "0")}:
                  {String((i * 2) % 60).padStart(2, "0")}
                </span>
              ),
            )}
          </div>
          <canvas
            className="arrangement-canvas"
            ref={canvas}
            style={{ position: "sticky", left: 0 }}
            onClick={(e) => {
              const y = e.nativeEvent.offsetY,
                index = Math.floor(y / 80);
              if (project.tracks[index]) select(project.tracks[index].id);
              onSeek(
                Math.min(
                  project.durationSeconds,
                  (e.nativeEvent.offsetX + (scroll.current?.scrollLeft || 0)) /
                    pps,
                ),
              );
            }}
          />
          {project.tracks.map((t, i) =>
            arrangementLayer(t, mode) === "waveform" ? (
              <div
                className={`wave-lane ${t.analysis?.lowSignal ? "low-signal" : ""} ${mixSilenceReason(t, project.tracks) ? "mix-silent" : ""}`}
                style={{ top: 36 + i * 80 }}
                key={t.id}
              >
                <Waveform
                  url={resolveAssetUrl(t.audioUrl)}
                  color={TRACK_COLORS[t.kind]}
                  height={62}
                  pixelsPerSecond={pps}
                />
              </div>
            ) : arrangementLayer(t, mode) === "empty" ? (
              <div
                className="lane-empty"
                style={{ top: 36 + i * 80 }}
                key={t.id}
              >
                {mode === "audio"
                  ? "本轨没有音频文件"
                  : lowSignalLabel(t) ||
                    (t.kind === "drums"
                      ? t.transcriptionStatus === "completed"
                        ? "尚无鼓点，可在下方添加"
                        : "此工程仅保留鼓音频，可切换到音频试听"
                      : "尚无音符")}
              </div>
            ) : null,
          )}
          <div className="playhead arrangement-playhead" ref={cursor} />
        </div>
      </div>
    </section>
  );
}
