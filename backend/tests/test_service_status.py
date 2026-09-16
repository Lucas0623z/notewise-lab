import json
import os
from pathlib import Path
import subprocess
import threading
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from stemwork.config import Settings
from stemwork.main import create_app
from stemwork import service_status as status
from stemwork.service_status import WorkerHeartbeat, get_system_status, probe_model_environment


def ready_probe():
    return {"capabilities": {"transcribeOnly": True, "separate4": True, "separate6": True},
            "message": "模型依赖可用；首次可能下载权重。"}


def write_snapshot(root, *, name="worker", timestamp=100, phase="checked", capabilities=None, message="测试环境就绪"):
    directory = root / ".worker-status"
    directory.mkdir(exist_ok=True)
    path = directory / f"{name}.json"
    path.write_text(json.dumps({"version": 1, "pid": os.getpid(), "phase": phase,
                               "heartbeatAt": timestamp,
                               "capabilities": capabilities or ready_probe()["capabilities"],
                               "message": message}), encoding="utf-8")
    return path


def test_api_does_not_claim_ready_without_a_worker_or_probe_in_api(tmp_path, monkeypatch):
    def forbidden_probe(*args, **kwargs):
        pytest.fail("API status must not launch the model interpreter")

    monkeypatch.setattr(status.subprocess, "run", forbidden_probe)
    monkeypatch.setenv("STUDIO_INSTANCE_ID", "local-service-instance")
    with TestClient(create_app(Settings(tmp_path))) as client:
        response = client.get("/api/v1/system/status")
        assert response.status_code == 200
        assert response.json() == {
            "status": "unavailable", "apiReady": True, "workerReady": False,
            "capabilities": {"transcribeOnly": False, "separate4": False, "separate6": False, "pianoTranscription": False, "cymbalOnsets": False},
            "message": "本机服务已连接，但识别进程未运行或暂时失去响应。请启动识别服务后重试。",
        }
        assert client.get("/api/v1/health").json()["instanceId"] == "local-service-instance"
        monkeypatch.delenv("STUDIO_INSTANCE_ID")
        assert client.get("/api/v1/health").json()["instanceId"] is None


def test_worker_heartbeat_expires_after_unclean_exit_and_rejects_bad_clock(tmp_path):
    write_snapshot(tmp_path, timestamp=100)
    assert get_system_status(tmp_path, now=114).workerReady
    expired = get_system_status(tmp_path, now=116)
    assert expired.status == "unavailable"
    assert not expired.workerReady
    assert not expired.capabilities.separate4
    assert not get_system_status(tmp_path, now=1).workerReady


def test_starting_partial_dependencies_and_multiple_workers_are_honest(tmp_path):
    path = write_snapshot(tmp_path, phase="starting")
    assert get_system_status(tmp_path, now=101).status == "starting"
    assert get_system_status(tmp_path, now=101).workerReady
    assert not get_system_status(tmp_path, now=101).capabilities.transcribeOnly
    path.unlink()
    write_snapshot(tmp_path, capabilities={"transcribeOnly": True, "separate4": False, "separate6": False},
                   message="直接转录可用，分轨缺少 demucs。")
    write_snapshot(tmp_path, name="full-worker")
    result = get_system_status(tmp_path, now=101)
    assert result.status == "ready"
    assert result.workerReady and result.capabilities.transcribeOnly
    assert not result.capabilities.separate4
    assert "多个识别进程" in result.message
    write_snapshot(tmp_path, name="broken-worker", capabilities={"transcribeOnly": False, "separate4": False, "separate6": False},
                   message="转录依赖缺失：basic_pitch")
    assert get_system_status(tmp_path, now=101).status == "unavailable"
    assert get_system_status(tmp_path, now=101).workerReady


def test_corrupt_snapshot_is_unavailable_without_breaking_status_endpoint(tmp_path):
    path = write_snapshot(tmp_path)
    for raw in ("{", "null", "[]", '{"heartbeatAt": "100"}',
                '{"heartbeatAt": NaN}', '"text"'):
        path.write_text(raw, encoding="utf-8")
        assert get_system_status(tmp_path, now=101).status == "unavailable"


