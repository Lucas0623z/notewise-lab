import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ServiceSetupProgress } from "../components/ServiceSetupProgress";
import { DEMO_PROJECT_ID } from "../data/demo";
import { useServiceStatus } from "../hooks/useServiceStatus";
import { api, DEMO, getErrorMessage } from "../services/api";
import type { Project, UploadAudioInput } from "../types";
import "./UploadPage.css";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_SECONDS = 30 * 60;
const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function UploadPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [bpm, setBpm] = useState("120");
  const [bpmEdited, setBpmEdited] = useState(false);
  const [mode, setMode] =
    useState<NonNullable<UploadAudioInput["mode"]>>("demucs_basic_pitch");
  const [separationModel, setSeparationModel] =
    useState<NonNullable<UploadAudioInput["separationModel"]>>("htdemucs");
  const [transcriptionModel, setTranscriptionModel] =
    useState<NonNullable<UploadAudioInput["transcriptionModel"]>>(
      "basic_pitch",
    );
  const [drumTranscription, setDrumTranscription] =
    useState<NonNullable<UploadAudioInput["drumTranscription"]>>("none");
  const [duration, setDuration] = useState<number | null>(null);
  const [readingMetadata, setReadingMetadata] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [checkingBeforeUpload, setCheckingBeforeUpload] = useState(false);
  const [serviceActionPending, setServiceActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const durationTooLong = duration !== null && duration > MAX_DURATION_SECONDS;
  const service = useServiceStatus(
    mode,
    separationModel,
    transcriptionModel,
    drumTranscription,
  );
  const canEnableRecognition = !!window.desktop?.enableRecognition;

  async function retryService() {
    if (serviceActionPending || service.isChecking) return;
    setServiceActionPending(true);
    setError(null);
    try {
      if (!service.availability.ready) {
        await window.desktop?.enableRecognition?.();
      }
      await service.retry();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setServiceActionPending(false);
    }
  }

  async function enableRecognition() {
    if (serviceActionPending || !canEnableRecognition) return;
    setServiceActionPending(true);
    setError(null);
    try {
      // The desktop relaunches in API mode, keeping this route. The current
      // module's DEMO constant intentionally stays true until that relaunch.
      await window.desktop!.enableRecognition!();
    } catch (cause) {
      setError(getErrorMessage(cause));
      setServiceActionPending(false);
    }
  }

  function capabilityLabel(
    capability:
      | "transcribeOnly"
      | "separate4"
      | "separate6"
      | "pianoTranscription"
      | "cymbalOnsets",
  ) {
    if (service.error) return "未连接";
    if (!service.status) return "检查中";
    return service.status.status === "ready" &&
      service.status.apiReady &&
      service.status.workerReady &&
      service.status.capabilities[capability]
      ? "可用"
      : "未就绪";
  }

  useEffect(() => {
    setDuration(null);
    if (!file) {
      setReadingMetadata(false);
      return;
    }
    let active = true;
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    setReadingMetadata(true);
    // Unsupported metadata must not leave the form blocked forever; the local
    // worker still validates the decoded duration before running its models.
    const timeout = window.setTimeout(() => {
      if (active) setReadingMetadata(false);
    }, 10_000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      if (!active) return;
      setDuration(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : null,
      );
      setReadingMetadata(false);
      window.clearTimeout(timeout);
    };
    audio.onerror = () => {
      if (active) setReadingMetadata(false);
      window.clearTimeout(timeout);
    };
    audio.src = url;
    return () => {
      active = false;
      window.clearTimeout(timeout);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    };
  }, [file]);

  function chooseFile(selected?: File) {
    if (!selected || pending) return;
    setError(null);
    if (!/\.(wav|mp3|flac)$/i.test(selected.name)) {
      setError("请选择 WAV、MP3 或 FLAC 音频。");
      return;
    }
    if (selected.size === 0) {
      setError("这个文件是空的，请选择有效音频。");
      return;
    }
    if (selected.size > MAX_BYTES) {
      setError("音频不能超过 100 MB。");
      return;
    }
    setDuration(null);
    setReadingMetadata(true);
    setFile(selected);
    setTitle(selected.name.replace(/\.[^.]+$/, "").slice(0, 200));
    setCreatedProject(null);
  }
  function dropped(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 1) {
      setError("一次处理一个音频文件，请单独选择。");
      return;
    }
    chooseFile(event.dataTransfer.files[0]);
  }
  function changed(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0]);
    event.target.value = "";
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || DEMO) return;
    setError(null);
    if (!file) {
      setError("请先选择音频文件。");
      return;
    }
    if (readingMetadata) {
      setError("正在读取音频时长，请稍候。");
      return;
    }
    if (duration !== null && duration > MAX_DURATION_SECONDS) {
      setError("音频最长为 30 分钟，请先截取需要识别的片段。");
      return;
    }
    if (!title.trim()) {
      setError("请输入项目名称。");
      return;
    }
    const tempo = Number(bpm);
    if (!Number.isFinite(tempo) || tempo < 20 || tempo > 300) {
      setError("BPM 需要在 20 到 300 之间。");
      return;
    }
    submitting.current = true;
    setPending(true);
    setCheckingBeforeUpload(true);
    try {
      // Verify again before creating a project: a ready result can become stale
      // while the user chooses a file or edits settings.
      await service.checkBeforeUpload();
      setCheckingBeforeUpload(false);
      let project = createdProject;
      // A retry first checks whether the earlier request was accepted, preventing duplicate tasks.
      if (project) {
        project = await api.getProject(project.id);
        if (
          project.latestJobId ||
          project.tracks.length ||
          project.status !== "empty"
        ) {
          client.setQueryData(["project", project.id], project);
          await client.invalidateQueries({ queryKey: ["projects"] });
          navigate(`/projects/${encodeURIComponent(project.id)}`);
          return;
        }
      }
      if (!project) {
        project = await api.createProject({
          title: title.trim(),
          bpm: tempo,
          timeSignature: "4/4",
        });
        setCreatedProject(project);
      } else if (project.title !== title.trim() || project.bpm !== tempo) {
        project = await api.saveProject({
          ...project,
          title: title.trim(),
          bpm: tempo,
        });
        setCreatedProject(project);
      }
      const result = await api.uploadAudio(project.id, {
        file,
        mode,
        transcriptionModel,
        drumTranscription,
        separationModel:
          mode === "demucs_basic_pitch" ? separationModel : "htdemucs",
        device: "auto",
        bpm: tempo,
      });
      client.setQueryData(["project", result.project.id], result.project);
      client.setQueryData(["job", result.job.id], result.job);
      await client.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/projects/${encodeURIComponent(result.project.id)}`);
    } catch (cause) {
      setError(getErrorMessage(cause));
      void client.invalidateQueries({ queryKey: ["projects"] });
    } finally {
      submitting.current = false;
      setPending(false);
      setCheckingBeforeUpload(false);
    }
  }

  return (
    <div className="upload-page page-content">
      <header className="page-header">
        <div>
          <Link to="/projects" className="back-link">
            ‹ 返回项目
          </Link>
          <h1>新建转录</h1>
          <p className="page-subtitle">上传一段音乐，开始你的下一份创作。</p>
        </div>
      </header>
      {DEMO && (
        <div className="notice demo-notice">
          <div>
            <strong>当前为演示模式</strong>
            <p>
              示例音符为人工编写，不是 AI
              识别结果。启用本机识别后，才能处理你自己的音频。
            </p>
            {!canEnableRecognition && (
              <p>
                浏览器演示不会启动识别服务，请使用已连接本机服务的应用版本。
              </p>
            )}
          </div>
          <div className="upload-demo-actions">
            {canEnableRecognition && (
              <Button
                disabled={serviceActionPending}
                onClick={() => void enableRecognition()}
              >
                {serviceActionPending ? "正在启用本机识别…" : "启用本机识别"}
              </Button>
            )}
            <Link
              className="button-link secondary"
              to={`/projects/${DEMO_PROJECT_ID}`}
            >
              打开示例
            </Link>
          </div>
        </div>
      )}
      {!DEMO && (
        <section
          className="panel upload-service-status"
          data-state={service.availability.state}
          aria-label="本机识别服务状态"
        >
          <div className="service-copy">
            <div role="status" aria-live="polite" aria-atomic="true">
              <strong>
                <span className="service-state" aria-hidden="true" />
                {service.availability.title}
              </strong>
              <p className="hint">{service.availability.message}</p>
            </div>
            {service.status?.setup && !service.error && (
              <ServiceSetupProgress setup={service.status.setup} />
            )}
            {service.status && !service.error && (
              <ul className="service-capabilities hint" aria-label="识别能力">
                <li>直接识别：{capabilityLabel("transcribeOnly")}</li>
                <li>标准 4 轨：{capabilityLabel("separate4")}</li>
                <li>实验 6 轨：{capabilityLabel("separate6")}</li>
                <li>钢琴专用：{capabilityLabel("pianoTranscription")}</li>
                <li>镲片击打点：{capabilityLabel("cymbalOnsets")}</li>
              </ul>
            )}
            {service.error && (
              <p className="hint">
                {canEnableRecognition
                  ? "应用会尝试启动本机服务。若仍未连接，点击重试可重新启动并检查。"
                  : "请确认本机 API 和识别进程已启动，再重新检查连接。"}
              </p>
            )}
          </div>
          <Button
            variant="secondary"
            disabled={service.isChecking || serviceActionPending || pending}
            onClick={() => void retryService()}
          >
            {serviceActionPending
              ? "正在重试…"
              : service.isChecking
                ? "正在检查…"
                : service.availability.ready
                  ? "重新检查"
                  : "重试连接"}
          </Button>
        </section>
      )}
      <form onSubmit={(event) => void submit(event)} className="upload-form">
        <div
          className={`panel audio-dropzone ${dragging ? "is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!pending) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={dropped}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".wav,.mp3,.flac,audio/wav,audio/mpeg,audio/flac"
            className="sr-only"
            tabIndex={-1}
            aria-label="选择音频文件"
            disabled={pending}
            onChange={changed}
          />
          <div className="upload-symbol" aria-hidden="true">
            ♪
          </div>
          <h2>{file ? file.name : "将音频拖到这里"}</h2>
          {file ? (
            <p className="hint">
              {formatSize(file.size)}
              <span aria-hidden="true"> · </span>
              {duration !== null
                ? formatDuration(duration)
                : readingMetadata
                  ? "正在读取时长…"
                  : "时长将由本机服务读取"}
            </p>
          ) : (
            <p className="hint">
              MP3、WAV 或 FLAC · 最多 100 MB · 最长 30 分钟
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            {file ? "更换音频" : "选择文件"}
          </Button>
          <p className="dropzone-footnote hint">
            单个文件最多 100 MB、最长 30
            分钟。音频保存在本机，不会上传到第三方识别服务。
          </p>
        </div>
        {durationTooLong && (
          <div className="error" role="alert">
            <strong>音频超过 30 分钟</strong>
            <p>
              当前音频时长为 {formatDuration(duration!)}
              。请先截取需要识别的片段，再更换文件。
            </p>
          </div>
        )}
        <section
          className="panel upload-settings"
          aria-labelledby="upload-settings-heading"
        >
          <div className="section-heading">
            <h2 id="upload-settings-heading">处理设置</h2>
            <span className="hint">识别引擎在提交前选择</span>
          </div>
          <div className="form-grid">
            <label className="field field-wide">
              <span>项目名称</span>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                placeholder="为这段旋律起个名字"
                disabled={pending}
                required={!DEMO}
              />
            </label>
            <label className="field">
              <span>BPM</span>
              <Input
                type="number"
                min={20}
                max={300}
                step="any"
                inputMode="decimal"
                value={bpm}
                onChange={(event) => {
                  setBpm(event.target.value);
                  setBpmEdited(true);
                }}
                disabled={pending}
              />
              <span className="hint">
                {bpmEdited ? "手动设置，未自动识别" : "默认值，未自动识别"}
              </span>
            </label>
            <div className="field">
              <span>拍号</span>
              <div className="readonly-field">4/4</div>
              <span className="hint">首版使用 4/4 拍</span>
            </div>
          </div>
          <fieldset className="mode-fieldset" disabled={pending}>
            <legend>识别方式</legend>
            <div className="mode-grid">
              <label
                className={`mode-card ${mode === "demucs_basic_pitch" ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="mode"
                  value="demucs_basic_pitch"
                  checked={mode === "demucs_basic_pitch"}
                  onChange={() => {
                    setMode("demucs_basic_pitch");
                    if (transcriptionModel === "piano_highres")
                      setSeparationModel("htdemucs_6s");
                  }}
                />
                <span>
                  <strong>分轨并识别</strong>
                  <span>适合完整歌曲，分离人声、鼓、贝斯和其他乐器。</span>
                </span>
              </label>
              <label
                className={`mode-card ${mode === "transcribe_only" ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="mode"
                  value="transcribe_only"
                  checked={mode === "transcribe_only"}
                  onChange={() => {
                    setMode("transcribe_only");
                    setDrumTranscription("none");
                  }}
                />
                <span>
                  <strong>直接识别音符</strong>
                  <span>适合独奏或已经分离好的单乐器录音。</span>
                  {!DEMO && (
                    <span>
                      本机状态：
                      {capabilityLabel(
                        transcriptionModel === "piano_highres"
                          ? "pianoTranscription"
                          : "transcribeOnly",
                      )}
                    </span>
                  )}
                </span>
              </label>
            </div>
          </fieldset>
          <fieldset className="mode-fieldset" disabled={pending}>
            <legend>音符识别引擎</legend>
            <div className="mode-grid">
              <label
                className={`mode-card ${transcriptionModel === "basic_pitch" ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="transcriptionModel"
                  value="basic_pitch"
                  checked={transcriptionModel === "basic_pitch"}
                  onChange={() => setTranscriptionModel("basic_pitch")}
                />
                <span>
                  <strong>通用识别 · Basic Pitch</strong>
                  <span>
                    适合多种有音高乐器。钢琴泛音与尾音可能出现误报，生成后需对照原音频校对。
                  </span>
                </span>
              </label>
              <label
                className={`mode-card ${transcriptionModel === "piano_highres" ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="transcriptionModel"
                  value="piano_highres"
                  checked={transcriptionModel === "piano_highres"}
                  onChange={() => {
                    setTranscriptionModel("piano_highres");
                    if (mode === "demucs_basic_pitch")
                      setSeparationModel("htdemucs_6s");
                  }}
                />
                <span>
                  <strong>钢琴专用识别</strong>
                  <span>
                    {mode === "demucs_basic_pitch"
                      ? "自动选择实验 6 轨，对分离后的钢琴使用专用模型；其他有音高轨仍用通用识别。"
                      : "仅用于已知单钢琴录音或已分离的钢琴音频，不会分离其他乐器。"}
                  </span>
                  {!DEMO && (
                    <span>
                      本机状态：{capabilityLabel("pianoTranscription")}
                    </span>
                  )}
                </span>
              </label>
            </div>
          </fieldset>
          {mode === "demucs_basic_pitch" && (
            <fieldset className="mode-fieldset" disabled={pending}>
              <legend>分轨模型</legend>
              <div className="mode-grid">
                <label
                  className={`mode-card ${separationModel === "htdemucs" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="separationModel"
                    value="htdemucs"
                    checked={separationModel === "htdemucs"}
                    disabled={transcriptionModel === "piano_highres"}
                    onChange={() => setSeparationModel("htdemucs")}
                  />
                  <span>
                    <strong>标准 4 轨</strong>
                    <span>
                      固定输出人声、鼓、贝斯和其他四类，不检测实际乐器数量。没有独立钢琴轨，钢琴通常在“其他”中。
                    </span>
                    {transcriptionModel === "piano_highres" && (
                      <span>钢琴专用识别需要 6 轨。</span>
                    )}
                    {!DEMO && (
                      <span>本机状态：{capabilityLabel("separate4")}</span>
                    )}
                  </span>
                </label>
                <label
                  className={`mode-card ${separationModel === "htdemucs_6s" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="separationModel"
                    value="htdemucs_6s"
                    checked={separationModel === "htdemucs_6s"}
                    onChange={() => setSeparationModel("htdemucs_6s")}
                  />
                  <span>
                    <strong>实验 6 轨</strong>
                    <span>
                      需要独立钢琴轨时可尝试此模式。固定增加钢琴与吉他，但不保证分干净，可能串音、漏音或出现杂音。
                    </span>
                    {!DEMO && (
                      <span>本机状态：{capabilityLabel("separate6")}</span>
                    )}
                  </span>
                </label>
              </div>
            </fieldset>
          )}
          {mode === "demucs_basic_pitch" && (
            <label className="field mode-fieldset">
              <span>镲片 MIDI</span>
              <select
                value={drumTranscription}
                disabled={pending}
                onChange={(event) =>
                  setDrumTranscription(
                    event.target.value as typeof drumTranscription,
                  )
                }
              >
                <option value="none">仅保留打击乐音频</option>
                <option value="cymbal_onsets">检测镲片击打点并生成 MIDI</option>
              </select>
              <span className="hint">
                仅在你确认打击乐为镲片时启用。检测击打时间，不区分完整鼓组；默认用
                GM 49 吊镲 1
                试听，可在工程中改音色。短音符长度表示触发，不代表镲片尾音。
              </span>
              {!DEMO && (
                <span className="hint">
                  本机状态：{capabilityLabel("cymbalOnsets")}
                </span>
              )}
            </label>
          )}
          <p className="hint capability-note">
            {mode === "demucs_basic_pitch"
              ? "轨道类别不代表原录音一定包含对应乐器，近乎静音的轨道也会保留。鼓轨包含镲片等打击乐；六轨钢琴与吉他分离为实验功能，结果需要试听校对。"
              : "直接转录不会分离乐器，单乐器录音效果通常更好。"}
          </p>
          {!DEMO && !service.availability.ready && (
            <p className="hint upload-service-hint">
              当前识别方式尚未就绪。你可以先选择音频并填写设置；服务就绪后才能开始。
            </p>
          )}
        </section>
        {error && (
          <div className="error" role="alert">
            <strong>暂时无法继续</strong>
            <p>{error}</p>
            {createdProject && (
              <Link to={`/projects/${createdProject.id}`}>
                查看已创建的项目与任务状态
              </Link>
            )}
          </div>
        )}
        <div className="upload-actions">
          <p className="hint" role="status">
            {checkingBeforeUpload
              ? "正在确认本机识别服务…"
              : pending
                ? "正在上传并等待本机服务接收，请保持页面打开。"
                : readingMetadata
                  ? "正在检查音频时长…"
                  : !DEMO && !service.availability.ready
                    ? "请等待服务就绪，或选择可用的识别方式。"
                    : "模型处理在后台进行，接收后会显示真实进度。"}
          </p>
          <Button
            type="submit"
            disabled={
              pending ||
              DEMO ||
              !service.availability.ready ||
              serviceActionPending ||
              !file ||
              readingMetadata ||
              durationTooLong
            }
          >
            {pending ? "正在提交…" : "上传并开始"}
          </Button>
        </div>
        {DEMO && (
          <p className="hint demo-upload-caption">
            切换到已连接本机后端的模式后，才会启动真实识别。
          </p>
        )}
      </form>
    </div>
  );
}
