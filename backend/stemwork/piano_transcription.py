"""Explicit opt-in piano transcription using the author's high-resolution model.

Run in an isolated model process, not the API process. Model dependencies are
lazy, weights are verified before loading, and this module never downloads them.
The upstream frame/onset/offset decoder and its default thresholds are preserved.
Only note events are returned: the current editor has no sustain-pedal contract.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import sys


CHECKPOINT_FILENAME = "CRNN_note_F1=0.9677_pedal_F1=0.9186.pth"
CHECKPOINT_BYTES = 171966578
CHECKPOINT_SHA256 = "c3fa9730725bf4a762f1c14bc80cd5986eacda01b026f5a4a2525cd607876141"
CHECKPOINT_URL = (
    "https://zenodo.org/record/4034264/files/"
    "CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
)


def resolve_checkpoint(explicit: str | Path | None = None) -> Path:
    """Resolve a server-owned path; never download in response to an upload."""
    if explicit:
        return Path(explicit).expanduser().resolve()
    configured = os.environ.get("STEMWORK_PIANO_CHECKPOINT")
    if configured:
        return Path(configured).expanduser().resolve()
    default_cache = Path(__file__).resolve().parents[2] / "data" / "model-cache"
    cache = Path(os.environ.get("STEMWORK_MODEL_CACHE", str(default_cache)))
    return (cache / "piano" / CHECKPOINT_FILENAME).resolve()


def verify_checkpoint(path: Path) -> None:
    if not path.is_file():
        raise RuntimeError(
            "钢琴专用模型权重未安装。请从官方 Zenodo 4034264 下载权重，"
            "并设置 STEMWORK_PIANO_CHECKPOINT；识别任务不会自动下载。"
        )
    if path.stat().st_size != CHECKPOINT_BYTES:
        raise RuntimeError("钢琴模型权重大小不正确，可能未下载完整；请重新校验官方文件。")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != CHECKPOINT_SHA256:
        raise RuntimeError("钢琴模型权重 SHA-256 校验失败，拒绝加载未验证的文件。")


def _read_weights(torch_module, path: Path):
    # Never retry with unsafe pickle loading or change torch.load globally.
    checkpoint = torch_module.load(str(path), map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, dict) or not isinstance(checkpoint.get("model"), dict):
        raise RuntimeError("钢琴模型权重内容无效。")
    return checkpoint["model"]


def _load_transcriber(path: Path, device: str):
    verify_checkpoint(path)
    if device not in {"auto", "cpu", "cuda"}:
        raise RuntimeError("钢琴模型设备必须是 auto、cpu 或 cuda。")
    try:
        import torch
        from piano_transcription_inference import PianoTranscription
        from piano_transcription_inference.models import Note_pedal
    except ImportError as exc:
        raise RuntimeError("钢琴专用模型依赖未安装，请在钢琴模型环境安装 requirements-piano.txt。") from exc
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("钢琴模型选择了 CUDA，但该模型环境未检测到可用 GPU。")
    torch.set_num_threads(min(4, os.cpu_count() or 1))

    # The upstream constructor auto-downloads with wget and leaves torch.load
    # safety implicit. Initialize its documented model/settings directly, then
    # reuse its unchanged transcribe/deframe and regression postprocessor.
    transcriber = PianoTranscription.__new__(PianoTranscription)
    transcriber.segment_samples = 16000 * 10
    transcriber.frames_per_second = 100
    transcriber.classes_num = 88
    transcriber.onset_threshold = 0.3
    transcriber.offset_threshod = 0.3  # Attribute spelling is defined upstream.
    transcriber.frame_threshold = 0.1
    transcriber.pedal_offset_threshold = 0.2
    transcriber.model = Note_pedal(frames_per_second=100, classes_num=88)
    transcriber.model.load_state_dict(_read_weights(torch, path), strict=True)
    transcriber.model.to(device)
    transcriber.model.eval()
    return transcriber


def _note_events(events, duration: float) -> list[list[float | int]]:
    """Convert model output to the existing event contract without cleanup."""
    result = []
    for event in events:
        onset = float(event["onset_time"])
        offset = float(event["offset_time"])
        pitch = float(event["midi_note"])
        velocity = float(event["velocity"])
        if not all(math.isfinite(v) for v in (onset, offset, pitch, velocity)):
            raise RuntimeError("钢琴模型返回非有限音符数据。")
        if pitch != int(pitch) or not 21 <= pitch <= 108 or not 0 <= velocity <= 127:
            raise RuntimeError("钢琴模型返回超出范围的音高或力度。")
        # The upstream decoder includes zero-padded final frames. Bound events
        # to the actual recording, with no minimum duration or quantization.
        onset, offset = max(0.0, onset), min(duration, offset)
        if offset > onset and velocity > 0:
            result.append([onset, offset, int(pitch), velocity / 127.0])
    return sorted(result, key=lambda event: (event[0], event[2]))


def transcribe(audio_path: Path, result_path: Path,
               checkpoint_path: Path | None = None, device: str = "auto") -> list:
    checkpoint_path = resolve_checkpoint(checkpoint_path)
    # Upstream imports plotting support even during inference; keep its cache
    # within the task directory rather than a user's home directory.
    result_path.parent.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(result_path.parent / "matplotlib-cache"))
    verify_checkpoint(checkpoint_path)
    try:
        import librosa
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("钢琴专用模型解码依赖未安装，请安装 requirements-piano.txt。") from exc
    audio, sample_rate = librosa.load(str(audio_path), sr=16000, mono=True)
    duration = len(audio) / sample_rate
    if not len(audio) or not np.isfinite(audio).all() or duration > 30 * 60:
        raise RuntimeError("钢琴模型输入必须是非空、有限且不超过 30 分钟的音频。")
    transcriber = _load_transcriber(checkpoint_path, device)
    result = transcriber.transcribe(audio, None)
    events = _note_events(result["est_note_events"], duration)
    temporary = result_path.with_suffix(result_path.suffix + ".tmp")
    temporary.write_text(json.dumps(events, allow_nan=False), encoding="utf-8")
    temporary.replace(result_path)
    if result.get("est_pedal_events"):
        print("Pedal events were predicted; the editor note JSON does not include pedal events.", flush=True)
    return events


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 4:
        print("Usage: python -m stemwork.piano_transcription AUDIO RESULT_JSON CHECKPOINT DEVICE", file=sys.stderr)
        return 2
    try:
        transcribe(Path(args[0]), Path(args[1]), Path(args[2]) if args[2] else None, args[3])
    except Exception as exc:
        print(f"钢琴专用转录失败：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
