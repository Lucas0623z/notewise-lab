"""Fetch the verified, relocatable CPython included with the Windows installer.

Build-time only: does not touch the developer's Python installation or user data.
Run with Python 3.11+ from any directory. The resulting tree is ignored by Git.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BUILD_ROOT = ROOT / "frontend" / "build-resources"
VERSION = "3.11.16"
BUILD = "20260901"
FILENAME = f"cpython-{VERSION}+{BUILD}-x86_64-pc-windows-msvc-install_only.tar.gz"
URL = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/"
    f"{BUILD}/{FILENAME.replace('+', '%2B')}"
)
SHA256 = "6be524fa6752af802146a4adc7d098565425b0b1c166e19a5a7a4c8cccb86bf6"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def remove_build_tree(path: Path) -> None:
    resolved = path.resolve()
    if resolved == BUILD_ROOT.resolve() or not resolved.is_relative_to(BUILD_ROOT.resolve()):
        raise ValueError(f"Refusing to remove path outside build resources: {resolved}")
    if resolved.exists():
        shutil.rmtree(resolved)


def prepare(cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / FILENAME
    if not archive.is_file() or digest(archive) != SHA256:
        partial = archive.with_name(archive.name + ".partial")
        request = urllib.request.Request(URL, headers={"User-Agent": "StemStudio-Builder"})
        print(f"Downloading verified CPython {VERSION} ({BUILD})", flush=True)
        with urllib.request.urlopen(request, timeout=90) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        if digest(partial) != SHA256:
            partial.unlink(missing_ok=True)
            raise RuntimeError("CPython archive SHA256 mismatch")
        partial.replace(archive)

    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="python-stage-", dir=BUILD_ROOT))
    try:
        with tarfile.open(archive, "r:gz") as source:
            members = source.getmembers()
            for member in members:
                parts = PurePosixPath(member.name).parts
                if (
                    not parts or parts[0] != "python" or ".." in parts
                    or PurePosixPath(member.name).is_absolute()
                    or "\\" in member.name or ":" in member.name
                    or not (member.isfile() or member.isdir())
                ):
                    raise RuntimeError(f"Unsafe archive entry: {member.name}")
            source.extractall(staging, members=members, filter="data")
        python = staging / "python"
        for required in ("python.exe", "pythonw.exe", "LICENSE.txt", "Lib/venv/__init__.py"):
            if not (python / required).is_file():
                raise RuntimeError(f"Missing portable Python file: {required}")
        runtime = BUILD_ROOT / "runtime"
        runtime.mkdir(exist_ok=True)
        destination = runtime / "python"
        remove_build_tree(destination)
        shutil.copytree(python, destination)
        (runtime / "python-source.json").write_text(
            json.dumps({
                "version": VERSION, "build": BUILD, "url": URL,
                "sha256": SHA256, "architecture": "windows-x86_64",
                "upstream": "https://github.com/astral-sh/python-build-standalone",
            }, indent=2) + "\n", encoding="utf-8",
        )
        print(f"Prepared: {destination}", flush=True)
        return destination
    finally:
        remove_build_tree(staging)


def prepare_backend() -> None:
    # A whitelist keeps tests, caches, user audio and local configuration out of
    # the installer, including electron-builder's unfiltered integrity scan.
    source = ROOT / "backend"
    destination = BUILD_ROOT / "backend"
    remove_build_tree(destination)
    destination.mkdir(parents=True)
    for filename in ["pyproject.toml", "distribution-manifest.json"]:
        shutil.copy2(source / filename, destination / filename)
    for entry in (source / "stemwork").rglob("*.py"):
        if "__pycache__" in entry.parts:
            continue
        output = destination / entry.relative_to(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(entry, output)
    for entry in source.glob("requirements-distribution*.txt"):
        shutil.copy2(entry, destination / entry.name)
    if (source / "third-party").is_dir():
        shutil.copytree(source / "third-party", destination / "third-party")
    shutil.copy2(ROOT / "scripts/setup_runtime.py", destination / "setup_runtime.py")
    print(f"Prepared backend: {destination}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=BUILD_ROOT / "download-cache")
    parser.add_argument("--backend-only", action="store_true")
    args = parser.parse_args()
    if not args.backend_only:
        prepare(args.cache.resolve())
    prepare_backend()
