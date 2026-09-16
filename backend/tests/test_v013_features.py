"""Regression coverage for explicit model choices and percussion MIDI attacks.

Only inference boundaries are mocked. Tests exercise real WAV measurements,
the pipeline, API/SQLite queue, and MIDI serialization without live services.
"""

from array import array
from copy import deepcopy
import io
import json
from pathlib import Path
from unittest.mock import Mock
import wave

import mido
import pytest
from fastapi.testclient import TestClient

from stemwork import cymbal_onsets, pipeline
from stemwork.config import Settings
from stemwork.main import create_app
from stemwork.midi import export_midi
from stemwork.store import Store


def wave_bytes():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(array("h", [3000, -3000] * 4000).tobytes())
    return buffer.getvalue()


def note(id="note", *, pitch=60, start=0.2, duration=0.15, velocity=80):
    return dict(id=id, pitch=pitch, startSeconds=start,
                durationSeconds=duration, velocity=velocity)


@pytest.fixture
def audio_pipeline(tmp_path, monkeypatch):
    original = tmp_path / "original.wav"
    original.write_bytes(wave_bytes())
    checkpoint = tmp_path / "piano-checkpoint.pth"
    checkpoint.write_bytes(b"The inference boundary is mocked in this fixture")
    sources = []
    for stem in ("vocals", "drums", "bass", "other", "piano", "guitar"):
        path = tmp_path / f"{stem}.wav"
        path.write_bytes(wave_bytes())
        sources.append((stem, path))
    monkeypatch.setattr(pipeline, "_model_environment", lambda _: {"STEMWORK_PIANO_CHECKPOINT": str(checkpoint)})
    dependencies = Mock()
    separation = Mock(return_value=sources)
    basic = Mock(return_value=([note("basic")], []))
    piano = Mock(return_value=([note("piano", duration=0.4)], []))
    drum = Mock(return_value=([note("hit", pitch=49, duration=0.1)], ["experimental trigger warning"]))
    monkeypatch.setattr(pipeline, "_check_dependencies", dependencies)
    monkeypatch.setattr(pipeline, "_separate_audio", separation)
    monkeypatch.setattr(pipeline, "_transcribe_audio", basic)
    monkeypatch.setattr(pipeline, "_transcribe_piano", piano)
    monkeypatch.setattr(cymbal_onsets, "detect_cymbal_hits", drum)
    published, progress = [], []

    def run(**options):
        return pipeline.run_pipeline(original, tmp_path / "results", options,
                                     lambda *args: progress.append(args), published.append,
                                     lambda: False)

    return dict(run=run, basic=basic, piano=piano, drum=drum, separation=separation,
                dependencies=dependencies, checkpoint=checkpoint, sources=dict(sources),
                published=published, progress=progress)


def test_highres_separation_routes_only_piano_to_dedicated_model(audio_pipeline):
    h = audio_pipeline
    result = h["run"](transcriptionModel="piano_highres", separationModel="htdemucs_6s")
    assert h["piano"].call_count == 1
    assert h["piano"].call_args.args[0] == h["sources"]["piano"]
    assert {call.args[0] for call in h["basic"].call_args_list} == {
        h["sources"][stem] for stem in ("vocals", "bass", "other", "guitar")}
    tracks = {track["kind"]: track for track in result["tracks"]}
    assert tracks["piano"]["transcriptionEngine"] == "piano_highres"
    assert tracks["piano"]["notes"][0]["id"] == "piano"
    assert tracks["bass"]["transcriptionEngine"] == "basic_pitch"
    assert len(h["published"]) == 6


def test_direct_piano_is_labelled_piano_and_never_separates_or_calls_basic(audio_pipeline):
    h = audio_pipeline
    result = h["run"](mode="transcribe_only", transcriptionModel="piano_highres", device="cpu")
    h["separation"].assert_not_called()
    h["basic"].assert_not_called()
    assert h["piano"].call_args.args[4] == "cpu"
    track = result["tracks"][0]
    assert track["kind"] == "piano"
    assert track["transcriptionEngine"] == "piano_highres"
    assert Path(track["audioPath"]).read_bytes()[:4] == b"RIFF"


