"""Real audio separation/transcription adapters; importing this module is cheap.

Model execution is isolated in cancellable subprocesses. No model package is
imported by the API/queue process, and progress represents completed stages or
tracks, never a fabricated estimate of model inference time.
"""

from __future__ import annotations

import importlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Callable
import uuid
import wave


class PipelineError(RuntimeError):
    """An actionable input, dependency, decoder, or model error."""


class PipelineCancelled(PipelineError):
    """The caller cancelled a pipeline; this must not be reported as failure."""


ProgressCallback = Callable[[str, float | None, str], None]
CancelCallback = Callable[[], bool]
MAX_AUDIO_SECONDS = 30 * 60

_STEMS = {
    "vocals": ("人声", "vocal", 53),
    "drums": ("鼓", "drums", 0),
    "bass": ("贝斯", "bass", 33),
    "other": ("其他（混合轨）", "other", 0),
    "piano": ("钢琴（实验分轨）", "piano", 0),
    "guitar": ("吉他（实验分轨）", "guitar", 24),
}


def _check_cancelled(is_cancelled: CancelCallback) -> None:
    if is_cancelled():
        raise PipelineCancelled("任务已取消。")


def _log_tail(path: Path, limit: int = 4000) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            handle.seek(max(0, handle.tell() - limit))
            return handle.read().decode("utf-8", errors="replace").strip()
    except OSError:
        return "无法读取模型日志。"


def _run_process(
    command: list[str],
    log_path: Path,
    is_cancelled: CancelCallback,
    *,
    env: dict[str, str] | None = None,
    label: str = "模型",
) -> None:
    """Drain output to disk and reap the process even on cancellation/errors."""
    _check_cancelled(is_cancelled)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = None
    try:
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            while True:
                _check_cancelled(is_cancelled)
                try:
                    return_code = process.wait(timeout=0.2)
                    break
                except subprocess.TimeoutExpired:
                    continue
            _check_cancelled(is_cancelled)
        if return_code:
            raise PipelineError(
                f"{label}运行失败（退出码 {return_code}）。\n{_log_tail(log_path)}"
            )
    except OSError as exc:
        raise PipelineError(f"无法启动{label}：{exc}") from exc
    finally:
        if process is not None and process.poll() is None:
            try:
                if os.name == "nt":
                    # Windows venv python.exe is a redirector: terminating only
                    # that PID can orphan the actual interpreter (and its open
                    # log handles). Reap this owned tree, children before root.
                    from .process_tree import terminate_windows_process_tree

                    terminate_windows_process_tree(process)
                else:
                    process.terminate()
                process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired) as exc:
                if process.poll() is None:
                    process.kill()
                process.wait()
                if os.name == "nt":
                    # Do not silently claim a redirector-only kill cleaned up
                    # the model. Keep an actionable record alongside its log.
                    message = f"无法确认{label}的子进程树已全部退出：{exc}"
                    log_path.with_suffix(".cleanup.log").write_text(message, encoding="utf-8")
                    raise PipelineError(message) from exc


