"""Installer failure, isolation and publication contracts; no network/models."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "setup_runtime.py"
spec = importlib.util.spec_from_file_location("setup_runtime", SCRIPT)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class Response(io.BytesIO):
    def geturl(self):
        return "https://zenodo.org/verified-weight"


def payload():
    data = b"fixed model bytes\x00\xff"
    return data, len(data), hashlib.sha256(data).hexdigest()


def test_hash_mismatch_never_publishes_or_replaces_existing_weight(tmp_path):
    destination = tmp_path / "weight.pth"
    destination.write_bytes(b"previous verified artifact")
    data, size, digest = payload()
    progress = setup.Progress(tmp_path / "progress.json")
    with pytest.raises(setup.SetupError, match="SHA-256"):
        setup.download_verified("https://zenodo.org/file", destination, size, digest, progress,
                                opener=lambda *a, **k: Response(b"x" * size))
    assert destination.read_bytes() == b"previous verified artifact"
    assert destination.with_suffix(".pth.part").exists()
    setup.download_verified("https://zenodo.org/file", destination, size, digest, progress,
                            opener=lambda *a, **k: Response(data))
    assert destination.read_bytes() == data
    assert not destination.with_suffix(".pth.part").exists()
    assert json.loads(progress.path.read_text())["bytesDownloaded"] == size


def test_cached_model_is_reused_without_network(tmp_path):
    data, size, digest = payload()
    destination = tmp_path / "weight.pth"
    destination.write_bytes(data)
    setup.download_verified("https://zenodo.org/file", destination, size, digest,
                            setup.Progress(tmp_path / "progress.json"),
                            opener=lambda *a, **k: pytest.fail("verified cache must not download"))


def test_cancelled_download_has_no_finished_file_and_is_retryable(tmp_path):
    data, size, digest = payload()
    cancel = tmp_path / "cancel"
    destination = tmp_path / "weight.pth"

    class CancelResponse(Response):
        def read(self, amount=-1):
            value = super().read(amount)
            cancel.touch()
            return value

    with pytest.raises(setup.SetupCancelled):
        setup.download_verified("https://zenodo.org/file", destination, size, digest,
                                setup.Progress(tmp_path / "progress.json"), cancel,
                                opener=lambda *a, **k: CancelResponse(data))
    assert not destination.exists()
    assert destination.with_suffix(".pth.part").exists()
    cancel.unlink()
    setup.download_verified("https://zenodo.org/file", destination, size, digest,
                            setup.Progress(tmp_path / "progress.json"), cancel,
                            opener=lambda *a, **k: Response(data))
    assert destination.read_bytes() == data


def test_atomic_failure_preserves_old_complete_manifest(tmp_path, monkeypatch):
    path = tmp_path / "runtime.json"
    path.write_text('{"old": true}')

    def fail_replace(*args):
        raise OSError("disk unavailable")

    monkeypatch.setattr(setup.os, "replace", fail_replace)
    with pytest.raises(OSError, match="disk unavailable"):
        setup.atomic_json(path, {"new": True})
    assert json.loads(path.read_text()) == {"old": True}
    assert sorted(p.name for p in tmp_path.iterdir()) == ["runtime.json"]


def test_live_setup_lock_rejects_second_installer_and_retains_owner(tmp_path):
    with setup.installation_lock(tmp_path):
        first = (tmp_path / ".setup-runtime.lock").read_bytes()
        with pytest.raises(setup.SetupBusy):
            with setup.installation_lock(tmp_path):
                pytest.fail("second installer entered")
        assert (tmp_path / ".setup-runtime.lock").read_bytes() == first
    assert not (tmp_path / ".setup-runtime.lock").exists()


def test_dead_installer_lock_can_be_retried(tmp_path, monkeypatch):
    lock = tmp_path / ".setup-runtime.lock"
    lock.write_text(json.dumps({"pid": 99999999, "token": "dead"}))
    monkeypatch.setattr(setup, "pid_alive", lambda _: False)
    with setup.installation_lock(tmp_path):
        assert json.loads(lock.read_text())["pid"] == os.getpid()
    assert not lock.exists()


def test_incomplete_lock_is_not_treated_as_dead_writer(tmp_path):
    (tmp_path / ".setup-runtime.lock").touch()
    with pytest.raises(setup.SetupBusy):
        with setup.installation_lock(tmp_path):
            pass


def test_finished_manifest_rejects_external_python_and_wrong_revision(tmp_path):
    target = tmp_path / "runtime"
    target.mkdir()
    inside = target / "python.exe"
    inside.touch()
    value = {"schemaVersion": 1, "runtimeRevision": "v1"}
    for key in ("python", "modelPython", "pianoPython", "pianoCheckpoint",
                "backendDirectory", "modelCacheDirectory"):
        value[key] = str(inside)
    result = target / "runtime.json"
    setup.atomic_json(result, value)
    assert setup.completed_manifest(result, target, "v1") == value
    assert setup.completed_manifest(result, target, "v2") is None
    outside = tmp_path / "system-python.exe"
    outside.touch()
    value["python"] = str(outside)
    setup.atomic_json(result, value)
    assert setup.completed_manifest(result, target, "v1") is None


def test_distribution_pins_have_no_tensorflow_or_cuda_and_cpu_torch_separate():
    backend = setup.find_backend(SCRIPT)
    spec = setup.read_spec(backend)
    assert spec["runtimeRevision"]
    api = setup.read_pins(backend / "requirements-distribution-api.txt")
    models = setup.read_pins(backend / "requirements-distribution-models.txt")
    torch = setup.read_pins(backend / "requirements-distribution-torch.txt")
    assert api.items() <= models.items()
    assert torch == {"torch": "2.8.0+cpu"}
    assert "torch" not in models
    assert models["basic-pitch"] == "0.4.0"
    assert models["demucs"] == "4.1.0"
    assert models["imageio-ffmpeg"] == "0.6.0"
    assert models["piano-transcription-inference"] == "0.0.6"
    compile(setup.VERIFY_MODELS, "verify_models.py", "exec")


@pytest.mark.parametrize("line", ["torch>=2", "--extra-index-url https://example.invalid", "tensorflow==2.15.0"])
def test_unlocked_or_unapproved_dependency_is_rejected(tmp_path, line):
    path = tmp_path / "requirements.txt"
    path.write_text(line)
    with pytest.raises(setup.SetupError):
        setup.read_pins(path)


def test_install_environment_does_not_inherit_external_python_or_package_index(tmp_path, monkeypatch):
    monkeypatch.setenv("PYTHONPATH", "external-code")
    monkeypatch.setenv("PIP_EXTRA_INDEX_URL", "https://example.invalid")
    monkeypatch.setenv("STUDIO_DATA_DIR", "existing-user-projects")
    env = setup.clean_environment(tmp_path, tmp_path / "models")
    assert "PYTHONPATH" not in env
    assert "PIP_EXTRA_INDEX_URL" not in env
    assert env["PIP_CONFIG_FILE"] == os.devnull
    assert env["STUDIO_DATA_DIR"] == str(tmp_path / "setup-verification-data")
    assert env["HF_HUB_OFFLINE"] == "1"
    assert env["CUDA_VISIBLE_DEVICES"] == ""


def test_pip_install_has_fixed_source_no_implicit_dependencies_or_shell(tmp_path, monkeypatch):
    backend = setup.find_backend(SCRIPT)
    install = setup.Installer(tmp_path, backend, setup.read_spec(backend),
                              setup.Progress(tmp_path / "progress.json"))
    commands = []
    monkeypatch.setattr(install, "run", lambda command, message: commands.append(command))
    install.pip(tmp_path / "python.exe", ["torch==2.8.0+cpu"],
                "https://download.pytorch.org/whl/cpu", "CPU")
    command = commands[0]
    assert command[0] == str(tmp_path / "python.exe")
    assert "--no-deps" in command
    assert command[command.index("--index-url") + 1] == "https://download.pytorch.org/whl/cpu"
    assert "-I" in command


def test_child_failure_does_not_publish_complete(tmp_path):
    backend = setup.find_backend(SCRIPT)
    progress = setup.Progress(tmp_path / "progress.json")
    install = setup.Installer(tmp_path, backend, setup.read_spec(backend), progress)
    with pytest.raises(setup.SetupError, match="23"):
        install.run([sys.executable, "-c", "raise SystemExit(23)"], "受控失败验证")
    assert not (tmp_path / "runtime.json").exists()
    assert json.loads(progress.path.read_text(encoding="utf-8"))["stage"] != "complete"


def test_cancel_reaps_own_real_interpreter_and_releases_log(tmp_path):
    backend = setup.find_backend(SCRIPT)
    progress = setup.Progress(tmp_path / "progress.json")
    cancel, pidfile = tmp_path / "cancel", tmp_path / "child.pid"
    install = setup.Installer(tmp_path, backend, setup.read_spec(backend), progress, cancel)
    code = ("import os,time;from pathlib import Path;"
            f"Path({str(pidfile)!r}).write_text(str(os.getpid()));"
            f"Path({str(cancel)!r}).touch();time.sleep(60)")
    with pytest.raises(setup.SetupCancelled):
        install.run([sys.executable, "-c", code], "受控取消验证")
    assert not setup.pid_alive(int(pidfile.read_text()))
    # On Windows, leaked venv child/redirector handles would keep this file locked.
    install.log.unlink()
    assert not install.log.exists()


def test_failed_install_never_publishes_new_revision_and_retry_completes(tmp_path, monkeypatch):
    target = tmp_path / "runtime"
    target.mkdir()
    result, progress = target / "runtime.json", tmp_path / "progress.json"
    old = {"schemaVersion": 1, "runtimeRevision": "old-version"}
    setup.atomic_json(result, old)
    monkeypatch.setattr(setup.sys, "version_info", (3, 11, 16))
    monkeypatch.setattr(setup.platform, "architecture", lambda: ("64bit", "WindowsPE"))
    arguments = ["--target", str(target), "--progress", str(progress), "--result", str(result)]

    def failed(self):
        raise setup.SetupError("真实验证阶段失败")

    monkeypatch.setattr(setup.Installer, "install", failed)
    assert setup.main(arguments) == 1
    assert json.loads(result.read_text()) == old
    assert json.loads(progress.read_text(encoding="utf-8"))["stage"] == "failed"
    assert not (target / ".setup-runtime.lock").exists()
    spec = setup.read_spec(setup.find_backend(SCRIPT))
    new = {"schemaVersion": 1, "runtimeRevision": spec["runtimeRevision"]}

    def successful(self):
        # Install must finish before the previous completion marker is changed.
        assert json.loads(result.read_text()) == old
        return new

    monkeypatch.setattr(setup.Installer, "install", successful)
    assert setup.main(arguments) == 0
    assert json.loads(result.read_text()) == new
    assert json.loads(progress.read_text(encoding="utf-8"))["stage"] == "complete"


def test_second_main_does_not_clobber_running_progress(tmp_path, monkeypatch):
    target = tmp_path / "runtime"
    progress = tmp_path / "progress.json"
    before = {"stage": "installing", "message": "owner is installing"}
    setup.atomic_json(progress, before)
    monkeypatch.setattr(setup.sys, "version_info", (3, 11, 16))
    monkeypatch.setattr(setup.platform, "architecture", lambda: ("64bit", "WindowsPE"))
    with setup.installation_lock(target):
        code = setup.main(["--target", str(target), "--progress", str(progress),
                           "--result", str(target / "runtime.json")])
    assert code == 3
    assert json.loads(progress.read_text()) == before
