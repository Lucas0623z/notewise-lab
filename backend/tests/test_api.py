import io
import wave
from concurrent.futures import ThreadPoolExecutor

import mido
import pytest
from fastapi.testclient import TestClient

from stemwork.config import Settings
from stemwork.main import create_app
from stemwork.store import Store


def wav_bytes():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 1600)
    return buf.getvalue()


def sample_track(**overrides):
    return dict(id="bass", name="Bass", kind="bass", program=33, isDrum=False,
                muted=False, solo=False, volume=1, pan=0, audioUrl=None,
                transcriptionStatus="completed", warnings=[],
                notes=[dict(id="n1", pitch=48, startSeconds=0.25, durationSeconds=0.75, velocity=90)], **overrides)


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(tmp_path))) as c:
        yield c


def create_project(client):
    response = client.post("/api/v1/projects", json={"title": "Test", "bpm": 90})
    assert response.status_code == 201
    return response.json()


def upload(client, project):
    response = client.post(f"/api/v1/projects/{project['id']}/audio",
                           files={"file": ("test.wav", wav_bytes(), "audio/wav")},
                           data={"mode": "transcribe_only"})
    assert response.status_code == 202
    return response.json()


def test_edit_conflict_and_midi_seconds_roundtrip(client):
    p = create_project(client)
    edit = {"expectedRevision": 0, "tracks": [sample_track()]}
    saved = client.put(f"/api/v1/projects/{p['id']}", json=edit)
    assert saved.status_code == 200
    assert saved.json()["revision"] == 1
    assert client.put(f"/api/v1/projects/{p['id']}", json=edit).status_code == 409
    midi = client.get(f"/api/v1/projects/{p['id']}/export.mid")
    assert midi.status_code == 200
    parsed = mido.MidiFile(file=io.BytesIO(midi.content), charset="utf-8")
    seconds, found = 0, []
    for event in parsed:
        seconds += event.time
        if event.type in {"note_on", "note_off"}:
            found.append((event.type, seconds, event.note))
    assert found[0][1] == pytest.approx(0.25, abs=0.002)
    assert found[1][1] == pytest.approx(1.0, abs=0.002)
    assert found[0][2] == 48


def test_bad_upload_cleanup_and_size(tmp_path):
    with TestClient(create_app(Settings(tmp_path, max_upload_bytes=100))) as client:
        p = create_project(client)
        url = f"/api/v1/projects/{p['id']}/audio"
        assert client.post(url, files={"file": ("x.wav", b"not audio")}).status_code == 415
        assert client.post(url, files={"file": ("x.wav", wav_bytes())}).status_code == 413
        assert not list(tmp_path.rglob("*.part"))
        assert not list(tmp_path.rglob("*.wav"))
        assert client.get(f"/api/v1/projects/{p['id']}").json()["status"] == "empty"


def test_upload_is_durable_no_duplicate_overwrite_and_cancel(client):
    p = create_project(client)
    accepted = upload(client, p)
    assert accepted["project"]["bpm"] == 90
    store = Store(client.app.state.store.root)
    assert store.job(accepted["job"]["id"])["status"] == "queued"
    duplicate = client.post(f"/api/v1/projects/{p['id']}/audio", files={"file": ("x.wav", wav_bytes())})
    assert duplicate.status_code == 409
    assert len(list(store.root.rglob("*.wav"))) == 1
    assert client.get(accepted["project"]["sourceAudioUrl"]).content == wav_bytes()
    cancel = client.post(f"/api/v1/jobs/{accepted['job']['id']}/cancel")
    assert cancel.json()["status"] == "cancelled"
    assert store.claim() is None


def test_only_one_worker_can_claim(client):
    accepted = upload(client, create_project(client))
    store = client.app.state.store
    with ThreadPoolExecutor(2) as pool:
        claims = list(pool.map(lambda _: store.claim(), range(2)))
    assert sum(c is not None for c in claims) == 1
    assert store.job(accepted["job"]["id"])["status"] == "running"


