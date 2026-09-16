import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEditorStore } from "../state/editorStore";
import {
  useTransportStore,
  bindTransportEngine,
} from "../state/transportStore";
import {
  api,
  ApiError,
  DEMO,
  getErrorMessage,
  resolveAssetUrl,
} from "../services/api";
import { audioEngine } from "../audio/engine";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Arrangement } from "../components/Arrangement";
import { PianoRoll } from "../components/PianoRoll";
import { formatTime, pitchName } from "../lib/music";
import { TRACK_COLORS } from "../lib/tracks";
import { lowSignalLabel, soloFeedback } from "../lib/trackPresentation";
import {
  CYMBAL_VOICES,
  canEditTrackNotes,
  drumVoiceName,
  isDrumTrack,
  remapDrumVoice,
  transcriptionEngineLabel,
} from "../lib/transcriptionPresentation";
import { projectMidi, saveBytes } from "../lib/exportMidi";
import { useProjectJob } from "../hooks/useProjectJob";
import type { Project } from "../types";
import "./EditorFeedback.css";

function LiveTime({ cursor }: { cursor: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      if (ref.current)
        ref.current.textContent = formatTime(
          audioEngine.isPlaying() ? audioEngine.position() : cursor,
        );
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [cursor]);
  return <span ref={ref}>{formatTime(cursor)}</span>;
}
const activeJob = (p: Project) =>
  p.status === "queued" || p.status === "processing";