def _model_environment(output_dir: Path) -> dict[str, str]:
    env = os.environ.copy()
    default_cache = Path(__file__).resolve().parents[2] / "data" / "model-cache"
    cache = Path(env.get("STEMWORK_MODEL_CACHE", str(default_cache))).resolve()
    for name, child in (("TORCH_HOME", "torch"), ("HF_HOME", "huggingface"),
                        ("NUMBA_CACHE_DIR", "numba")):
        path = cache / child
        path.mkdir(parents=True, exist_ok=True)
        env[name] = str(path)
    env["PYTHONUTF8"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    env.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    return env


def _model_python() -> str:
    # Configure this on the server, never accept an executable from an upload.
    return os.environ.get("STEMWORK_MODEL_PYTHON", sys.executable)


def _check_dependencies(
    mode: str, output_dir: Path, env: dict[str, str], is_cancelled: CancelCallback
) -> None:
    modules = ["basic_pitch", "onnxruntime", "soundfile"]
    if mode == "demucs_basic_pitch":
        modules.extend(["demucs", "torch"])
    check = (
        "import importlib.util,sys; "
        f"missing=[m for m in {modules!r} if importlib.util.find_spec(m) is None]; "
        "print('Missing model dependencies: '+', '.join(missing) if missing else 'Model packages found'); "
        "sys.exit(1 if missing else 0)"
    )
    try:
        _run_process([_model_python(), "-c", check], output_dir / "dependencies.log",
                     is_cancelled, env=env, label="依赖检查")
    except PipelineCancelled:
        raise
    except PipelineError as exc:
        raise PipelineError(
            "模型环境未就绪。请按 docs/MODELS.md 安装依赖，并设置 "
            "STEMWORK_MODEL_PYTHON 指向模型环境的 Python。\n" + str(exc)
        ) from exc


def _find_ffmpeg() -> str | None:
    for name in ("STEMWORK_FFMPEG", "IMAGEIO_FFMPEG_EXE"):
        configured = os.environ.get(name)
        if configured:
            candidate = shutil.which(configured)
            if candidate:
                return candidate
            if Path(configured).is_file():
                return configured
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    try:
        imageio_ffmpeg = importlib.import_module("imageio_ffmpeg")
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError, OSError):
        return None


def _wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
    except (OSError, EOFError, wave.Error, ZeroDivisionError) as exc:
        raise PipelineError(f"无法读取解码音频：{exc}") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise PipelineError("音频时长必须大于 0；文件可能为空或已损坏。")
    if duration > MAX_AUDIO_SECONDS:
        raise PipelineError("音频时长不能超过 30 分钟。")
    return duration


def _decode_audio(input_path: Path, destination: Path,
                  is_cancelled: CancelCallback) -> float:
    """Write browser-compatible PCM WAV, preferring soundfile for WAV/FLAC.

Native sample rate is retained on the lossless path. Both model adapters do
their own required resampling. FFmpeg converts other codecs to 44.1 kHz stereo.
The stdlib WAV fallback keeps basic validation usable without model packages.
"""
    _check_cancelled(is_cancelled)
    decode_errors: list[str] = []
    if input_path.suffix.lower() in {".wav", ".flac"}:
        try:
            sf = importlib.import_module("soundfile")
            np = importlib.import_module("numpy")
            with sf.SoundFile(str(input_path)) as source:
                if source.frames <= 0 or source.samplerate <= 0:
                    raise PipelineError("音频时长必须大于 0。")
                if source.frames / source.samplerate > MAX_AUDIO_SECONDS:
                    raise PipelineError("音频时长不能超过 30 分钟。")
                if source.channels not in (1, 2):
                    raise ValueError("多声道音频需要 FFmpeg 下混。")
                with sf.SoundFile(str(destination), "w", samplerate=source.samplerate,
                                  channels=source.channels, subtype="PCM_16") as target:
                    while True:
                        _check_cancelled(is_cancelled)
                        block = source.read(65536, dtype="float32", always_2d=True)
                        if not len(block):
                            break
                        if not bool(np.isfinite(block).all()):
                            raise PipelineError("输入音频包含非有限采样值，无法安全推理。")
                        target.write(block)
            return _wav_duration(destination)
        except PipelineError:
            raise
        except (ImportError, OSError, RuntimeError, ValueError) as exc:
            decode_errors.append(str(exc))

    if input_path.suffix.lower() == ".wav":
        try:
            with wave.open(str(input_path), "rb") as source:
                if source.getnframes() / source.getframerate() > MAX_AUDIO_SECONDS:
                    raise PipelineError("音频时长不能超过 30 分钟。")
                if source.getnchannels() not in (1, 2):
                    raise wave.Error("多声道音频需要 FFmpeg 下混。")
                with wave.open(str(destination), "wb") as target:
                    target.setparams(source.getparams())
                    while True:
                        _check_cancelled(is_cancelled)
                        block = source.readframes(65536)
                        if not block:
                            break
                        target.writeframesraw(block)
            return _wav_duration(destination)
        except PipelineError:
            raise
        except (OSError, EOFError, wave.Error) as exc:
            decode_errors.append(str(exc))

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        detail = "; ".join(decode_errors)[-500:]
        raise PipelineError(
            "无法解码此音频。请安装 FFmpeg/imageio-ffmpeg 或使用有效的 WAV/FLAC 文件。 " + detail
        )
    _run_process(
        [ffmpeg, "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(input_path), "-map", "0:a:0", "-vn", "-ar", "44100",
         "-ac", "2", "-t", str(MAX_AUDIO_SECONDS + 0.1), "-c:a", "pcm_s16le", str(destination)],
        destination.with_suffix(".decode.log"), is_cancelled, label="音频解码",
    )
    return _wav_duration(destination)


