"""Opt-in attack markers for a stem the user has identified as cymbals.

This is envelope segmentation, not a drum/instrument classifier. PCM samples
remain unchanged. The standard-library reader keeps this lightweight adapter
usable in the API worker without importing the separate model environment.
"""

from __future__ import annotations

from array import array
import math
from pathlib import Path
import sys
from typing import Callable
import uuid
import wave

FRAME_SECONDS = 0.005
ABSOLUTE_RMS_FLOOR = 10 ** (-90 / 20)
RELATIVE_RMS_GATE = 0.03
RELEASE_PEAK_RATIO = 0.06
QUIET_RESET_SECONDS = 0.065
MIDI_TRIGGER_SECONDS = 0.1
CYMBAL_PITCH = 49


def _rms(block: bytes, width: int) -> float:
    if width == 1:
        return math.sqrt(sum((sample - 128) ** 2 for sample in block) / len(block)) / 128
    if width in (2, 4):
        samples = array("h" if width == 2 else "i")
        samples.frombytes(block)
        if sys.byteorder != "little":
            samples.byteswap()
        return math.sqrt(sum(sample * sample for sample in samples) / len(samples)) / (2 ** (width * 8 - 1))
    # Packed signed PCM24 has no matching array type.
    values = [int.from_bytes(block[offset:offset + 3], "little", signed=True)
              for offset in range(0, len(block), 3)]
    return math.sqrt(sum(sample * sample for sample in values) / len(values)) / (2 ** 23)


def detect_cymbal_hits(
    audio_path: Path,
    duration: float,
    is_cancelled: Callable[[], bool],
) -> tuple[list[dict], list[str]]:
    """Return MIDI trigger notes and explicit limitations for known-cymbal audio.

    A 5 ms RMS envelope combines channel energy without phase cancellation.
    The entry gate is the largest of a -90 dBFS floor, 3% of this stem's peak
    RMS, and six times its lower-quintile noise floor. Hysteresis waits for
    65 ms below an adaptive release threshold, capped at half the entry gate,
    before another hit may start. This prevents a ringing/double-peaked tail
    from being labelled as repeated strikes.

    This deliberately merges some overlapping strikes; a strong piano leak
    can also cross the gate. Neither output notes nor velocity are confidence
    scores. Velocity follows sqrt(local RMS peak / largest RMS peak), while
    a 100 ms MIDI note duration is only a trigger, never the cymbal tail.
    """
    # Import at call time so pipeline can import this adapter without a cycle.
    from .pipeline import PipelineCancelled, PipelineError

    def check_cancelled() -> None:
        if is_cancelled():
            raise PipelineCancelled("任务已取消。")

    check_cancelled()
    if not math.isfinite(duration) or duration <= 0:
        raise PipelineError("镲片击打检测需要有效的音频时长。")
    envelope: list[float] = []
    try:
        with wave.open(str(audio_path), "rb") as source:
            rate, channels, width = source.getframerate(), source.getnchannels(), source.getsampwidth()
            if rate <= 0 or channels <= 0 or width not in (1, 2, 3, 4):
                raise PipelineError("镲片击打检测需要有效的 PCM WAV 音频。")
            frame_samples = max(1, round(rate * FRAME_SECONDS))
            step = frame_samples / rate
            total = min(source.getnframes(), max(0, math.floor(duration * rate)))
            remaining = total
            while remaining > 0:
                check_cancelled()
                count = min(frame_samples, remaining)
                block = source.readframes(count)
                if not block:
                    break
                if len(block) % (width * channels):
                    raise PipelineError("镲片音频包含不完整的 PCM 采样。")
                envelope.append(_rms(block, width))
                remaining -= len(block) // (width * channels)
            actual_duration = (total - remaining) / rate
    except (OSError, EOFError, wave.Error) as exc:
        raise PipelineError(f"无法读取镲片音频：{exc}") from exc

    warnings = [
        "实验镲片击打提取：按用户已知镲片生成触发点，未自动识别镲片种类；暂用 GM 49 吊镲映射，可调整。",
        "鼓点的 0.1 秒时值仅用于 MIDI 触发，不代表真实镲片尾音；强度由局部包络相对映射，原音频保持不变。",
        "弱击打或尾音重叠的相邻击打可能漏检，钢琴等串音可能误检；请结合原音频检查击打点。",
    ]
    peak = max(envelope, default=0.0)
    if peak < ABSOLUTE_RMS_FLOOR:
        warnings.append("未检测到超过噪声门限的清晰击打，未生成占位鼓点。")
        return [], warnings
    ordered = sorted(envelope)
    noise = ordered[min(len(ordered) - 1, int((len(ordered) - 1) * 0.2))]
    gate = max(ABSOLUTE_RMS_FLOOR, peak * RELATIVE_RMS_GATE, noise * 6)
    quiet_frames = max(1, math.ceil(QUIET_RESET_SECONDS / step))
    events: list[tuple[int, float]] = []
    active_start: int | None = None
    active_peak = 0.0
    below = 0
    for index, level in enumerate(envelope):
        check_cancelled()
        if active_start is None:
            if level >= gate:
                active_start, active_peak, below = index, level, 0
            continue
        active_peak = max(active_peak, level)
        # Release must stay BELOW the entry gate. Otherwise a decaying tail
        # could finish one event and immediately satisfy the next entry gate.
        release = min(gate * 0.5, max(ABSOLUTE_RMS_FLOOR * 0.5,
                                    noise * 2, active_peak * RELEASE_PEAK_RATIO))
        below = below + 1 if level < release else 0
        if below >= quiet_frames:
            events.append((active_start, active_peak))
            active_start, active_peak, below = None, 0.0, 0
    if active_start is not None:
        events.append((active_start, active_peak))

    notes = []
    for index, event_peak in events:
        check_cancelled()
        start = index * step
        length = min(MIDI_TRIGGER_SECONDS, actual_duration - start, duration - start)
        if length <= 0:
            continue
        notes.append({
            "id": uuid.uuid4().hex,
            "pitch": CYMBAL_PITCH,
            "startSeconds": start,
            "durationSeconds": length,
            "velocity": max(1, min(127, round(127 * math.sqrt(event_peak / peak)))),
        })
    if not notes:
        warnings.append("未检测到超过噪声门限的清晰击打，未生成占位鼓点。")
    return notes, warnings