def test_highres_failure_does_not_silently_fall_back_to_basic_pitch(audio_pipeline):
    h = audio_pipeline
    h["piano"].side_effect = pipeline.PipelineError("dedicated checkpoint rejected")
    with pytest.raises(pipeline.PipelineError, match="checkpoint rejected"):
        h["run"](mode="transcribe_only", transcriptionModel="piano_highres")
    h["basic"].assert_not_called()
    assert h["published"][0]["transcriptionStatus"] == "failed"
    assert h["published"][0]["notes"] == []
    assert Path(h["published"][0]["audioPath"]).is_file()
    assert "done" not in [event[0] for event in h["progress"]]


def test_partial_highres_failure_preserves_successful_other_tracks_without_fallback(audio_pipeline):
    h = audio_pipeline
    h["piano"].side_effect = pipeline.PipelineError("piano unavailable")
    result = h["run"](transcriptionModel="piano_highres", separationModel="htdemucs_6s")
    tracks = {track["kind"]: track for track in result["tracks"]}
    assert tracks["piano"]["transcriptionStatus"] == "failed"
    assert tracks["other"]["transcriptionStatus"] == "completed"
    assert all(call.args[0] != h["sources"]["piano"] for call in h["basic"].call_args_list)
    assert any("piano unavailable" in warning for warning in result["warnings"])


def test_missing_highres_weights_fail_before_starting_any_model(audio_pipeline):
    h = audio_pipeline
    h["checkpoint"].unlink()
    with pytest.raises(pipeline.PipelineError, match="STEMWORK_PIANO_CHECKPOINT"):
        h["run"](mode="transcribe_only", transcriptionModel="piano_highres")
    for boundary in ("dependencies", "separation", "piano", "basic"):
        h[boundary].assert_not_called()


def test_legacy_defaults_do_not_enable_piano_or_cymbal_inference(audio_pipeline):
    h = audio_pipeline
    h["separation"].return_value = [(stem, h["sources"][stem]) for stem in ("vocals", "drums", "bass", "other")]
    result = h["run"]()
    h["piano"].assert_not_called()
    h["drum"].assert_not_called()
    drums = next(track for track in result["tracks"] if track["isDrum"])
    assert drums["notes"] == []
    assert drums["transcriptionStatus"] == "unsupported"
    assert h["basic"].call_count == 3


def test_cymbal_opt_in_publishes_real_detector_events_and_warning(audio_pipeline):
    h = audio_pipeline
    result = h["run"](drumTranscription="cymbal_onsets")
    h["drum"].assert_called_once()
    assert h["drum"].call_args.args[0] == h["sources"]["drums"]
    assert h["drum"].call_args.args[1] == 1.0
    drums = next(track for track in result["tracks"] if track["isDrum"])
    assert drums["notes"] == h["drum"].return_value[0]
    assert drums["transcriptionEngine"] == "cymbal_onsets"
    assert drums["transcriptionStatus"] == "completed"
    assert "experimental trigger warning" in drums["warnings"]
    assert all(call.args[0] != h["sources"]["drums"] for call in h["basic"].call_args_list)


def test_cymbal_failure_is_visible_and_retains_drum_audio(audio_pipeline):
    h = audio_pipeline
    h["drum"].side_effect = ValueError("detector failed")
    result = h["run"](drumTranscription="cymbal_onsets")
    drums = next(track for track in result["tracks"] if track["isDrum"])
    assert drums["transcriptionStatus"] == "failed"
    assert drums["notes"] == []
    assert Path(drums["audioPath"]).is_file()
    assert any("detector failed" in warning for warning in result["warnings"])


def test_dedicated_subprocess_uses_separate_python_and_rejects_malformed_output(tmp_path, monkeypatch):
    checkpoint = tmp_path / "checkpoint with spaces.pth"
    checkpoint.touch()
    env = {"STEMWORK_PIANO_PYTHON": "D:/separate env/pythonw.exe", "STEMWORK_PIANO_CHECKPOINT": str(checkpoint)}
    commands = []

    def process(command, *_args, **_kwargs):
        commands.append(command)
        Path(command[4]).write_text(json.dumps({"not": "note events"}), encoding="utf-8")

    monkeypatch.setattr(pipeline, "_run_process", process)
    with pytest.raises(pipeline.PipelineError, match="无效数据"):
        pipeline._transcribe_piano(tmp_path / "source.wav", tmp_path, env, 1, "cpu", lambda: False)
    assert commands[0][:3] == [env["STEMWORK_PIANO_PYTHON"], "-m", "stemwork.piano_transcription"]
    assert commands[0][-2:] == [str(checkpoint), "cpu"]