def _separate_audio(input_path: Path, output_dir: Path, model: str, device: str,
                    env: dict[str, str], is_cancelled: CancelCallback) -> list[tuple[str, Path]]:
    separated = output_dir / "separated"
    command = [_model_python(), "-m", "demucs", "-n", model, "-o", str(separated),
               "--filename", "{stem}.{ext}", "-j", "0"]
    if device != "auto":
        command.extend(["-d", device])
    command.append(str(input_path))
    _run_process(command, output_dir / "demucs.log", is_cancelled, env=env, label="Demucs 分轨")
    stems = ["vocals", "drums", "bass", "other"]
    if model == "htdemucs_6s":
        stems.extend(["piano", "guitar"])
    results = []
    for stem in stems:
        path = separated / model / f"{stem}.wav"
        if not path.is_file():
            raise PipelineError(f"Demucs 没有生成预期音轨：{stem}。请检查 demucs.log。")
        _wav_duration(path)
        results.append((stem, path.resolve()))
    return results


def _notes_from_events(events: list, duration: float) -> tuple[list[dict], int]:
    notes: list[dict] = []
    invalid = 0
    for event in events:
        try:
            start, end, raw_pitch, amplitude = map(float, event[:4])
            if not all(math.isfinite(x) for x in (start, end, raw_pitch, amplitude)):
                raise ValueError("non-finite note")
            pitch = int(raw_pitch)
            if pitch != raw_pitch or not 0 <= pitch <= 127 or amplitude <= 0:
                raise ValueError("invalid pitch or amplitude")
            start = max(0.0, start)
            end = min(duration, end)
            if end <= start:
                raise ValueError("empty or out-of-range note")
        except (TypeError, ValueError, OverflowError):
            invalid += 1
            continue
        notes.append({
            "id": uuid.uuid4().hex,
            "pitch": pitch,
            "startSeconds": start,
            "durationSeconds": end - start,
            "velocity": max(1, min(127, round(amplitude * 127))),
        })
    notes.sort(key=lambda note: (note["startSeconds"], note["pitch"]))
    return notes, invalid


def _transcribe_audio(audio_path: Path, output_dir: Path, env: dict[str, str],
                      duration: float, bpm: float, is_cancelled: CancelCallback) -> tuple[list[dict], list[str]]:
    result_path = output_dir / f"{audio_path.stem}-{uuid.uuid4().hex}.notes.json"
    child_env = env.copy()
    # Device selection applies to Demucs. Basic Pitch uses the CPU ONNX runtime
    # so native Windows TensorFlow support does not govern CUDA availability.
    child_env["CUDA_VISIBLE_DEVICES"] = "-1"
    command = [_model_python(), str(Path(__file__).resolve()), "--transcribe",
               str(audio_path), str(result_path), str(bpm)]
    _run_process(command, result_path.with_suffix(".log"), is_cancelled,
                 env=child_env, label=f"Basic Pitch（{audio_path.stem}）")
    try:
        events = json.loads(result_path.read_text(encoding="utf-8"))
        if not isinstance(events, list):
            raise ValueError("note events must be a list")
        notes, invalid = _notes_from_events(events, duration)
    except (OSError, ValueError, TypeError) as exc:
        raise PipelineError(f"转录模型返回了无效数据：{exc}") from exc
    warnings = []
    if invalid:
        warnings.append(f"已忽略 {invalid} 个无效或超出音频时长的音符。")
    if not notes:
        warnings.append("模型未识别到可靠音符；音频仍可试听，这不代表原音频没有音乐。")
    return notes, warnings


