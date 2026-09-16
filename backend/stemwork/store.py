"""Durable local queue and projects. All multi-record mutations are transactional."""
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

TERMINAL = {"succeeded", "failed", "cancelled"}


def now():
    return datetime.now(timezone.utc).isoformat()


class Missing(KeyError):
    pass


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, data_dir: Path):
        self.root = data_dir.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = self.root / "studio.sqlite3"
        with self.connect() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, doc TEXT NOT NULL, original_path TEXT,
                    source_duration REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, doc TEXT NOT NULL,
                    input_path TEXT NOT NULL, output_dir TEXT NOT NULL, options TEXT NOT NULL,
                    cancel_requested INTEGER NOT NULL DEFAULT 0, heartbeat REAL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
                    event TEXT NOT NULL, data TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS events_job ON events(job_id, id);
                CREATE TABLE IF NOT EXISTS assets (
                    project_id TEXT NOT NULL, track_id TEXT NOT NULL, path TEXT NOT NULL,
                    PRIMARY KEY(project_id, track_id)
                );
            """)
            if "source_duration" not in {r[1] for r in c.execute("PRAGMA table_info(projects)")}:
                c.execute("ALTER TABLE projects ADD COLUMN source_duration REAL NOT NULL DEFAULT 0")

    @contextmanager
    def connect(self, write=False):
        c = sqlite3.connect(self.db, timeout=15, isolation_level=None)
        c.row_factory = sqlite3.Row
        try:
            if write:
                c.execute("BEGIN IMMEDIATE")
            yield c
            if write:
                c.commit()
        except BaseException:
            if write:
                c.rollback()
            raise
        finally:
            c.close()

    def _read(self, c, table, id):
        row = c.execute(f"SELECT * FROM {table} WHERE id=?", (id,)).fetchone()
        if row is None:
            raise Missing(id)
        return row, json.loads(row["doc"])

    def _put(self, c, table, doc):
        c.execute(f"UPDATE {table} SET doc=? WHERE id=?", (json.dumps(doc), doc["id"]))

    def _event(self, c, job_id, event, data):
        c.execute("INSERT INTO events(job_id,event,data) VALUES (?,?,?)", (job_id, event, json.dumps(data)))

    def create_project(self, title, bpm=120, time_signature="4/4"):
        stamp = now()
        doc = dict(id=uuid.uuid4().hex, title=title, status="empty", bpm=bpm,
                   timeSignature=time_signature, durationSeconds=0, revision=0,
                   createdAt=stamp, updatedAt=stamp, sourceAudioUrl=None, latestJobId=None, tracks=[], warnings=[])
        with self.connect(write=True) as c:
            c.execute("INSERT INTO projects(id,doc) VALUES (?,?)", (doc["id"], json.dumps(doc)))
        return doc

    def projects(self):
        with self.connect() as c:
            docs = [json.loads(r[0]) for r in c.execute("SELECT doc FROM projects")]
        return sorted(docs, key=lambda p: p["updatedAt"], reverse=True)

    def project(self, id):
        with self.connect() as c:
            return self._read(c, "projects", id)[1]

    def job(self, id):
        with self.connect() as c:
            return self._read(c, "jobs", id)[1]

    def save_project(self, id, edit):
        with self.connect(write=True) as c:
            row, doc = self._read(c, "projects", id)
            if doc["revision"] != edit["expectedRevision"]:
                raise Conflict("项目已发生变化，请重新加载后合并修改")
            if doc["status"] in {"queued", "processing"}:
                raise Conflict("转录期间不能覆盖工程，请等待任务结束")
            previous = {t["id"]: t for t in doc["tracks"]}
            tracks = edit["tracks"]
            for track in tracks:
                track["audioUrl"] = previous.get(track["id"], {}).get("audioUrl")
                # Source measurements are server-owned, just like audio assets.
                # An older client may omit this field; a new client may send a
                # stale or forged value. Neither can erase or replace it.
                track["analysis"] = previous.get(track["id"], {}).get("analysis")
                track["transcriptionEngine"] = previous.get(track["id"], {}).get("transcriptionEngine")
            for key in ("title", "bpm", "timeSignature"):
                if edit.get(key) is not None:
                    doc[key] = edit[key]
            doc.update(tracks=tracks, revision=doc["revision"] + 1, updatedAt=now())
            doc["durationSeconds"] = max(row["source_duration"], max(
                (n["startSeconds"] + n["durationSeconds"] for t in tracks for n in t["notes"]), default=0))
            if tracks:
                doc["status"] = "ready"
            self._put(c, "projects", doc)
        return doc

    def enqueue(self, project_id, input_path: Path, options):
        with self.connect(write=True) as c:
            _, project = self._read(c, "projects", project_id)
            if project["status"] in {"queued", "processing", "ready"} or project["tracks"]:
                raise Conflict("这个项目已有任务或结果，请新建项目后上传")
            job_id = uuid.uuid4().hex
            stamp = now()
            job = dict(id=job_id, projectId=project_id, status="queued", stage="queued",
                       progress=0, message="等待模型任务进程", error=None, createdAt=stamp, updatedAt=stamp)
            output_dir = self.root / "projects" / project_id / "jobs" / job_id
            c.execute("INSERT INTO jobs(id,project_id,doc,input_path,output_dir,options) VALUES (?,?,?,?,?,?)",
                      (job_id, project_id, json.dumps(job), str(input_path), str(output_dir), json.dumps(options)))
            project.update(status="queued", updatedAt=stamp, revision=project["revision"] + 1,
                           bpm=options["bpm"], latestJobId=job_id,
                           sourceAudioUrl=f"/api/v1/projects/{project_id}/audio/original")
            self._put(c, "projects", project)
            c.execute("UPDATE projects SET original_path=? WHERE id=?", (str(input_path), project_id))
            self._event(c, job_id, "job.updated", job)
        return {"project": project, "job": job}

    def claim(self):
        with self.connect(write=True) as c:
            row = c.execute("SELECT * FROM jobs WHERE json_extract(doc,'$.status')='queued' ORDER BY rowid LIMIT 1").fetchone()
            if row is None:
                return None
            job = json.loads(row["doc"])
            job.update(status="running", stage="decode", message="准备读取音频", updatedAt=now())
            self._put(c, "jobs", job)
            c.execute("UPDATE jobs SET heartbeat=? WHERE id=?", (time.time(), job["id"]))
            _, project = self._read(c, "projects", job["projectId"])
            project.update(status="processing", updatedAt=now(), revision=project["revision"] + 1)
            self._put(c, "projects", project)
            self._event(c, job["id"], "job.updated", job)
            return {**job, "inputPath": row["input_path"], "outputDir": row["output_dir"], "options": json.loads(row["options"])}

    def heartbeat(self, job_id):
        with self.connect(write=True) as c:
            c.execute("UPDATE jobs SET heartbeat=? WHERE id=?", (time.time(), job_id))

    def is_cancelled(self, job_id):
        with self.connect() as c:
            row, job = self._read(c, "jobs", job_id)
            return bool(row["cancel_requested"]) or job["status"] in TERMINAL

    def progress(self, job_id, stage, progress, message):
        with self.connect(write=True) as c:
            _, job = self._read(c, "jobs", job_id)
            if job["status"] in TERMINAL:
                return
            job.update(stage=stage, progress=progress, message=message, updatedAt=now())
            self._put(c, "jobs", job)
            self._event(c, job_id, "job.updated", job)

    def emit_track(self, job_id, track, audio_path=None):
        with self.connect(write=True) as c:
            row, job = self._read(c, "jobs", job_id)
            if job["status"] in TERMINAL or row["cancel_requested"]:
                return
            _, project = self._read(c, "projects", job["projectId"])
            tracks = {t["id"]: t for t in project["tracks"]}
            tracks[track["id"]] = track
            project.update(tracks=list(tracks.values()), revision=project["revision"] + 1, updatedAt=now())
            project["durationSeconds"] = max(project["durationSeconds"], max(
                (n["startSeconds"] + n["durationSeconds"] for n in track["notes"]), default=0))
            self._put(c, "projects", project)
            if audio_path:
                c.execute("INSERT OR REPLACE INTO assets(project_id,track_id,path) VALUES (?,?,?)",
                          (project["id"], track["id"], audio_path))
            self._event(c, job_id, "track.ready", track)

    def cancel(self, job_id):
        with self.connect(write=True) as c:
            _, job = self._read(c, "jobs", job_id)
            if job["status"] in TERMINAL:
                return job
            c.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (job_id,))
            if job["status"] == "queued":
                return self._finish(c, job, "cancelled", None, None)
            job.update(message="已请求取消，正在停止模型处理", updatedAt=now())
            self._put(c, "jobs", job)
            self._event(c, job_id, "job.updated", job)
            return job

    def finish(self, job_id, result=None, error=None, cancelled=False):
        with self.connect(write=True) as c:
            row, job = self._read(c, "jobs", job_id)
            if job["status"] in TERMINAL:
                return job
            status = "cancelled" if cancelled or row["cancel_requested"] else "failed" if error else "succeeded"
            return self._finish(c, job, status, result, error)

    def _finish(self, c, job, status, result, error):
        stage = {"succeeded": "done", "failed": "failed", "cancelled": "cancelled"}[status]
        message = {"succeeded": "转录完成", "failed": "处理失败", "cancelled": "任务已取消"}[status]
        job.update(status=status, stage=stage, message=message, error=error if status == "failed" else None,
                   progress=1 if status == "succeeded" else job["progress"], updatedAt=now())
        _, project = self._read(c, "projects", job["projectId"])
        project.update(status="ready" if status == "succeeded" else status, updatedAt=now(), revision=project["revision"] + 1)
        if status == "succeeded":
            project.update(tracks=result["tracks"], bpm=result["bpm"], durationSeconds=result["durationSeconds"], warnings=result["warnings"])
            c.execute("UPDATE projects SET source_duration=? WHERE id=?", (result["durationSeconds"], project["id"]))
            for track_id, path in result.get("assets", {}).items():
                c.execute("INSERT OR REPLACE INTO assets(project_id,track_id,path) VALUES (?,?,?)", (project["id"], track_id, path))
        elif project["tracks"]:
            project["warnings"] = ["任务未完整结束；已保留部分音轨。请新建项目重试，避免覆盖当前结果。"]
        self._put(c, "projects", project)
        self._put(c, "jobs", job)
        self._event(c, job["id"], {"succeeded": "job.completed", "failed": "job.failed", "cancelled": "job.cancelled"}[status], job)
        return job

    def recover_stale(self, stale_seconds=90):
        with self.connect(write=True) as c:
            rows = c.execute("SELECT doc FROM jobs WHERE json_extract(doc,'$.status')='running' AND (heartbeat IS NULL OR heartbeat<?)",
                             (time.time() - stale_seconds,)).fetchall()
            for row in rows:
                self._finish(c, json.loads(row[0]), "failed", None, "任务进程中断，原始音频已保留；请重试上传")
            return len(rows)

    def events(self, job_id, after=0):
        with self.connect() as c:
            return [dict(id=r["id"], event=r["event"], data=json.loads(r["data"])) for r in c.execute(
                "SELECT id,event,data FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT 200", (job_id, after))]

    def asset(self, project_id, track_id=None):
        with self.connect() as c:
            row, _ = self._read(c, "projects", project_id)
            if track_id is None:
                path = row["original_path"]
            else:
                r = c.execute("SELECT path FROM assets WHERE project_id=? AND track_id=?", (project_id, track_id)).fetchone()
                path = r[0] if r else None
        if not path:
            raise Missing("没有音频文件")
        resolved = Path(path).resolve()
        if not resolved.is_relative_to(self.root) or not resolved.is_file():
            raise Missing("文件不可用")
        return resolved