def test_cancellation_wins_finish_race_and_sse_resume(client):
    accepted = upload(client, create_project(client))
    store = client.app.state.store
    job = store.claim()
    store.progress(job["id"], "transcribe", 0.5, "working")
    client.post(f"/api/v1/jobs/{job['id']}/cancel")
    result = dict(tracks=[sample_track()], bpm=120, durationSeconds=1, warnings=[])
    store.finish(job["id"], result=result)
    assert store.job(job["id"])["status"] == "cancelled"
    assert store.project(job["projectId"])["tracks"] == []
    events = store.events(job["id"])
    response = client.get(f"/api/v1/jobs/{job['id']}/events", headers={"Last-Event-ID": str(events[-2]["id"])})
    assert "event: job.cancelled" in response.text
    assert "event: job.updated" not in response.text
    assert "inputPath" not in response.text
    assert client.get(f"/api/v1/jobs/{job['id']}/events", headers={"Last-Event-ID": "invalid"}).status_code == 400


def test_stale_job_recovery_and_block_save_while_processing(client):
    accepted = upload(client, create_project(client))
    job = client.app.state.store.claim()
    response = client.put(f"/api/v1/projects/{job['projectId']}", json={
        "expectedRevision": 2, "tracks": [sample_track()]})
    assert response.status_code == 409
    assert client.app.state.store.recover_stale(stale_seconds=-1) == 1
    assert client.get(f"/api/v1/jobs/{job['id']}").json()["status"] == "failed"


def test_data_validation_and_untrusted_audio_url(client):
    p = create_project(client)
    track = sample_track()
    track["notes"][0]["durationSeconds"] = 0
    assert client.put(f"/api/v1/projects/{p['id']}", json={"expectedRevision": 0, "tracks": [track]}).status_code == 422
    track["notes"][0]["durationSeconds"] = 1
    track["audioUrl"] = "https://untrusted.invalid/file"
    saved = client.put(f"/api/v1/projects/{p['id']}", json={"expectedRevision": 0, "tracks": [track]}).json()
    assert saved["tracks"][0]["audioUrl"] is None
    assert client.get("/api/v1/projects/missing/audio/original").status_code == 404


def test_worker_lifecycle_with_injected_pipeline(client):
    from stemwork.worker import process_one
    upload(client, create_project(client))
    store = client.app.state.store

    def pipeline(input_path, output_dir, options, progress, track_ready, cancelled):
        assert not cancelled()
        output_dir.mkdir(parents=True)
        audio_path = output_dir / "bass.wav"
        audio_path.write_bytes(wav_bytes())
        track = sample_track()
        track.pop("audioUrl")
        track["audioPath"] = str(audio_path)
        progress("transcribe", 0.5, "testing")
        track_ready(track)
        # A partial result must be immediately fetchable, before job completion.
        partial = store.projects()[0]
        assert partial["status"] == "processing"
        assert client.get(partial["tracks"][0]["audioUrl"]).content == wav_bytes()
        return dict(tracks=[track], bpm=options["bpm"], durationSeconds=1, warnings=[])

    assert process_one(store, pipeline)
    p = store.projects()[0]
    assert p["status"] == "ready"
    assert client.get(p["tracks"][0]["audioUrl"]).content == wav_bytes()
    assert client.get(f"/api/v1/projects/{p['id']}/export.mid").content.startswith(b"MThd")