def _new_track(stem: str, path: Path) -> dict:
    name, kind, program = _STEMS[stem]
    return {
        "id": uuid.uuid4().hex, "name": name, "kind": kind, "program": program,
        "isDrum": kind == "drums", "muted": False, "solo": False,
        "volume": 1.0, "pan": 0.0, "notes": [], "audioPath": str(path.resolve()),
        "transcriptionStatus": "unsupported", "warnings": [],
    }


def _piano_checkpoint(env: dict[str, str]) -> Path:
    cache = Path(env.get("STEMWORK_MODEL_CACHE", str(Path(__file__).resolve().parents[2] / "data/model-cache")))
    return Path(env.get("STEMWORK_PIANO_CHECKPOINT", str(cache / "piano/CRNN_note_F1=0.9677_pedal_F1=0.9186.pth")))


def _transcribe_piano(audio_path: Path, output_dir: Path, env: dict[str, str],
                       duration: float, device: str, is_cancelled: CancelCallback) -> tuple[list[dict], list[str]]:
    result_path = output_dir / f"piano-{uuid.uuid4().hex}.notes.json"
    checkpoint = _piano_checkpoint(env)
    if not checkpoint.is_file():
        raise PipelineError("钢琴专用模型权重未安装，请按 docs/MODELS.md 配置 STEMWORK_PIANO_CHECKPOINT。")
    executable = env.get("STEMWORK_PIANO_PYTHON") or _model_python()
    _run_process([executable, "-m", "stemwork.piano_transcription", str(audio_path),
                  str(result_path), str(checkpoint), device], result_path.with_suffix(".log"),
                 is_cancelled, env=env, label="钢琴专用转录")
    try:
        events = json.loads(result_path.read_text(encoding="utf-8"))
        if not isinstance(events, list):
            raise ValueError("Expected note events")
        notes, invalid = _notes_from_events(events, duration)
    except (OSError, ValueError, TypeError) as exc:
        raise PipelineError(f"钢琴模型返回无效数据：{exc}") from exc
    warnings = ["钢琴专用模型预测；音符长度为估计的按键时值，踏板余响与真实音频尾音可能不同，仍需试听核对。"]
    if invalid:
        warnings.append(f"已忽略 {invalid} 个无效或超出时长的预测。")
    if not notes:
        warnings.append("钢琴专用模型未得到音符；原分轨音频仍保留。")
    return notes, warnings