export function EditorPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id),
    retry: 1,
  });
  const state = useEditorStore();
  const { project, selectedTrackId, selectedNoteIds, dirty } = state;
  const {
    cursorSeconds: cursor,
    setCursorSeconds: setCursor,
    mode,
    setMode,
    isPlaying: playing,
  } = useTransportStore();
  const [inspector, setInspector] = useState(true);
  const savePending = useRef(false);
  const [saveStatus, setSaveStatus] = useState(""),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => bindTransportEngine(audioEngine), []);
  const relevant = project?.id === id ? project : null;
  const job = useProjectJob(q.data);
  useEffect(() => {
    if (q.data) state.loadProject(q.data);
  }, [q.data, state.loadProject]);
  useEffect(() => {
    audioEngine.stop();
    useTransportStore.getState().reset(DEMO ? "midi" : "audio");
    setError("");
    setSaveStatus("");
    setConflict(false);
    return () => audioEngine.stop();
  }, [id]);
  const noteSignature = relevant
    ? JSON.stringify(relevant.tracks.map((t) => ({ id: t.id, notes: t.notes })))
    : "";
  const previousNotes = useRef(noteSignature);
  useEffect(() => {
    if (
      previousNotes.current !== noteSignature &&
      mode === "midi" &&
      audioEngine.isPlaying()
    )
      setCursor(audioEngine.pause());
    previousNotes.current = noteSignature;
  }, [noteSignature, mode, setCursor]);
  useEffect(() => {
    if (relevant) audioEngine.updateMix(relevant.tracks);
  }, [relevant]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (useEditorStore.getState().dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  const seek = useCallback(async (seconds: number) => {
    setCursor(seconds);
    if (audioEngine.isPlaying()) {
      try {
        await audioEngine.seek(seconds);
      } catch (e) {
        setError(getErrorMessage(e));
      }
    }
  }, []);
  const toggle = useCallback(async () => {
    const p = useEditorStore.getState().project;
    if (!p) return;
    setError("");
    if (audioEngine.isPlaying()) {
      setCursor(audioEngine.pause());
      return;
    }
    try {
      await audioEngine.play(
        {
          ...p,
          tracks: p.tracks.map((t) => ({
            ...t,
            audioUrl: resolveAssetUrl(t.audioUrl),
          })),
        },
        mode,
        cursor >= p.durationSeconds ? 0 : cursor,
      );
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [mode, cursor]);
  function changeMode(next: "audio" | "midi") {
    const at = audioEngine.isPlaying() ? audioEngine.pause() : cursor;
    audioEngine.pause();
    setCursor(at);
    setMode(next);
    setError("");
  }
  async function auditionEditedNotes() {
    // Read after the input's blur commit so playback includes the latest draft.
    const current = useEditorStore.getState();
    const draft = current.project;
    if (!draft) return;
    const selected = draft.tracks
      .find((item) => item.id === current.selectedTrackId)
      ?.notes.filter((item) => current.selectedNoteIds.includes(item.id));
    if (!selected?.length) return;
    const start = Math.min(...selected.map((item) => item.startSeconds));
    audioEngine.pause();
    setCursor(start);
    setMode("midi");
    setError("");
    try {
      await audioEngine.play(draft, "midi", start);
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }
  async function save() {
    if (savePending.current) return null;
    const current = useEditorStore.getState().project;
    if (!current || activeJob(current)) return null;
    const submitted = structuredClone(current);
    savePending.current = true;
    setBusy(true);
    setSaveStatus("保存中");
    setError("");
    try {
      const saved = await api.saveProject(submitted);
      state.markSaved(saved, submitted);
      queryClient.setQueryData(["project", id], saved);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setSaveStatus(DEMO ? "已保存到本机" : "已保存");
      setConflict(false);
      return saved;
    } catch (e) {
      setSaveStatus("保存失败");
      setError(getErrorMessage(e));
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      return null;
    } finally {
      savePending.current = false;
      setBusy(false);
    }
  }
  async function exportMidi() {
    const current = useEditorStore.getState().project;
    if (!current) return;
    setError("");
    try {
      if (DEMO) {
        await saveBytes(projectMidi(current), `${current.title}.mid`);
        return;
      }
      const saved = await save();
      if (!saved) return;
      const response = await fetch(api.exportMidiUrl(saved.id));
      if (!response.ok) throw new Error(`MIDI 导出失败（${response.status}）`);
      await saveBytes(
        new Uint8Array(await response.arrayBuffer()),
        `${saved.title}.mid`,
      );
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }
  const handlers = useRef({ toggle, save });
  handlers.current = { toggle, save };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input,textarea,select,[contenteditable="true"]')) return;
      const s = useEditorStore.getState(),
        cmd = e.ctrlKey || e.metaKey;
      const editableTrack = s.project?.tracks.find(
        (item) => item.id === s.selectedTrackId,
      );
      const allowNoteEdit =
        !!s.project &&
        !activeJob(s.project) &&
        canEditTrackNotes(editableTrack);
      const k = e.key.toLowerCase();
      if (e.code === "Space") {
        e.preventDefault();
        void handlers.current.toggle();
      } else if (cmd && k === "z") {
        e.preventDefault();
        e.shiftKey ? s.redo() : s.undo();
      } else if (cmd && k === "s") {
        e.preventDefault();
        void handlers.current.save();
      } else if (cmd && k === "c") {
        e.preventDefault();
        s.copySelected();
      } else if (cmd && k === "v") {
        e.preventDefault();
        if (allowNoteEdit)
          s.pasteAt(audioEngine.isPlaying() ? audioEngine.position() : cursor);
      } else if (cmd && k === "a") {
        e.preventDefault();
        s.setSelection(
          s.project?.tracks
            .find((t) => t.id === s.selectedTrackId)
            ?.notes.map((n) => n.id) || [],
        );
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (allowNoteEdit) s.deleteSelected();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [cursor]);
  if (q.isLoading || (!relevant && !q.error))
    return (
      <div className="empty-state" aria-busy="true">
        正在打开工程…
      </div>
    );
  if (!relevant)
    return (
      <div className="page-content">
        <h1>工程无法打开</h1>
        <div className="error">{getErrorMessage(q.error)}</div>
        <Button onClick={() => void q.refetch()}>重试</Button>{" "}
        <Link to="/projects">返回项目</Link>
      </div>
    );
  const locked = activeJob(relevant),
    track = relevant.tracks.find((t) => t.id === selectedTrackId) || null,
    note = track?.notes.find((n) => n.id === selectedNoteIds[0]);
  const solo = soloFeedback(relevant.tracks, mode);
  const drum = isDrumTrack(track);
  const notesDisabled = locked || !canEditTrackNotes(track);
  const drumPitches = [
    ...new Set(track?.notes.map((item) => item.pitch) ?? []),
  ];
  const drumPitch = drumPitches.length === 1 ? drumPitches[0] : "";
  const separatedAudio =
    !DEMO &&
    relevant.tracks.some(
      (t) =>
        t.audioUrl &&
        ["vocal", "drums", "bass", "piano", "guitar"].includes(t.kind),
    );
  const warnings = [...new Set(relevant.warnings)];
  const measuredTracks = relevant.tracks.filter((t) => t.analysis);
  const quietTrackCount = measuredTracks.filter(
    (t) => t.analysis?.lowSignal,
  ).length;
  return (
    <div className="editor-page">
      <header className="editor-header">
        <div className="editor-identity">
          <Link
            className="back-link"
            to="/projects"
            onClick={(e) => {
              if (dirty && !window.confirm("工程有未保存的修改，仍要返回吗？"))
                e.preventDefault();
            }}
          >
            ‹ 项目
          </Link>
          <Input
            className="project-title-input"
            aria-label="项目名称"
            value={relevant.title}
            disabled={locked}
            onChange={(e) => state.rename(e.target.value)}
          />
          <span
            className={`save-state ${dirty ? "unsaved" : ""}`}
            role="status"
          >
            {busy ? "保存中" : dirty ? "未保存" : saveStatus || "未修改"}
          </span>
        </div>
        <div className="editor-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={!state.past.length || locked}
            onClick={state.undo}
            title="Ctrl+Z"
          >
            撤销
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!state.future.length || locked}
            onClick={state.redo}
            title="Ctrl+Shift+Z"
          >
            重做
          </Button>
          <div className="toolbar-divider" />
          <Button
            variant="secondary"
            disabled={busy || locked}
            onClick={() => void save()}
          >
            {DEMO ? "保存到本机" : "保存工程"}
          </Button>
          <Button disabled={busy || locked} onClick={() => void exportMidi()}>
            导出 MIDI
          </Button>
        </div>
      </header>
      <div className="transport">
        <div className="transport-buttons">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              audioEngine.stop();
              setCursor(0);
            }}
            aria-label="回到开头"
          >
            |‹
          </Button>
          <Button size="sm" onClick={() => void toggle()}>
            {playing ? "暂停" : "播放"}
          </Button>
        </div>
        <div className="time-display">
          <LiveTime cursor={cursor} />
          <span className="muted">
            {" "}
            / {formatTime(relevant.durationSeconds)}
          </span>
        </div>
        <div className="toolbar-divider" />
        <label className="tempo">
          <Input
            aria-label="BPM"
            type="number"
            min="20"
            max="300"
            disabled={locked}
            value={relevant.bpm}
            onChange={(e) => state.setBpm(+e.target.value)}
          />
          <span>BPM</span>
        </label>
        <span className="meter">4/4</span>
        <span
          className="tempo-note"
          title="默认或用户设定的BPM，未自动检测；只改变节拍网格，音符秒数和原音频速度不变。"
        >
          网格速度
        </span>
        <div className="transport-spacer" />
        <div className="segment" aria-label="试听模式">
          {(["audio", "midi"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              className={mode === m ? "selected" : ""}
              onClick={() => changeMode(m)}
            >
              {m === "audio" ? "分轨音频" : "MIDI"}
            </button>
          ))}
        </div>
        <span className="hint audition-hint">
          {mode === "midi" ? "播放当前编辑音符" : "原录音 · 不随音符修改"}
        </span>
      </div>
      {error && (
        <div className="editor-alert error" role="alert">
          <span>{error}</span>
          {conflict && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (
                  window.confirm(
                    "本地草稿仍保留。重新加载会放弃这些修改，是否继续？",
                  )
                )
                  void api
                    .getProject(id)
                    .then((p) => {
                      state.loadProject(p, true);
                      queryClient.setQueryData(["project", id], p);
                      setConflict(false);
                      setError("");
                    })
                    .catch((e) => setError(getErrorMessage(e)));
              }}
            >
              重新加载服务器版本
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setError("")}>
            关闭提示
          </Button>
        </div>
      )}
      {job.job && (
        <div className={`job-progress ${locked ? "active" : ""}`}>
          <div className="job-stages">
            {["等待", "读取音频", "分离音轨", "识别音符", "完成"].map(
              (label, i) => {
                const idx = [
                  "queued",
                  "decode",
                  "separate",
                  "transcribe",
                  "done",
                ].indexOf(job.job!.stage);
                return (
                  <span key={label} className={i === idx ? "current" : ""}>
                    {label}
                    {i < 4 ? "  ›" : ""}
                  </span>
                );
              },
            )}
          </div>
          <span>{job.job.message}</span>
          {locked && (
            <>
              <progress
                aria-label="任务进度"
                {...(job.job.progress === null
                  ? {}
                  : { value: job.job.progress, max: 1 })}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={job.isCancelling}
                onClick={() =>
                  void job.cancel().catch((e) => setError(getErrorMessage(e)))
                }
              >
                取消处理
              </Button>
            </>
          )}
          {job.job.error && <span className="error-text">{job.job.error}</span>}
          {["failed", "cancelled"].includes(job.job.status) && (
            <Link to="/upload">新建项目重试</Link>
          )}
        </div>
      )}
      {job.error && (
        <div className="editor-note" role="status">
          {getErrorMessage(job.error)}
        </div>
      )}
      {locked && (
        <div className="editor-note">
          处理期间可试听已完成的音轨；识别结束后开放音符编辑。
        </div>
      )}
      {mode === "audio" && !relevant.tracks.some((t) => t.audioUrl) && (
        <div className="editor-note">
          当前工程没有音频文件。切换到 MIDI 可试听已有音符。
        </div>
      )}
      {(separatedAudio || warnings.length > 0) && (
        <section className="recognition-context" aria-label="识别结果说明">
          {separatedAudio && (
            <p>
              <strong>轨名是固定分离类别，不代表检测到了这些乐器。</strong>
              四轨没有独立钢琴轨，钢琴通常在“其他”中；六轨的钢琴与吉他分离仍属实验功能。
            </p>
          )}
          {warnings.length > 0 && (
            <details>
              <summary>识别说明与提示（{warnings.length}）</summary>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {solo && (
        <div className="solo-notice" role="status">
          <div>
            <strong>正在独奏：{solo.names}</strong>
            <span>
              其他未独奏轨暂时静音。M 静音优先于 S
              独奏；独奏不会自动放大很弱的音频。
            </span>
            {solo.warning && <p>{solo.warning}</p>}
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={locked}
            onClick={state.clearSolo}
          >
            退出全部独奏
          </Button>
        </div>
      )}
      <div className="workspace-heading">
        <div>
          <strong>多轨编排</strong>
          <span className="hint">
            {relevant.tracks.length} 条{separatedAudio ? "输出轨道" : "音轨"} ·{" "}
            {measuredTracks.length > 0 && (
              <>
                {measuredTracks.length - quietTrackCount} 条有信号 /{" "}
                {quietTrackCount} 条近乎静音
                {measuredTracks.length < relevant.tracks.length
                  ? ` / ${relevant.tracks.length - measuredTracks.length} 条未测`
                  : ""}
                {" · "}
              </>
            )}
            {relevant.tracks.reduce((n, t) => n + t.notes.length, 0)} 个音符
          </span>
        </div>
        <label className="zoom-label">
          缩放
          <input
            type="range"
            aria-label="时间轴缩放"
            min="24"
            max="200"
            value={state.pixelsPerSecond}
            onChange={(e) => state.setPixelsPerSecond(+e.target.value)}
          />
        </label>
      </div>
      {relevant.tracks.length ? (
        <Arrangement
          project={relevant}
          mode={mode}
          cursorSeconds={cursor}
          onSeek={(s) => void seek(s)}
        />
      ) : (
        <div className="empty-state">
          <h2>等待音轨</h2>
          <p>完成的轨道会显示在这里。</p>
          {relevant.status === "empty" && <Link to="/upload">上传新音频</Link>}
        </div>
      )}
      <div className={`lower-workspace ${inspector ? "" : "inspector-hidden"}`}>
        <section className="piano-panel">
          <div className="piano-heading">
            <div>
              <span
                className="track-dot"
                style={{
                  background: track ? TRACK_COLORS[track.kind] : "gray",
                }}
              />
              <strong>{track?.name || "选择音轨"}</strong>
              <span className="hint">{drum ? "打击乐编辑" : "钢琴卷帘"}</span>
              {drum && track?.transcriptionStatus === "unsupported" && (
                <span className="hint">此工程仅保留鼓音频</span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setInspector(!inspector)}
            >
              {inspector ? "收起属性" : "显示属性"}
            </Button>
          </div>
          {mode === "audio" && (
            <div className="piano-audition-note">
              <span>
                {drum && track?.transcriptionStatus !== "completed"
                  ? "当前听分轨音频。此工程尚未生成可编辑鼓点。"
                  : "当前听分轨音频。下方音符仍可编辑；试听修改后的音符请切换到 MIDI。"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => changeMode("midi")}
              >
                切换到 MIDI 试听
              </Button>
            </div>
          )}
          {track && lowSignalLabel(track) && (
            <p className="piano-signal-note">
              {lowSignalLabel(track)}；音频和已有音符均保留，可继续试听与编辑。
            </p>
          )}
          {track && !DEMO && (
            <p className="piano-signal-note">
              {transcriptionEngineLabel(track)}
              {drum
                ? "。鼓点位置表示击打时间；默认 GM 49 是试听音色，不是识别出的镲片种类。触发长度不代表尾音。"
                : "。音符仍需对照原音频校对，尤其是泛音、重复起音和尾音。"}
            </p>
          )}
          <PianoRoll
            track={track}
            durationSeconds={relevant.durationSeconds}
            bpm={relevant.bpm}
            disabled={notesDisabled}
            color={track ? TRACK_COLORS[track.kind] : "#6578d0"}
            cursorSeconds={cursor}
            onSeek={(s) => void seek(s)}
          />
        </section>
        {inspector && (
          <aside className="inspector">
            <div className="inspector-title">
              <strong>属性</strong>
              <span className="badge">
                {selectedNoteIds.length
                  ? `${selectedNoteIds.length} 个音符`
                  : "音轨"}
              </span>
            </div>
            {note ? (
              <>
                <p className="inspector-caption">
                  {selectedNoteIds.length > 1
                    ? "批量修改所选音符；下列显示第一个音符"
                    : "选中的音符"}
                </p>
                <div className="note-pitch">
                  {drum ? drumVoiceName(note.pitch) : pitchName(note.pitch)}
                  <span>MIDI {note.pitch}</span>
                </div>
                <div className="inspector-fields">
                  {(
                    [
                      {
                        label: drum ? "鼓音编号 · GM" : "音高",
                        key: "pitch",
                        min: 0,
                        max: 127,
                        step: 1,
                      },
                      {
                        label: "开始时间 · 秒",
                        key: "startSeconds",
                        min: 0,
                        max: 86400,
                        step: 0.01,
                      },
                      {
                        label: drum ? "触发长度 · 秒" : "持续时间 · 秒",
                        key: "durationSeconds",
                        min: 0.01,
                        max: 86400,
                        step: 0.01,
                      },
                      {
                        label: "力度",
                        key: "velocity",
                        min: 1,
                        max: 127,
                        step: 1,
                      },
                    ] as const
                  ).map((f) => (
                    <label className="field" key={f.key}>
                      <span>{f.label}</span>
                      <Input
                        type="number"
                        value={Number(note[f.key].toFixed(3))}
                        min={f.min}
                        max={f.max}
                        step={f.step}
                        disabled={notesDisabled}
                        onChange={(e) =>
                          state.updateSelectedNotes({
                            [f.key]: +e.target.value,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="note-audition">
                  <strong>
                    {mode === "audio"
                      ? "当前试听：原始分轨音频"
                      : "当前试听：MIDI 音符"}
                  </strong>
                  <p>
                    {mode === "audio"
                      ? "这里修改音符的音高、时间和力度，会改变 MIDI 试听与导出；原录音保持不变。"
                      : "播放当前编辑的音符，使用合成音色。原始分轨录音保持不变。"}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void auditionEditedNotes()}
                  >
                    从所选音符试听 MIDI
                  </Button>
                  <span>按当前轨道的静音、独奏和音量设置播放。</span>
                </div>
                <Button
                  variant="ghost"
                  disabled={notesDisabled}
                  onClick={state.deleteSelected}
                >
                  删除所选音符
                </Button>
              </>
            ) : (
              <div className="inspector-empty">
                选择一个音符
                <br />
                <span>查看音高、时间与力度</span>
              </div>
            )}
            <div className="inspector-track">
              <strong>轨道信息</strong>
              {drum && track?.transcriptionStatus === "completed" && (
                <label className="field drum-voice-field">
                  <span>整轨鼓点音色 · GM</span>
                  <select
                    aria-label="整轨鼓点音色"
                    disabled={notesDisabled || !track.notes.length}
                    value={
                      CYMBAL_VOICES.some((voice) => voice.pitch === drumPitch)
                        ? drumPitch
                        : ""
                    }
                    onChange={(event) => {
                      state.patchTrack(track.id, {
                        notes: remapDrumVoice(
                          track,
                          Number(event.target.value),
                        ),
                      });
                    }}
                  >
                    <option value="" disabled>
                      {drumPitches.length > 1
                        ? "当前使用多个鼓音"
                        : drumPitches.length
                          ? `当前 GM ${drumPitch}`
                          : "尚无鼓点"}
                    </option>
                    {CYMBAL_VOICES.map((voice) => (
                      <option key={voice.pitch} value={voice.pitch}>
                        {voice.pitch} · {voice.name}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    更改本轨全部鼓点，一次撤销即可恢复。音色为简单合成示意，可导出到鼓音源；不是镲片种类识别。
                  </span>
                </label>
              )}
              <dl>
                <div>
                  <dt>名称</dt>
                  <dd>{track?.name || "—"}</dd>
                </div>
                <div>
                  <dt>音符</dt>
                  <dd>{track?.notes.length || 0}</dd>
                </div>
                {track && !DEMO && (
                  <div>
                    <dt>识别引擎</dt>
                    <dd>{transcriptionEngineLabel(track)}</dd>
                  </div>
                )}
                <div>
                  <dt>音频</dt>
                  <dd>
                    {track?.audioUrl
                      ? track.analysis?.lowSignal
                        ? "近乎静音（音频保留）"
                        : "可试听"
                      : "未提供"}
                  </dd>
                </div>
              </dl>
              {track?.warnings.map((w, i) => (
                <p className="hint" key={i}>
                  {w}
                </p>
              ))}
              {drum && track?.transcriptionStatus !== "completed" && (
                <p className="hint">
                  此工程未生成可编辑鼓点。可试听鼓音频；新建项目启用镲片击打点检测后可生成
                  MIDI。
                </p>
              )}
              {track?.kind === "other" && (
                <p className="hint">可能包含多种乐器，转录结果需要试听校对。</p>
              )}
            </div>
          </aside>
        )}
      </div>
      <footer className="editor-footer">
        <span>双击添加音符 · 拖动编辑 · 右边缘调整时长</span>
        <span>Space 播放　⌘ / Ctrl + Z 撤销　Delete 删除</span>
      </footer>
    </div>
  );
}