@pytest.fixture
def api_client(tmp_path):
    with TestClient(create_app(Settings(tmp_path))) as client:
        yield client


def create(api_client):
    response = api_client.post("/api/v1/projects", json={"title": "Explicit feature test", "bpm": 96})
    assert response.status_code == 201
    return response.json()


@pytest.mark.parametrize("submitted,expected", [
    ({}, {"mode": "demucs_basic_pitch", "separationModel": "htdemucs", "transcriptionModel": "basic_pitch", "drumTranscription": "none"}),
    ({"separationModel": "htdemucs_6s", "transcriptionModel": "piano_highres", "drumTranscription": "cymbal_onsets"},
     {"mode": "demucs_basic_pitch", "separationModel": "htdemucs_6s", "transcriptionModel": "piano_highres", "drumTranscription": "cymbal_onsets"}),
    ({"mode": "transcribe_only", "transcriptionModel": "piano_highres"},
     {"mode": "transcribe_only", "separationModel": "htdemucs", "transcriptionModel": "piano_highres", "drumTranscription": "none"}),
])
def test_upload_choices_survive_database_reopen_and_reach_worker(api_client, submitted, expected):
    project = create(api_client)
    response = api_client.post(f"/api/v1/projects/{project['id']}/audio",
                               files={"file": ("source.wav", wave_bytes(), "audio/wav")}, data=submitted)
    assert response.status_code == 202
    reopened = Store(api_client.app.state.store.root)
    claimed = reopened.claim()
    assert claimed["id"] == response.json()["job"]["id"]
    assert {key: claimed["options"][key] for key in expected} == expected
    assert claimed["options"]["bpm"] == 96
    assert claimed["options"]["device"] == "auto"


@pytest.mark.parametrize("submitted", [
    {"transcriptionModel": "piano_highres", "separationModel": "htdemucs"},
    {"mode": "transcribe_only", "drumTranscription": "cymbal_onsets"},
    {"transcriptionModel": "unknown-model"},
    {"drumTranscription": "automatic-instrument-classifier"},
])
def test_invalid_upload_model_choices_leave_no_queued_job_or_audio(api_client, submitted):
    project = create(api_client)
    response = api_client.post(f"/api/v1/projects/{project['id']}/audio",
                               files={"file": ("source.wav", wave_bytes(), "audio/wav")}, data=submitted)
    assert response.status_code == 422
    store = api_client.app.state.store
    assert store.project(project["id"]) == project
    assert store.claim() is None
    assert not list(store.root.rglob("*.wav"))
    assert not list(store.root.rglob("*.part"))


@pytest.mark.parametrize("second_start", [0.25, 0.3])
def test_adjacent_cymbal_midi_keeps_each_attack_and_does_not_edit_project(second_start):
    notes = [note("one", pitch=49, start=0.2, duration=0.1, velocity=70),
             note("two", pitch=49, start=second_start, duration=0.1, velocity=110)]
    track = dict(id="drums", name="Cymbal", kind="drums", program=0, isDrum=True,
                 muted=False, solo=False, volume=1, pan=0, notes=notes)
    project = dict(title="Two attacks", bpm=120, timeSignature="4/4", tracks=[track])
    snapshot = deepcopy(project)
    midi = mido.MidiFile(file=io.BytesIO(export_midi(project)))
    elapsed, events = 0.0, []
    for event in midi:
        elapsed += event.time
        if event.type in {"note_on", "note_off"}:
            events.append((event.type, elapsed, event.note, event.velocity, event.channel))
    attacks = [event for event in events if event[0] == "note_on" and event[3] > 0]
    assert len(attacks) == 2
    assert [event[1] for event in attacks] == pytest.approx([0.2, second_start], abs=0.0011)
    assert [event[3] for event in attacks] == [70, 110]
    assert all(event[4] == 9 for event in events)
    assert [event[0] for event in events] == ["note_on", "note_off", "note_on", "note_off"]
    assert events[1][1] == pytest.approx(second_start, abs=0.0011)
    assert project == snapshot