@pytest.mark.parametrize("submitted_analysis", ["omitted", None, {
    "rmsDbfs": -1, "peakDbfs": 0, "relativeRmsDb": 0,
    "lowSignal": False, "autoTranscriptionSkipped": False,
}])
def test_save_preserves_server_analysis_and_rejects_forged_new_track_analysis(client, submitted_analysis):
    p = create_project(client)
    upload(client, p)
    store = client.app.state.store
    job = store.claim()
    measured = dict(rmsDbfs=-91, peakDbfs=-54, relativeRmsDb=-58,
                    lowSignal=True, autoTranscriptionSkipped=True)
    track = sample_track(analysis=measured)
    track["audioUrl"] = f"/api/v1/projects/{p['id']}/tracks/bass/audio"
    store.finish(job["id"], result=dict(tracks=[track], bpm=90, durationSeconds=1, warnings=[]))
    current = client.get(f"/api/v1/projects/{p['id']}").json()
    edited = current["tracks"][0]
    if submitted_analysis == "omitted":
        edited.pop("analysis")
    else:
        edited["analysis"] = submitted_analysis
    added = sample_track(analysis=measured)
    added["id"] = "new-track"
    saved = client.put(f"/api/v1/projects/{p['id']}", json={
        "expectedRevision": current["revision"], "tracks": [edited, added],
    })
    assert saved.status_code == 200
    assert saved.json()["tracks"][0]["analysis"] == measured
    assert saved.json()["tracks"][0]["audioUrl"] == track["audioUrl"]
    assert saved.json()["tracks"][1]["analysis"] is None
    assert store.project(p["id"])["tracks"][0]["analysis"] == measured


def test_legacy_project_without_analysis_reads_and_saves(client):
    p = create_project(client)
    upload(client, p)
    store = client.app.state.store
    job = store.claim()
    store.finish(job["id"], result=dict(tracks=[sample_track()], bpm=90, durationSeconds=1, warnings=[]))
    assert "analysis" not in store.project(p["id"])["tracks"][0]
    current = client.get(f"/api/v1/projects/{p['id']}")
    assert current.status_code == 200
    assert current.json()["tracks"][0]["analysis"] is None
    edited = current.json()["tracks"][0]
    edited.pop("analysis")
    saved = client.put(f"/api/v1/projects/{p['id']}", json={
        "expectedRevision": current.json()["revision"], "tracks": [edited],
    })
    assert saved.status_code == 200
    assert saved.json()["tracks"][0]["analysis"] is None


def test_latest_job_survives_refresh_and_duration_can_shrink(client):
    p = create_project(client)
    accepted = upload(client, p)
    refreshed = client.get(f"/api/v1/projects/{p['id']}").json()
    assert refreshed["latestJobId"] == accepted["job"]["id"]
    client.post(f"/api/v1/jobs/{accepted['job']['id']}/cancel")
    track = sample_track()
    track["notes"][0]["startSeconds"] = 100
    refreshed = client.get(f"/api/v1/projects/{p['id']}").json()
    first = client.put(f"/api/v1/projects/{p['id']}", json={"expectedRevision": refreshed["revision"], "tracks": [track]}).json()
    assert first["durationSeconds"] > 100
    track["notes"] = []
    second = client.put(f"/api/v1/projects/{p['id']}", json={"expectedRevision": first["revision"], "tracks": [track]}).json()
    assert second["durationSeconds"] == 0


def test_sse_terminal_commit_between_empty_read_and_status_check(client, monkeypatch):
    accepted = upload(client, create_project(client))
    store = client.app.state.store
    job_id = accepted["job"]["id"]
    last_id = store.events(job_id)[-1]["id"]
    original_events = store.events
    calls = 0

    def raced_events(id, after=0):
        nonlocal calls
        calls += 1
        if calls == 1:
            store.cancel(id)
            return []
        return original_events(id, after)

    monkeypatch.setattr(store, "events", raced_events)
    response = client.get(f"/api/v1/jobs/{job_id}/events", headers={"Last-Event-ID": str(last_id)})
    assert "event: job.cancelled" in response.text


def test_overlap_export_merges_without_modifying_project():
    from stemwork.midi import non_overlapping_notes
    notes = [dict(id="a", pitch=60, startSeconds=0, durationSeconds=1, velocity=70),
             dict(id="b", pitch=60, startSeconds=0.5, durationSeconds=1, velocity=90)]
    merged = non_overlapping_notes(notes)
    assert len(merged) == 1
    assert merged[0]["durationSeconds"] == 1.5
    assert merged[0]["velocity"] == 90
    assert notes[0]["durationSeconds"] == 1