def _run_pipeline(
    input_path: Path,
    output_dir: Path,
    options: dict,
    on_progress: ProgressCallback,
    on_track: Callable[[dict], None],
    is_cancelled: CancelCallback,
) -> dict:
    """Run real models and return the public track contract.

    One failed pitched track is retained with a warning. If every pitched track
    fails, raise PipelineError after publishing the partial tracks. A completed
    empty transcription is legitimate (for example, silence), never fabricated.
    """
    _check_cancelled(is_cancelled)
    mode = options.get("mode", "demucs_basic_pitch")
    model = options.get("separationModel", "htdemucs")
    device = options.get("device", "auto")
    transcription_model = options.get("transcriptionModel", "basic_pitch")
    drum_transcription = options.get("drumTranscription", "none")
    if mode not in {"demucs_basic_pitch", "transcribe_only"}:
        raise PipelineError("不支持的处理模式。")
    if model not in {"htdemucs", "htdemucs_6s"}:
        raise PipelineError("不支持的分轨模型。")
    if device not in {"auto", "cpu", "cuda"}:
        raise PipelineError("设备必须是 auto、cpu 或 cuda。")
    if transcription_model not in {"basic_pitch", "piano_highres"} or drum_transcription not in {"none", "cymbal_onsets"}:
        raise PipelineError("不支持的音符或鼓点识别方式。")
    if mode == "demucs_basic_pitch" and transcription_model == "piano_highres" and model != "htdemucs_6s":
        raise PipelineError("钢琴专用转录在分轨模式下需要六轨模型。")
    if mode == "transcribe_only" and drum_transcription != "none":
        raise PipelineError("镲片击打点提取需要先分离鼓音轨。")
    try:
        bpm = float(options.get("bpm", 120))
    except (TypeError, ValueError, OverflowError) as exc:
        raise PipelineError("BPM 必须是大于 0 的有限数值。") from exc
    if not math.isfinite(bpm) or bpm <= 0:
        raise PipelineError("BPM 必须是大于 0 的有限数值。")
    input_path = Path(input_path).resolve()
    if not input_path.is_file() or input_path.stat().st_size == 0:
        raise PipelineError("输入音频不存在或为空。")

    # Each attempt has its own directory: retries never consume stale stems.
    attempt = Path(output_dir).resolve() / f"run-{uuid.uuid4().hex}"
    attempt.mkdir(parents=True, exist_ok=False)
    env = _model_environment(attempt)
    if transcription_model == "piano_highres" and not _piano_checkpoint(env).is_file():
        raise PipelineError("钢琴专用模型权重未就绪，请安装模型并配置 STEMWORK_PIANO_CHECKPOINT 后重试。")
    warnings = ["BPM 使用用户设定值（未填写时为 120），当前未进行自动节拍检测。",
                "音符为模型初步转录，尚未进行节拍量化、乐谱排版或弯音编辑。"]
    on_progress("decode", None, "校验模型环境并解码音频。")
    _check_dependencies(mode, attempt, env, is_cancelled)
    prepared = attempt / "input.wav"
    duration = _decode_audio(input_path, prepared, is_cancelled)
    _check_cancelled(is_cancelled)
    from stemwork.audio_analysis import analyse_track, measure_pcm

    check_cancelled = lambda: _check_cancelled(is_cancelled)
    original_levels = measure_pcm(prepared, check_cancelled)

    if mode == "demucs_basic_pitch":
        on_progress("separate", None, "Demucs 正在分离音轨；首次运行可能需要下载权重。")
        sources = _separate_audio(prepared, attempt, model, device, env, is_cancelled)
        warnings.append("轨道名称是分离模型的固定输出类别，不代表已检测到对应乐器；鼓轨也包含镲片等打击乐。")
        if model == "htdemucs_6s":
            warnings.append("六轨分离为实验功能，尤其钢琴可能存在串音、漏音和伪影。")
        else:
            warnings.append("四轨模型没有独立钢琴输出；钢琴通常进入其他（混合轨）。如需单独钢琴轨，请新建项目选择实验六轨。")
    else:
        sources = [("piano" if transcription_model == "piano_highres" else "other", prepared)]
        warnings.append("本次仅转录原始音频；未进行分轨，最适合单件乐器录音。")

    tracks = []
    failures = []
    completed_pitched = 0
    for index, (stem, audio_path) in enumerate(sources):
        _check_cancelled(is_cancelled)
        track = _new_track(stem, audio_path)
        levels = original_levels if audio_path == prepared else measure_pcm(audio_path, check_cancelled)
        track["analysis"] = analysis = analyse_track(levels, original_levels)
        if mode == "transcribe_only":
            track["name"] = "钢琴（直接转录）" if transcription_model == "piano_highres" else "原始音频（未分轨）"
        on_progress("transcribe", index / len(sources),
                    f"正在处理{track['name']}（{index + 1}/{len(sources)}）。")
        if stem == "drums":
            if drum_transcription == "cymbal_onsets":
                from stemwork.cymbal_onsets import detect_cymbal_hits

                try:
                    notes, drum_warnings = detect_cymbal_hits(audio_path, min(duration, _wav_duration(audio_path)), is_cancelled)
                    track.update(notes=notes, transcriptionStatus="completed", transcriptionEngine="cymbal_onsets",
                                 name="镲片击打点（实验）")
                    track["warnings"].extend(drum_warnings)
                except PipelineCancelled:
                    raise
                except Exception as exc:
                    track["transcriptionStatus"] = "failed"
                    failures.append(f"镲片击打点提取失败，鼓音频仍保留：{exc}")
                    track["warnings"].append(failures[-1])
            else:
                track["warnings"].append("鼓音频含镲片等打击乐。此次未启用镲片击打点提取，MIDI 中没有鼓点。")
        else:
            if stem == "other" and mode != "transcribe_only":
                track["warnings"].append("这是剩余乐器混合轨，不等于单一乐器，识别结果可能混杂。")
            try:
                track_duration = min(duration, _wav_duration(audio_path))
                if analysis["lowSignal"]:
                    analysis["autoTranscriptionSkipped"] = True
                    track["warnings"].append(
                        f"此轨近乎静音（平均 {analysis['rmsDbfs']:.1f} dBFS），已跳过自动音符识别以减少残留误报。"
                        "音频仍保留；低电平不能证明没有对应乐器，可试听或手动添加音符。"
                    )
                else:
                    piano = stem == "piano" and transcription_model == "piano_highres"
                    if piano:
                        notes, track_warnings = _transcribe_piano(audio_path, attempt, env, track_duration, device, is_cancelled)
                    else:
                        notes, track_warnings = _transcribe_audio(audio_path, attempt, env, track_duration, bpm, is_cancelled)
                    track["transcriptionEngine"] = "piano_highres" if piano else "basic_pitch"
                    track["notes"] = notes
                    track["warnings"].extend(track_warnings)
                    completed_pitched += 1
                track["transcriptionStatus"] = "completed"
            except PipelineCancelled:
                raise
            except PipelineError as exc:
                track["transcriptionStatus"] = "failed"
                message = f"{track['name']}转录失败，分轨音频已保留：{exc}"
                track["warnings"].append(message)
                failures.append(message)
        _check_cancelled(is_cancelled)
        tracks.append(track)
        on_track(track)
        on_progress("transcribe", (index + 1) / len(sources),
                    f"已处理 {index + 1}/{len(sources)} 条音轨。")

    warnings.extend(failures)
    if failures and not completed_pitched:
        raise PipelineError("所有有音高音轨均转录失败。\n" + "\n".join(failures))
    _check_cancelled(is_cancelled)
    on_progress("done", 1.0, "分轨与音符转录处理完成。")
    return {"tracks": tracks, "bpm": bpm, "durationSeconds": duration, "warnings": warnings}