def test_probe_uses_model_python_and_only_find_spec_without_imports_or_downloads(monkeypatch):
    calls = []
    monkeypatch.setenv("STEMWORK_MODEL_PYTHON", "D:/model env/python.exe")
    modules = (*status.TRANSCRIPTION_MODULES, *status.SEPARATION_MODULES)

    def probe_run(command, **kwargs):
        calls.append(command)
        assert command[:2] == ["D:/model env/python.exe", "-c"]
        assert "find_spec" in command[2]
        assert "import torch" not in command[2]
        assert "import basic_pitch" not in command[2]
        assert kwargs["timeout"] == status.PROBE_TIMEOUT_SECONDS
        assert kwargs.get("shell", False) is False
        return SimpleNamespace(returncode=0, stdout=json.dumps({name: True for name in modules}))

    monkeypatch.setattr(status.subprocess, "run", probe_run)
    monkeypatch.setattr(status, "_ffmpeg_available", lambda: True)
    result = probe_model_environment()
    assert len(calls) == 1
    assert all(result["capabilities"][name] for name in ("transcribeOnly", "separate4", "separate6", "cymbalOnsets"))
    assert not result["capabilities"]["pianoTranscription"]  # No installed checkpoint in this test.
    assert "首次使用某个模型时可能需要联网下载权重" in result["message"]


@pytest.mark.parametrize("missing,transcribe,separate", [
    (["demucs", "sphn"], True, False),
    (["basic_pitch", "pkg_resources"], False, False),
])
def test_probe_reports_specific_missing_packages(monkeypatch, missing, transcribe, separate):
    modules = (*status.TRANSCRIPTION_MODULES, *status.SEPARATION_MODULES)
    monkeypatch.setattr(status.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        returncode=0, stdout=json.dumps({name: name not in missing for name in modules})))
    monkeypatch.setattr(status, "_ffmpeg_available", lambda: True)
    result = probe_model_environment()
    assert result["capabilities"] == {"transcribeOnly": transcribe, "separate4": separate, "separate6": separate, "pianoTranscription": False, "cymbalOnsets": separate}
    assert all(name in result["message"] for name in missing)


@pytest.mark.parametrize("failure", [FileNotFoundError("missing Python"),
                                     subprocess.TimeoutExpired("python", 15)])
def test_invalid_or_hung_interpreter_is_not_ready(monkeypatch, failure):
    def failed(*args, **kwargs):
        raise failure
    monkeypatch.setattr(status.subprocess, "run", failed)
    result = probe_model_environment()
    assert not any(result["capabilities"].values())
    assert "Python" in result["message"]


def test_heartbeat_keeps_refreshing_during_probe_and_long_job_and_closes(tmp_path):
    probe_started = threading.Event()
    release_probe = threading.Event()
    ready = threading.Event()
    release_job = threading.Event()
    errors = []

    def slow_probe():
        probe_started.set()
        assert release_probe.wait(3)
        return ready_probe()

    def run_worker():
        try:
            with WorkerHeartbeat(tmp_path, interval=0.01, probe=slow_probe):
                ready.set()
                # Simulates a blocking model call on the worker's main thread.
                assert release_job.wait(3)
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=run_worker)
    thread.start()
    try:
        assert probe_started.wait(3)
        path = next((tmp_path / ".worker-status").glob("*.json"))
        first = json.loads(path.read_text(encoding="utf-8"))["heartbeatAt"]

        def refreshed():
            # Waiting on a file update makes the test independent of CPU speed.
            deadline = status.time.monotonic() + 3
            while status.time.monotonic() < deadline:
                snapshot = json.loads(path.read_text(encoding="utf-8"))
                if snapshot["heartbeatAt"] > first + 0.03:
                    return snapshot
                threading.Event().wait(0.005)
            pytest.fail("Worker heartbeat did not refresh while its main thread was blocked")

        during_probe = refreshed()
        assert during_probe["phase"] == "starting"
        assert get_system_status(tmp_path).status == "starting"
        release_probe.set()
        assert ready.wait(3)
        first = json.loads(path.read_text(encoding="utf-8"))["heartbeatAt"]
        during_job = refreshed()
        assert during_job["phase"] == "checked"
        assert get_system_status(tmp_path, stale_seconds=0.1).workerReady
    finally:
        release_probe.set()
        release_job.set()
        thread.join(timeout=3)
    assert not thread.is_alive()
    assert not errors
    assert get_system_status(tmp_path).status == "unavailable"
    assert not list((tmp_path / ".worker-status").glob("*.tmp"))


def test_workers_do_not_remove_each_others_heartbeat(tmp_path):
    with WorkerHeartbeat(tmp_path, probe=ready_probe) as first:
        with WorkerHeartbeat(tmp_path, probe=ready_probe) as second:
            assert first.path != second.path
            assert len(list((tmp_path / ".worker-status").glob("*.json"))) == 2
        assert first.path.exists() and not second.path.exists()
        assert get_system_status(tmp_path).workerReady
    assert not first.path.exists()
