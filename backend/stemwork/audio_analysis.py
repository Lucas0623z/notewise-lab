"""Conservative signal checks on unnormalised PCM, not instrument detection.

Retain every audio file. Only skip automatic pitch inference on near-silent
residuals; weak original recordings and short, audible transients are protected.
The thresholds deliberately leave ambiguous stems for the user to audition.
"""

from array import array
from dataclasses import dataclass
import math
from pathlib import Path
import sys
from typing import Callable
import wave


def dbfs(amplitude: float) -> float:
    # JSON/Pydantic must never receive -Infinity, including digital silence.
    return 20 * math.log10(max(amplitude, 1e-12))


@dataclass(frozen=True)
class AudioLevels:
    rms: float
    peak: float
    loudest_window_rms: float


def measure_pcm(path: Path, check_cancelled: Callable[[], None]) -> AudioLevels:
    """Stream 100 ms windows; combine channel energies without phase cancellation.

    The pipeline decodes to PCM WAV before this function. NumPy accelerates
    model installations, while the stdlib path keeps lightweight installs usable.
    """
    try:
        import numpy as np
    except ImportError:
        np = None
    energy = 0.0
    count = 0
    peak = 0.0
    window_peak = 0.0
    with wave.open(str(path), "rb") as source:
        width = source.getsampwidth()
        if width not in (1, 2, 3, 4):
            raise ValueError("不支持的 PCM 采样格式。")
        window_frames = max(1, round(source.getframerate() * 0.1))
        while True:
            check_cancelled()
            raw = source.readframes(window_frames)
            if not raw:
                break
            scale = float(1 << (width * 8 - 1))
            if np is not None and width != 3:
                samples = np.frombuffer(raw, dtype={1: "u1", 2: "<i2", 4: "<i4"}[width]).astype(np.float64)
                if width == 1:
                    samples -= 128
                samples /= scale
                square_sum = float(np.dot(samples, samples))
                block_peak = float(np.max(np.abs(samples)))
            else:
                if width in (2, 4):
                    integers = array("h" if width == 2 else "i")
                    integers.frombytes(raw)
                    if sys.byteorder != "little":
                        integers.byteswap()
                elif width == 1:
                    integers = [v - 128 for v in raw]
                else:
                    integers = [int.from_bytes(raw[i:i + 3], "little", signed=True)
                                for i in range(0, len(raw), 3)]
                samples = [v / scale for v in integers]
                square_sum = sum(v * v for v in samples)
                block_peak = max(abs(v) for v in samples)
            count += len(samples)
            energy += square_sum
            peak = max(peak, block_peak)
            window_peak = max(window_peak, math.sqrt(square_sum / len(samples)))
    if not count:
        raise ValueError("音频没有可分析的采样。")
    return AudioLevels(math.sqrt(energy / count), peak, window_peak)


def analyse_track(levels: AudioLevels, original: AudioLevels) -> dict:
    rms_db = dbfs(levels.rms)
    relative_db = rms_db - dbfs(original.rms)
    # All conditions are required. In particular, never discard percussion or a
    # brief note just because silence elsewhere lowers its whole-file RMS.
    low_signal = levels.peak == 0 or (
        rms_db <= -75
        and relative_db <= -40
        and dbfs(levels.peak) <= -45
        and dbfs(levels.loudest_window_rms) <= -60
    )
    return {
        "rmsDbfs": round(rms_db, 2),
        "peakDbfs": round(dbfs(levels.peak), 2),
        "relativeRmsDb": round(relative_db, 2),
        "lowSignal": low_signal,
        "autoTranscriptionSkipped": False,
    }
