"""Cheap model-environment checks and independently refreshed worker liveness.

Only the worker probes its configured model interpreter. API requests read small
atomic snapshots; they never import model libraries or start a probe process.
"""
from __future__ import annotations

import importlib.util
import json
import logging
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
from typing import Callable, Literal
import uuid

from pydantic import Field

from .models import Contract

log = logging.getLogger("stemwork.service_status")
HEARTBEAT_INTERVAL_SECONDS = 2.0
HEARTBEAT_STALE_SECONDS = 15.0
PROBE_TIMEOUT_SECONDS = 15.0
TRANSCRIPTION_MODULES = (
    "basic_pitch", "onnxruntime", "soundfile", "numpy", "librosa", "resampy", "pkg_resources",
)
SEPARATION_MODULES = ("demucs", "torch", "sphn")


class ServiceCapabilities(Contract):
    transcribeOnly: bool = False
    separate4: bool = False
    separate6: bool = False
    pianoTranscription: bool = False
    cymbalOnsets: bool = False


def _piano_available() -> bool:
    from .pipeline import _piano_checkpoint

    if not _piano_checkpoint(os.environ).is_file():
        return False
    executable = os.environ.get("STEMWORK_PIANO_PYTHON") or os.environ.get("STEMWORK_MODEL_PYTHON") or sys.executable
    script = "import importlib.util,sys; sys.exit(0 if all(importlib.util.find_spec(m) for m in ('piano_transcription_inference','torchlibrosa','torch','librosa')) else 1)"
    try:
        result = subprocess.run([executable, "-c", script], stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=PROBE_TIMEOUT_SECONDS,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class SystemStatus(Contract):
    status: Literal["ready", "starting", "unavailable"]
    apiReady: bool = True
    workerReady: bool = False
    capabilities: ServiceCapabilities = Field(default_factory=ServiceCapabilities)
    message: str


def _status_directory(root: Path) -> Path:
    return Path(root).resolve() / ".worker-status"


def _ffmpeg_available() -> bool:
    """Decoder runs in the worker environment, not the external model Python."""
    for name in ("STEMWORK_FFMPEG", "IMAGEIO_FFMPEG_EXE"):
        configured = os.environ.get(name)
        if configured and (shutil.which(configured) or Path(configured).is_file()):
            return True
    if shutil.which("ffmpeg"):
        return True
    try:
        spec = importlib.util.find_spec("imageio_ffmpeg")
        return bool(spec and any(
            path.is_file()
            for location in spec.submodule_search_locations or ()
            for path in (Path(location) / "binaries").glob("ffmpeg*")
        ))
    except (ImportError, ValueError, OSError):
        return False


def probe_model_environment() -> dict:
    """Find top-level packages in the exact inference Python, without importing.

    This checks installation, not GPU operation or model accuracy. Missing cached
    weights are deliberately not a failure: the adapters can fetch them later.
    """
    modules = (*TRANSCRIPTION_MODULES, *SEPARATION_MODULES)
    script = (
        "import importlib.util,json; "
        f"print(json.dumps({{m: importlib.util.find_spec(m) is not None for m in {modules!r}}}))"
    )
    executable = os.environ.get("STEMWORK_MODEL_PYTHON") or sys.executable
    try:
        completed = subprocess.run(
            [executable, "-c", script], stdin=subprocess.DEVNULL,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=PROBE_TIMEOUT_SECONDS, env={**os.environ, "PYTHONUTF8": "1"},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode != 0:
            return {"capabilities": ServiceCapabilities().model_dump(),
                    "message": "识别进程的模型环境检查失败，请检查 STEMWORK_MODEL_PYTHON 指定的 Python 环境并重启识别进程。"}
        found = json.loads(completed.stdout.strip())
        if not isinstance(found, dict) or any(type(found.get(name)) is not bool for name in modules):
            raise ValueError("Invalid probe output")
    except subprocess.TimeoutExpired:
        return {"capabilities": ServiceCapabilities().model_dump(),
                "message": "识别环境检查超时，请确认模型 Python 环境可以启动，再重启识别进程。"}
    except (OSError, ValueError, TypeError):
        return {"capabilities": ServiceCapabilities().model_dump(),
                "message": "无法检查识别环境，请确认 STEMWORK_MODEL_PYTHON 指向可运行的 Python，再重启识别进程。"}

    missing_transcription = [name for name in TRANSCRIPTION_MODULES if not found[name]]
    missing_separation = [name for name in SEPARATION_MODULES if not found[name]]
    transcribe = not missing_transcription
    separate = transcribe and not missing_separation
    capabilities = ServiceCapabilities(transcribeOnly=transcribe, separate4=separate, separate6=separate,
                                       pianoTranscription=transcribe and _piano_available(), cymbalOnsets=separate)
    if missing_transcription:
        message = "音符识别缺少必要组件：" + "、".join(missing_transcription) + "。请按 docs/MODELS.md 安装到模型 Python 环境，再重启识别进程。"
    elif missing_separation:
        message = "音符识别已就绪；四轨和六轨分离缺少必要组件：" + "、".join(missing_separation) + "。安装后请重启识别进程。"
    else:
        message = "本机识别已就绪，可识别音符并分离四轨或六轨。"
    if transcribe:
        if capabilities.pianoTranscription:
            message += "钢琴专用转录已就绪。"
        message += "首次使用某个模型时可能需要联网下载权重。"
        if not _ffmpeg_available():
            worker_lossless = all(importlib.util.find_spec(name) is not None for name in ("soundfile", "numpy"))
            if worker_lossless:
                message += " 音频解码组件 FFmpeg 尚未安装，MP3 或特殊编码可能无法读取；请安装 imageio-ffmpeg/FFmpeg。"
            else:
                message += " 音频解码组件不完整，目前只能尝试标准 WAV；请在识别进程的环境中安装 imageio-ffmpeg/FFmpeg 或 soundfile、numpy。"
    return {"capabilities": capabilities.model_dump(), "message": message}


class WorkerHeartbeat:
    """One file per worker avoids one process removing another's live heartbeat."""

    def __init__(self, root: Path, *, interval: float = HEARTBEAT_INTERVAL_SECONDS,
                 probe: Callable[[], dict] = probe_model_environment):
        self.directory = _status_directory(root)
        self.path = self.directory / f"{uuid.uuid4().hex}.json"
        self.interval = interval
        self.probe = probe
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state = {
            "version": 1, "pid": os.getpid(), "phase": "starting",
            "capabilities": ServiceCapabilities().model_dump(),
            "message": "本机识别正在准备，请稍候。",
        }

    def _publish(self):
        with self._lock:
            snapshot = {**self._state, "heartbeatAt": time.time()}
            temporary = self.path.with_suffix(f".{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_text(json.dumps(snapshot, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                os.replace(temporary, self.path)
            finally:
                temporary.unlink(missing_ok=True)

    def _beat(self):
        while not self._stop.wait(self.interval):
            try:
                self._publish()
            except OSError:
                # An unwritable snapshot expires rather than claiming readiness.
                log.exception("Cannot refresh worker service heartbeat")

    def __enter__(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        self._publish()
        self._thread = threading.Thread(target=self._beat, name="worker-service-heartbeat", daemon=True)
        self._thread.start()
        try:
            result = self.probe()
            capabilities = ServiceCapabilities.model_validate(result["capabilities"]).model_dump()
            with self._lock:
                self._state.update(phase="checked", capabilities=capabilities,
                                   message=str(result["message"])[:2000])
            self._publish()
            return self
        except BaseException:
            self.close()
            raise

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=max(1, self.interval + 1))
        self.path.unlink(missing_ok=True)

    def __exit__(self, exc_type, exc, traceback):
        self.close()


def get_system_status(root: Path, *, now: float | None = None,
                      stale_seconds: float = HEARTBEAT_STALE_SECONDS) -> SystemStatus:
    """Advertise only capabilities common to active workers that can claim jobs."""
    current_time = time.time() if now is None else now
    active = []
    try:
        paths = list(_status_directory(root).glob("*.json"))
    except OSError:
        paths = []
    for path in paths:
        try:
            if path.stat().st_size > 16384:
                continue
            snapshot = json.loads(path.read_text(encoding="utf-8"))
            timestamp = snapshot["heartbeatAt"]
            if type(timestamp) not in (int, float) or not math.isfinite(timestamp):
                continue
            age = current_time - timestamp
            if age < -2 or age > stale_seconds or snapshot.get("version") != 1:
                continue
            if snapshot.get("phase") not in {"starting", "checked"}:
                continue
            raw_capabilities = snapshot["capabilities"]
            if not isinstance(raw_capabilities, dict) or any(
                type(raw_capabilities.get(name)) is not bool for name in ("transcribeOnly", "separate4", "separate6")
            ):
                continue
            # An older live worker remains valid, but cannot claim new abilities.
            for name in ("pianoTranscription", "cymbalOnsets"):
                raw_capabilities.setdefault(name, False)
            if any(type(raw_capabilities.get(name)) is not bool for name in ServiceCapabilities.model_fields):
                continue
            if not isinstance(snapshot.get("message"), str):
                continue
            active.append(snapshot)
        except (OSError, ValueError, TypeError, KeyError):
            continue
    if not active:
        return SystemStatus(status="unavailable", message="本机服务已连接，但识别进程未运行或暂时失去响应。请启动识别服务后重试。")
    checked = [snapshot for snapshot in active if snapshot["phase"] == "checked"]
    if not checked:
        return SystemStatus(status="starting", workerReady=True,
                            message="本机识别正在准备，请稍候。")
    capabilities = ServiceCapabilities(**{
        key: all(snapshot["capabilities"][key] for snapshot in checked)
        for key in ServiceCapabilities.model_fields
    })
    ready = capabilities.transcribeOnly
    messages = list(dict.fromkeys(snapshot["message"] for snapshot in checked))
    message = " ".join(messages)
    if len(checked) > 1:
        message = "检测到多个识别进程，当前仅提供它们均支持的功能。 " + message
    return SystemStatus(status="ready" if ready else "unavailable", workerReady=True,
                        capabilities=capabilities, message=message)
