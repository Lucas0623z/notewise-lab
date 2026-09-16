"""Install the bundled Windows CPU recognition runtime, without system Python.

Source layout: scripts/setup_runtime.py beside ../backend.
Packaged layout: resources/backend/setup_runtime.py beside stemwork and locks.
Only the supplied runtime directory is installed; no projects/audio are opened.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
from urllib.request import Request, urlopen
import uuid


class SetupError(RuntimeError):
    pass


class SetupCancelled(SetupError):
    pass


class SetupBusy(SetupError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, ensure_ascii=False, allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Progress:
    def __init__(self, path: Path):
        self.path = path

    def emit(self, stage: str, message: str, **details) -> None:
        value = {"stage": stage, "message": message, "updatedAt": utc_now(), **details}
        atomic_json(self.path, value)
        # pythonw has no stdout. JSON ASCII also works with redirected legacy consoles.
        if sys.stdout is not None:
            print(json.dumps(value, ensure_ascii=True, allow_nan=False), flush=True)


def is_within(path: Path, parent: Path) -> bool:
    return path.resolve().is_relative_to(parent.resolve())


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if not handle:
        return ctypes.get_last_error() != 87  # Access denied is not proof of death.
    try:
        return kernel.WaitForSingleObject(handle, 0) != 0
    finally:
        kernel.CloseHandle(handle)


@contextmanager
def installation_lock(target: Path):
    target.mkdir(parents=True, exist_ok=True)
    path = target / ".setup-runtime.lock"
    token = uuid.uuid4().hex
    for attempt in range(2):
        try:
            with path.open("x", encoding="utf-8") as output:
                json.dump({"pid": os.getpid(), "token": token, "createdAt": utc_now()}, output)
            break
        except FileExistsError:
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
                active = pid_alive(int(existing["pid"]))
            except (OSError, ValueError, KeyError, TypeError):
                # Another process may have created the file but not written it yet.
                active = not path.exists() or time.time() - path.stat().st_mtime < 600
            if active or attempt:
                raise SetupBusy("识别环境正在由另一个安装进程准备，请等待。")
            path.unlink(missing_ok=True)
    try:
        yield
    finally:
        try:
            if json.loads(path.read_text(encoding="utf-8")).get("token") == token:
                path.unlink()
        except (OSError, ValueError):
            pass


def check_cancelled(cancel_file: Path | None) -> None:
    if cancel_file is not None and cancel_file.exists():
        raise SetupCancelled("识别环境准备已取消；再次打开可重试。")


def file_matches(path: Path, size: int, digest: str) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest() == digest


def download_verified(url: str, destination: Path, size: int, digest: str,
                      progress: Progress, cancel_file: Path | None = None,
                      opener=urlopen) -> None:
    """Download only to .part; publish a weight only after exact hash verification."""
    if not url.startswith("https://"):
        raise SetupError("模型下载必须使用 HTTPS。")
    check_cancelled(cancel_file)
    if file_matches(destination, size, digest):
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    # A failed/cancelled .part is safely overwritten; verified final files are reused.
    received = 0
    progress.emit("downloading", f"正在下载 {destination.name}",
                  bytesDownloaded=0, totalBytes=size)
    request = Request(url, headers={"User-Agent": "LocalRecognitionSetup/1", "Accept-Encoding": "identity"})
    with opener(request, timeout=60) as response, partial.open("wb") as output:
        if not response.geturl().startswith("https://"):
            raise SetupError("模型下载被重定向到非 HTTPS 地址。")
        last_report = time.monotonic()
        while True:
            check_cancelled(cancel_file)
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            received += len(chunk)
            if received > size:
                raise SetupError(f"{destination.name} 大于预期大小，拒绝使用。")
            output.write(chunk)
            if time.monotonic() - last_report >= 0.5:
                progress.emit("downloading", f"正在下载 {destination.name}",
                              bytesDownloaded=received, totalBytes=size)
                last_report = time.monotonic()
        output.flush()
        os.fsync(output.fileno())
    check_cancelled(cancel_file)
    if not file_matches(partial, size, digest):
        raise SetupError(f"{destination.name} 下载不完整或 SHA-256 不匹配，请重试。")
    os.replace(partial, destination)
    progress.emit("downloading", f"已校验 {destination.name}",
                  bytesDownloaded=received, totalBytes=size)


def find_backend(script: Path | None = None) -> Path:
    script = (script or Path(__file__)).resolve()
    for directory in (script.parent, script.parent.parent / "backend"):
        if (directory / "stemwork/pipeline.py").is_file() and (directory / "distribution-manifest.json").is_file():
            return directory
    raise SetupError("安装包缺少后端程序或依赖清单，请重新下载安装包。")


def read_spec(backend: Path) -> dict:
    spec = json.loads((backend / "distribution-manifest.json").read_text(encoding="utf-8"))
    if spec.get("schemaVersion") != 1 or not re.fullmatch(r"[A-Za-z0-9._-]+", spec.get("runtimeRevision", "")):
        raise SetupError("识别环境版本清单无效。")
    if spec.get("indexes") != {"pypi": "https://pypi.org/simple", "torch": "https://download.pytorch.org/whl/cpu"}:
        raise SetupError("识别环境清单包含未支持的软件源。")
    return spec


def read_pins(path: Path) -> dict[str, str]:
    pins = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9.+-]+)", line)
        if not match:
            raise SetupError(f"依赖必须锁定明确版本：{path.name}")
        name, version = match.groups()
        if "tensorflow" in name.lower() or "nvidia" in name.lower():
            raise SetupError("CPU 发行环境不允许安装 TensorFlow 或 NVIDIA 依赖。")
        pins[name] = version
    if not pins:
        raise SetupError(f"依赖清单为空：{path.name}")
    return pins


def clean_environment(target: Path, cache: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("PIP_", "PYTHON", "CONDA", "VIRTUAL_ENV"))}
    env.update({
        "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1", "PYTHONNOUSERSITE": "1",
        "PIP_CONFIG_FILE": os.devnull, "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PIP_NO_INPUT": "1", "PIP_CACHE_DIR": str(target / "pip-cache"),
        "STEMWORK_MODEL_CACHE": str(cache), "HF_HOME": str(cache / "huggingface"),
        "STUDIO_DATA_DIR": str(target / "setup-verification-data"),
        "TORCH_HOME": str(cache / "torch"), "NUMBA_CACHE_DIR": str(cache / "numba"),
        "MPLCONFIGDIR": str(cache / "matplotlib"), "XDG_CACHE_HOME": str(cache),
        "CUDA_VISIBLE_DEVICES": "", "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "1", "HF_HUB_OFFLINE": "1",
    })
    return env


class Installer:
    def __init__(self, target: Path, backend: Path, spec: dict, progress: Progress,
                 cancel_file: Path | None = None):
        self.target, self.backend, self.spec = target, backend, spec
        self.progress, self.cancel_file = progress, cancel_file
        self.revision = target / "revisions" / spec["runtimeRevision"]
        self.cache = self.revision / "model-cache"
        self.env = clean_environment(target, self.cache)
        self.log = target / "logs" / f"setup-{os.getpid()}-{time.time_ns()}.log"
        self.log.parent.mkdir(parents=True, exist_ok=True)

    def run(self, command: list[str], message: str, stage: str = "installing") -> None:
        check_cancelled(self.cancel_file)
        self.progress.emit(stage, message, logPath=str(self.log))
        process = None
        with self.log.open("ab") as log:
            log.write(("\n" + message + "\n").encode("utf-8"))
            log.flush()
            try:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log,
                                           stderr=subprocess.STDOUT, cwd=self.target,
                                           env=self.env, shell=False,
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                while process.poll() is None:
                    check_cancelled(self.cancel_file)
                    time.sleep(0.2)
                if process.returncode:
                    raise SetupError(f"{message}失败（退出码 {process.returncode}）。日志：{self.log}")
                check_cancelled(self.cancel_file)
            finally:
                if process is not None and process.poll() is None:
                    self.terminate_owned_process(process)

    def terminate_owned_process(self, process) -> None:
        if os.name == "nt":
            path = self.backend / "stemwork/process_tree.py"
            module_spec = importlib.util.spec_from_file_location("setup_process_tree", path)
            module = importlib.util.module_from_spec(module_spec)
            module_spec.loader.exec_module(module)
            module.terminate_windows_process_tree(process)
        else:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def pip(self, python: Path, arguments: list[str], index: str, message: str) -> None:
        self.run([str(python), "-X", "utf8", "-I", "-m", "pip", "install",
                  "--disable-pip-version-check", "--no-input", "--no-deps",
                  "--no-build-isolation", "--prefer-binary", "--progress-bar", "off",
                  "--index-url", index, *arguments], message)

    def prepare(self) -> tuple[Path, Path, Path]:
        self.progress.emit("preparing", "正在准备独立的本机 Python 环境")
        base = Path(sys.base_prefix).resolve()
        copied_base = self.revision / "python"
        if is_within(self.target, base) or is_within(base, self.target):
            raise SetupError("安装目标不得包含内置 Python，也不得位于其目录内。")
        self.revision.mkdir(parents=True, exist_ok=True)
        check_cancelled(self.cancel_file)
        shutil.copytree(base, copied_base, dirs_exist_ok=True)
        copied_python = copied_base / "python.exe"
        if not copied_python.is_file():
            raise SetupError("安装包须包含完整 Windows Python（含 venv 和 ensurepip）。")
        copied_backend = self.revision / "backend"
        copied_backend.mkdir(parents=True, exist_ok=True)
        shutil.copytree(self.backend / "stemwork", copied_backend / "stemwork",
                        dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy2(self.backend / "distribution-manifest.json", copied_backend)
        api, models = self.revision / "api", self.revision / "models"
        for directory in (api, models):
            self.run([str(copied_python), "-X", "utf8", "-I", "-m", "venv", str(directory)],
                     "正在创建识别运行环境", stage="preparing")
            site = directory / "Lib/site-packages"
            # ASCII escaped Python path works with Chinese Windows usernames, even
            # when site.py runs before application UTF-8 configuration.
            (site / "local_recognition_backend.pth").write_text(
                "import sys; sys.path.insert(0, " + ascii(str(copied_backend)) + ")\n", encoding="ascii")
        return api / "Scripts/python.exe", models / "Scripts/python.exe", copied_backend

    def install_packages(self, api: Path, models: Path) -> None:
        for python, name in ((api, "api"), (models, "models")):
            self.pip(python, self.spec["installerPackages"], self.spec["indexes"]["pypi"],
                     "正在准备固定版本的软件安装工具")
            if name == "models":
                torch_lock = self.backend / "requirements-distribution-torch.txt"
                read_pins(torch_lock)
                self.pip(models, ["-r", str(torch_lock)], self.spec["indexes"]["torch"],
                         "正在下载并安装 PyTorch CPU 版")
            lock = self.backend / f"requirements-distribution-{name}.txt"
            read_pins(lock)
            self.pip(python, ["-r", str(lock)], self.spec["indexes"]["pypi"],
                     "正在下载并安装接口依赖" if name == "api" else "正在下载并安装音频模型依赖")

    def install_weights(self) -> Path:
        for model in self.spec["demucs"]:
            repository = self.cache / "huggingface/hub" / ("models--" + model["repo"].replace("/", "--"))
            snapshot = repository / "snapshots" / model["revision"]
            for artifact in model["files"]:
                url = f"https://huggingface.co/{model['repo']}/resolve/{model['revision']}/{artifact['name']}"
                download_verified(url, snapshot / artifact["name"], artifact["bytes"], artifact["sha256"],
                                  self.progress, self.cancel_file)
            refs = repository / "refs"
            refs.mkdir(parents=True, exist_ok=True)
            temporary = refs / f"main.{os.getpid()}.tmp"
            temporary.write_text(model["revision"], encoding="ascii")
            os.replace(temporary, refs / "main")
        piano = self.spec["piano"]
        checkpoint = self.cache / "piano" / piano["name"]
        download_verified(piano["url"], checkpoint, piano["bytes"], piano["sha256"],
                          self.progress, self.cancel_file)
        (checkpoint.parent / "ATTRIBUTION.txt").write_text(
            piano["attribution"] + "\n" + piano["license"] + "\n" + piano["url"] +
            "\nhttps://creativecommons.org/licenses/by/4.0/\n"
            "Unmodified official model weights. Application adapter changes: verified safe loading, "
            "local cache paths, note-event output, and input-duration bounds.\n",
            encoding="utf-8")
        return checkpoint

    def verify(self, api: Path, models: Path, checkpoint: Path) -> None:
        self.progress.emit("verifying", "正在验证 CPU 模型、音频解码和本机接口")
        for python, name in ((api, "api"), (models, "models")):
            pins = read_pins(self.backend / f"requirements-distribution-{name}.txt")
            if name == "models":
                pins.update(read_pins(self.backend / "requirements-distribution-torch.txt"))
            code = (
                "import importlib.metadata as m; pins=" + repr(pins) + "; "
                "bad=[n for n,v in pins.items() if m.version(n)!=v]; "
                "assert not bad, 'Unexpected package versions: '+repr(bad); "
                "import stemwork.main,stemwork.worker; print('Backend imports OK')"
            )
            self.run([str(python), "-X", "utf8", "-I", "-c", code], "正在校验锁定依赖", stage="verifying")
        verification = self.revision / "verify_models.py"
        verification.write_text(VERIFY_MODELS, encoding="utf-8")
        self.run([str(models), "-X", "utf8", "-I", str(verification), str(checkpoint)],
                 "正在加载并验证真实 CPU 模型", stage="verifying")
        self.progress.emit("verifying", "识别环境验证通过")

    def install(self) -> dict:
        api, models, backend = self.prepare()
        self.install_packages(api, models)
        checkpoint = self.install_weights()
        self.verify(api, models, checkpoint)
        return {"schemaVersion": 1, "runtimeRevision": self.spec["runtimeRevision"],
                "python": str(api), "modelPython": str(models), "pianoPython": str(models),
                "pianoCheckpoint": str(checkpoint), "backendDirectory": str(backend),
                "modelCacheDirectory": str(self.cache), "completedAt": utc_now(),
                "device": "cpu"}


VERIFY_MODELS = r'''
import importlib.util, importlib.metadata, json, sys, subprocess, tempfile
from pathlib import Path
import numpy as np
import torch, onnxruntime, soundfile, imageio_ffmpeg
assert torch.version.cuda is None, 'Distribution must use CPU-only PyTorch'
assert not importlib.util.find_spec('tensorflow'), 'TensorFlow must not be installed'
from basic_pitch import ICASSP_2022_MODEL_PATH, FilenameSuffix, build_icassp_2022_model_path
from basic_pitch.inference import Model
path = build_icassp_2022_model_path(FilenameSuffix.onnx)
model = Model(path)
assert model.model_type == Model.MODEL_TYPES.ONNX
from demucs.pretrained import get_model
for name, expected in [('htdemucs', 4), ('htdemucs_6s', 6)]:
    separated = get_model(name)
    assert len(separated.sources) == expected
    del separated
from stemwork.piano_transcription import _load_transcriber
piano = _load_transcriber(Path(sys.argv[1]), 'cpu')
del piano
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
cache = Path(sys.argv[1]).parent.parent
license_directory = cache.parent / 'licenses'
license_directory.mkdir(exist_ok=True)
for option, filename in [('-version', 'ffmpeg-version.txt'), ('-L', 'ffmpeg-license.txt')]:
    with (license_directory / filename).open('wb') as output:
        subprocess.run([ffmpeg, option], check=True, stdout=output, stderr=subprocess.STDOUT,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
components = []
for distribution in importlib.metadata.distributions():
    metadata = distribution.metadata
    license_files = [str(distribution.locate_file(f)) for f in distribution.files or []
                     if any(word in str(f).upper() for word in ('LICENSE', 'NOTICE', 'COPYING'))]
    components.append({'name': metadata['Name'], 'version': distribution.version,
                       'licenseExpression': metadata.get('License-Expression'),
                       'licenseMetadata': metadata.get('License'),
                       'classifiers': metadata.get_all('Classifier') or [],
                       'projectUrls': metadata.get_all('Project-URL') or [],
                       'licenseFiles': license_files})
(license_directory / 'installed-components.json').write_text(json.dumps({
    'components': sorted(components, key=lambda item: item['name'].lower()),
    'reviewNotes': [
        'piano-transcription-inference 0.0.6 declares MIT in metadata; its wheel lacks a license text. Full text pending upstream confirmation.',
        'HTDemucs and HTDemucs-6s model cards lack a separate weight license declaration. Do not infer weight permission from the Demucs MIT code license.',
        'imageio-ffmpeg wrapper license is separate from its bundled executable. See actual ffmpeg-license.txt and ffmpeg-version.txt; Windows wheel binary declares GPL-3.0-or-later.',
    ]}, ensure_ascii=False, indent=2), encoding='utf-8')
with tempfile.TemporaryDirectory(dir=Path(sys.argv[1]).parent) as directory:
    path = Path(directory) / 'verify.wav'
    soundfile.write(path, np.zeros((1600, 2), dtype=np.float32), 16000, subtype='PCM_16')
    data, rate = soundfile.read(path)
    assert rate == 16000 and data.shape == (1600, 2)
print('CPU models, ONNX, FFmpeg and WAV round-trip verified')
'''


def completed_manifest(result: Path, target: Path, revision: str) -> dict | None:
    try:
        value = json.loads(result.read_text(encoding="utf-8"))
        if value.get("schemaVersion") != 1 or value.get("runtimeRevision") != revision:
            return None
        for key in ("python", "modelPython", "pianoPython", "pianoCheckpoint",
                    "backendDirectory", "modelCacheDirectory"):
            path = Path(value[key])
            if not path.is_absolute() or not is_within(path, target) or not path.exists():
                return None
        return value
    except (OSError, ValueError, KeyError, TypeError):
        return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--progress", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--cancel-file", type=Path)
    args = parser.parse_args(argv)
    target, result = args.target.resolve(), args.result.resolve()
    progress = Progress(args.progress.resolve())
    try:
        if result == target or not is_within(result, target) or result == progress.path:
            raise SetupError("完成清单须位于指定运行目录内，且不能与进度文件相同。")
        if os.name != "nt" or sys.version_info[:2] != (3, 11) or platform.architecture()[0] != "64bit":
            raise SetupError("请使用安装包自带的 Windows x64 Python 3.11。")
        backend = find_backend()
        spec = read_spec(backend)
        with installation_lock(target):
            check_cancelled(args.cancel_file)
            existing = completed_manifest(result, target, spec["runtimeRevision"])
            if existing:
                progress.emit("complete", "本机识别环境已准备好", runtimeRevision=spec["runtimeRevision"])
                return 0
            # No completion marker is published until every dependency/model check passed.
            value = Installer(target, backend, spec, progress, args.cancel_file).install()
            check_cancelled(args.cancel_file)
            atomic_json(result, value)
            progress.emit("complete", "本机识别环境已准备好", runtimeRevision=spec["runtimeRevision"])
            return 0
    except SetupBusy:
        # A second invocation must not overwrite the active install's progress.
        return 3
    except (Exception, KeyboardInterrupt) as exc:
        cancelled = isinstance(exc, (SetupCancelled, KeyboardInterrupt))
        progress.emit("failed", str(exc) or "识别环境准备已中断，可重试。", cancelled=cancelled)
        return 2 if cancelled else 1


if __name__ == "__main__":
    raise SystemExit(main())