def run_pipeline(
    input_path: Path,
    output_dir: Path,
    options: dict,
    on_progress: ProgressCallback,
    on_track: Callable[[dict], None],
    is_cancelled: CancelCallback,
) -> dict:
    """Public adapter: all processing failures have a stable exception type."""
    try:
        return _run_pipeline(input_path, output_dir, options, on_progress, on_track, is_cancelled)
    except PipelineError:
        raise
    except Exception as exc:
        raise PipelineError(f"音频处理失败：{exc}") from exc


def _basic_pitch_worker(audio_path: Path, result_path: Path, bpm: float) -> None:
    """Private subprocess entry point; imports and inference happen only here."""
    import basic_pitch
    from basic_pitch.inference import Model, predict

    model_path = basic_pitch.build_icassp_2022_model_path(basic_pitch.FilenameSuffix.onnx)
    if not model_path.is_file():
        raise PipelineError("Basic Pitch 安装包缺少 ONNX 权重，请重新安装 basic-pitch==0.4.0。")
    model = Model(model_path)
    _, _, events = predict(str(audio_path), model_or_model_path=model, midi_tempo=bpm)
    serializable = [[float(event[0]), float(event[1]), int(event[2]), float(event[3])]
                    for event in events]
    temporary = result_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(serializable, allow_nan=False), encoding="utf-8")
    temporary.replace(result_path)


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] != "--transcribe":
        raise SystemExit("Private entry point: --transcribe AUDIO RESULT_JSON BPM")
    _basic_pitch_worker(Path(sys.argv[2]), Path(sys.argv[3]), float(sys.argv[4]))
