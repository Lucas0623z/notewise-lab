"""Generate synthetic audio and run the real queue/model/export path.

Not a music quality benchmark. No personal audio or external upload is used.
Run with the model environment Python from the backend directory or after
installing backend editable. Model checkpoints may download on first run.
"""
import argparse
import json
import math
import struct
import sys
import time
import wave
from pathlib import Path

from stemwork.midi import export_midi
from stemwork.store import Store
from stemwork.worker import process_one


def synthetic_audio(path):
    rate = 44100
    pitches = [60, 64, 67, 72, 67, 64]
    samples = bytearray()
    for index in range(rate * 6):
        t = index / rate
        pitch = pitches[min(5, int(t))]
        within = t % 1
        envelope = min(1, within / 0.02) * max(0, 1 - within / 0.85)
        frequency = 440 * 2 ** ((pitch - 69) / 12)
        signal = sum(math.sin(2 * math.pi * frequency * harmonic * t) / harmonic
                     for harmonic in (1, 2, 3)) * 0.3 * envelope
        samples.extend(struct.pack("<h", max(-32768, min(32767, int(signal * 32767)))))
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(samples)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--mode", choices=["transcribe_only", "demucs_basic_pitch"], default="transcribe_only")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    args = parser.parse_args()
    store = Store(args.data_dir)
    source = store.root / "synthetic-six-notes.wav"
    synthetic_audio(source)
    p = store.create_project(f"合成音频验证 · {args.mode}", bpm=120)
    accepted = store.enqueue(p["id"], source, dict(mode=args.mode, device=args.device, separationModel="htdemucs", bpm=120))
    started = time.perf_counter()
    print(f"Running real models: {args.mode} / {args.device}", flush=True)
    process_one(store)
    project = store.project(p["id"])
    job = store.job(accepted["job"]["id"])
    report = {
        "testType": "synthetic execution smoke test, not a quality benchmark",
        "mode": args.mode, "requestedDevice": args.device, "inputSeconds": 6,
        "elapsedSeconds": round(time.perf_counter() - started, 3), "jobStatus": job["status"],
        "error": job["error"], "projectId": project["id"],
        "tracks": [{"kind": t["kind"], "notes": len(t["notes"]), "status": t["transcriptionStatus"]}
                   for t in project["tracks"]],
        "warnings": project["warnings"],
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    if job["status"] == "succeeded":
        midi_path = args.report.with_suffix(".mid")
        midi_path.write_bytes(export_midi(project))
        report["midiFile"] = midi_path.name
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if job["status"] != "succeeded" or not any(t["notes"] for t in project["tracks"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
