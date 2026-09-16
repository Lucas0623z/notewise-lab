"""Known-cymbal trigger tests; synthetic signals do not prove classification."""

from array import array
import math
import random
import wave

import pytest

from stemwork.cymbal_onsets import detect_cymbal_hits
from stemwork.pipeline import PipelineCancelled

RATE = 16000


def wav(path, samples, stereo_opposite=False):
    pcm = array("h")
    for value in samples:
        sample = max(-32767, min(32767, round(value * 32767)))
        pcm.append(sample)
        if stereo_opposite:
            pcm.append(-sample)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(2 if stereo_opposite else 1)
        audio.setsampwidth(2)
        audio.setframerate(RATE)
        audio.writeframes(pcm.tobytes())


def hit(samples, start, amplitude, decay=0.035, double_tail=False):
    rng = random.Random(round(start * 1000))
    for index in range(round(start * RATE), min(len(samples), round((start + decay * 8) * RATE))):
        elapsed = index / RATE - start
        shape = math.exp(-elapsed / decay)
        if double_tail:
            shape += 0.7 * math.exp(-((elapsed - 0.18) / 0.035) ** 2)
        samples[index] += amplitude * shape * rng.uniform(-1, 1)


def test_silence_never_invents_hits(tmp_path):
    path = tmp_path / "silence.wav"
    wav(path, [0.0] * RATE)
    notes, warnings = detect_cymbal_hits(path, 1, lambda: False)
    assert notes == []
    assert any("未生成占位鼓点" in warning for warning in warnings)


def test_separated_hits_at_different_loudness_keep_times_and_velocity_order(tmp_path):
    path = tmp_path / "different-levels.wav"
    samples = [0.0] * (RATE * 3)
    starts = [0.2, 1.0, 1.8]
    for start, amplitude in zip(starts, [0.3, 0.1, 0.025]):
        hit(samples, start, amplitude)
    wav(path, samples, stereo_opposite=True)
    notes, warnings = detect_cymbal_hits(path, 3, lambda: False)
    assert len(notes) == 3
    assert [note["startSeconds"] for note in notes] == pytest.approx(starts, abs=0.01)
    assert notes[0]["velocity"] > notes[1]["velocity"] > notes[2]["velocity"] > 0
    assert all(note["pitch"] == 49 and note["durationSeconds"] == 0.1 for note in notes)
    assert len({note["id"] for note in notes}) == 3
    assert any("未自动识别" in warning for warning in warnings)


def test_continuous_double_peaked_tail_is_one_trigger(tmp_path):
    path = tmp_path / "double-tail.wav"
    samples = [0.0] * (RATE * 2)
    hit(samples, 0.2, 0.25, decay=0.2, double_tail=True)
    wav(path, samples)
    notes, _ = detect_cymbal_hits(path, 2, lambda: False)
    assert len(notes) == 1
    assert notes[0]["startSeconds"] == pytest.approx(0.2, abs=0.01)


def test_overlapping_strikes_may_merge_and_report_limitation(tmp_path):
    path = tmp_path / "overlapping.wav"
    samples = [0.0] * (RATE * 2)
    hit(samples, 0.2, 0.25, decay=0.2)
    hit(samples, 0.35, 0.2, decay=0.2)
    wav(path, samples)
    notes, warnings = detect_cymbal_hits(path, 2, lambda: False)
    assert len(notes) == 1
    assert any("相邻击打可能漏检" in warning for warning in warnings)


def test_tonal_leak_can_trigger_and_is_not_claimed_to_be_cymbal_classification(tmp_path):
    path = tmp_path / "piano-like-leak.wav"
    samples = [0.0] * RATE
    for index in range(round(0.2 * RATE), RATE):
        elapsed = index / RATE - 0.2
        samples[index] = 0.2 * math.exp(-elapsed / 0.12) * math.sin(2 * math.pi * 440 * elapsed)
    wav(path, samples)
    notes, warnings = detect_cymbal_hits(path, 1, lambda: False)
    assert len(notes) == 1  # An honest counterexample: energy is not instrument identity.
    assert any("串音可能误检" in warning for warning in warnings)


def test_trigger_at_audio_end_is_clipped_and_cancellation_is_preserved(tmp_path):
    path = tmp_path / "end.wav"
    samples = [0.0] * RATE
    hit(samples, 0.98, 0.25)
    wav(path, samples)
    notes, _ = detect_cymbal_hits(path, 1, lambda: False)
    assert len(notes) == 1
    assert notes[0]["startSeconds"] + notes[0]["durationSeconds"] <= 1
    calls = 0

    def cancelled():
        nonlocal calls
        calls += 1
        return calls > 2

    with pytest.raises(PipelineCancelled):
        detect_cymbal_hits(path, 1, cancelled)
