"""Run separately: python -m stemwork.worker [--once]."""
import argparse
import logging
import threading
import time
from pathlib import Path

from .config import Settings
from .models import Track
from .service_status import WorkerHeartbeat
from .store import Store

log = logging.getLogger("stemwork.worker")


def process_one(store: Store, pipeline=None):
    from .pipeline import PipelineCancelled, run_pipeline

    pipeline = pipeline or run_pipeline
    job = store.claim()
    if job is None:
        return False
    stop = threading.Event()

    def heartbeat():
        while not stop.wait(5):
            store.heartbeat(job["id"])

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    assets = {}

    def normalize(raw):
        track = dict(raw)
        path = track.pop("audioPath", None)
        if path:
            resolved = Path(path).resolve()
            if not resolved.is_relative_to(store.root) or not resolved.is_file():
                raise ValueError("模型返回的音频文件不在工程目录内")
            assets[track["id"]] = str(resolved)
        track["audioUrl"] = f"/api/v1/projects/{job['projectId']}/tracks/{track['id']}/audio" if path else None
        return Track.model_validate(track).model_dump()

    def track_ready(raw):
        track = normalize(raw)
        store.emit_track(job["id"], track, assets.get(track["id"]))

    try:
        result = pipeline(
            Path(job["inputPath"]), Path(job["outputDir"]), job["options"],
            lambda stage, progress, message: store.progress(job["id"], stage, progress, message),
            track_ready,
            lambda: store.is_cancelled(job["id"]),
        )
        result = {**result, "tracks": [normalize(t) for t in result["tracks"]], "assets": assets}
        store.finish(job["id"], result=result)
    except PipelineCancelled:
        store.finish(job["id"], cancelled=True)
    except KeyboardInterrupt:
        store.finish(job["id"], cancelled=True)
        raise
    except Exception as exc:
        log.exception("Job %s failed", job["id"])
        store.finish(job["id"], error=str(exc)[:2000] or type(exc).__name__)
    finally:
        stop.set()
        thread.join(timeout=6)
    return True


def main():
    parser = argparse.ArgumentParser(description="本地音频转录任务进程")
    parser.add_argument("--once", action="store_true", help="处理至多一个任务后退出")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = Store(Settings.from_env().data_dir)
    with WorkerHeartbeat(store.root):
        while True:
            recovered = store.recover_stale()
            if recovered:
                log.warning("Recovered %d interrupted job(s)", recovered)
            worked = process_one(store)
            if args.once:
                return
            if not worked:
                time.sleep(1)


if __name__ == "__main__":
    main()
