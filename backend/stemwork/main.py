import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from .config import Settings
from .midi import export_midi
from .models import CreateProject, Job, Project, ProjectList, SaveProject, UploadAccepted
from .service_status import SystemStatus, get_system_status
from .store import Conflict, Missing, Store, TERMINAL


def check_audio_header(extension: str, header: bytes):
    if extension == ".wav":
        return len(header) >= 12 and header[:4] in {b"RIFF", b"RF64"} and header[8:12] == b"WAVE"
    if extension == ".flac":
        return header.startswith(b"fLaC")
    if extension == ".mp3":
        return header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 255 and header[1] & 224 == 224)
    return False


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings.data_dir)
    app = FastAPI(title="Stem Studio API", version="0.1.0", description="本机单用户音乐转录 API；模型由独立 worker 执行。")
    app.state.store = store
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                       allow_methods=["GET", "POST", "PUT"], allow_headers=["Content-Type", "Last-Event-ID"],
                       expose_headers=["Content-Disposition"])

    @app.exception_handler(Missing)
    async def missing_handler(request, exc):
        return JSONResponse(status_code=404, content={"detail": "项目、任务或文件不存在"})

    @app.exception_handler(Conflict)
    async def conflict_handler(request, exc):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.get("/api/v1/health")
    def health():
        return {"status": "ok", "version": "0.1.0", "instanceId": os.environ.get("STUDIO_INSTANCE_ID")}

    @app.get("/api/v1/system/status", response_model=SystemStatus)
    def system_status():
        return get_system_status(store.root)

    @app.get("/api/v1/projects", response_model=ProjectList)
    def list_projects():
        return {"items": store.projects()}

    @app.post("/api/v1/projects", response_model=Project, status_code=201)
    def create_project(body: CreateProject):
        if not body.title.strip():
            raise HTTPException(422, "项目名称不能为空")
        return store.create_project(body.title.strip(), body.bpm, body.timeSignature)

    @app.get("/api/v1/projects/{project_id}", response_model=Project)
    def get_project(project_id: str):
        return store.project(project_id)

    @app.put("/api/v1/projects/{project_id}", response_model=Project)
    def save_project(project_id: str, body: SaveProject):
        if body.title is not None and not body.title.strip():
            raise HTTPException(422, "项目名称不能为空")
        return store.save_project(project_id, body.model_dump())

    @app.post("/api/v1/projects/{project_id}/audio", response_model=UploadAccepted, status_code=202)
    async def upload_audio(
        project_id: str,
        file: Annotated[UploadFile, File()],
        mode: Annotated[Literal["demucs_basic_pitch", "transcribe_only"], Form()] = "demucs_basic_pitch",
        separationModel: Annotated[Literal["htdemucs", "htdemucs_6s"], Form()] = "htdemucs",
        device: Annotated[Literal["auto", "cpu", "cuda"], Form()] = "auto",
        transcriptionModel: Annotated[Literal["basic_pitch", "piano_highres"], Form()] = "basic_pitch",
        drumTranscription: Annotated[Literal["none", "cymbal_onsets"], Form()] = "none",
        bpm: Annotated[float | None, Form(ge=20, le=300)] = None,
    ):
        project = store.project(project_id)
        if mode == "demucs_basic_pitch" and transcriptionModel == "piano_highres" and separationModel != "htdemucs_6s":
            raise HTTPException(422, "钢琴专用转录在分轨模式下需要选择六轨模型。")
        if mode == "transcribe_only" and drumTranscription != "none":
            raise HTTPException(422, "镲片击打点提取需要先分离鼓音轨。")
        extension = Path(file.filename or "").suffix.lower()
        if extension not in {".wav", ".mp3", ".flac"}:
            raise HTTPException(415, "支持 WAV、MP3、FLAC 音频")
        directory = store.root / "projects" / project_id / "uploads"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{uuid.uuid4().hex}{extension}"
        temporary = path.with_suffix(".part")
        size, header = 0, b""
        accepted = False
        try:
            with temporary.open("wb") as dest:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        raise HTTPException(413, f"音频不能超过 {settings.max_upload_bytes // (1024 * 1024)} MB")
                    if not header:
                        header = chunk[:16]
                    dest.write(chunk)
            if not check_audio_header(extension, header):
                raise HTTPException(415, "文件内容与音频格式不匹配，或文件为空")
            os.replace(temporary, path)
            result = store.enqueue(project_id, path, dict(mode=mode, separationModel=separationModel,
                                                           transcriptionModel=transcriptionModel, drumTranscription=drumTranscription,
                                                           device=device, bpm=bpm if bpm is not None else project["bpm"]))
            accepted = True
            return result
        finally:
            await file.close()
            temporary.unlink(missing_ok=True)
            if not accepted:
                path.unlink(missing_ok=True)

    @app.get("/api/v1/jobs/{job_id}", response_model=Job)
    def get_job(job_id: str):
        return store.job(job_id)

    @app.post("/api/v1/jobs/{job_id}/cancel", response_model=Job)
    def cancel_job(job_id: str):
        return store.cancel(job_id)

    @app.get("/api/v1/jobs/{job_id}/events")
    async def events(job_id: str, request: Request, last_event_id: Annotated[str | None, Header()] = None):
        store.job(job_id)
        try:
            cursor = max(0, int(last_event_id or 0))
        except ValueError:
            raise HTTPException(400, "Last-Event-ID 必须为整数")

        async def stream():
            nonlocal cursor
            idle = 0
            while not await request.is_disconnected():
                batch = store.events(job_id, cursor)
                if not batch and store.job(job_id)["status"] in TERMINAL:
                    # The terminal transition and its event commit atomically. Re-read
                    # after observing the terminal state so a racing completion is delivered.
                    batch = store.events(job_id, cursor)
                    if not batch:
                        return
                for item in batch:
                    cursor = item["id"]
                    yield f"id: {cursor}\nevent: {item['event']}\ndata: {json.dumps(item['data'], ensure_ascii=False)}\n\n"
                if batch:
                    idle = 0
                    continue
                idle += 1
                if idle % 20 == 0:
                    yield ": heartbeat\n\n"
                await asyncio.sleep(0.5)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/v1/projects/{project_id}/audio/original")
    def original_audio(project_id: str):
        path = store.asset(project_id)
        return FileResponse(path, filename=f"original{path.suffix}")

    @app.get("/api/v1/projects/{project_id}/tracks/{track_id}/audio")
    def track_audio(project_id: str, track_id: str):
        project = store.project(project_id)
        if not any(t["id"] == track_id for t in project["tracks"]):
            raise Missing(track_id)
        path = store.asset(project_id, track_id)
        return FileResponse(path, media_type="audio/wav", filename=f"{track_id}.wav")

    def midi_response(project_id, track_id=None):
        project = store.project(project_id)
        if project["status"] in {"queued", "processing"}:
            raise Conflict("任务仍在处理中，请等待后再导出")
        try:
            content = export_midi(project, track_id)
        except KeyError:
            raise Missing(track_id)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        return Response(content, media_type="audio/midi", headers={
            "Content-Disposition": f'attachment; filename="{track_id or project_id}.mid"'
        })

    @app.get("/api/v1/projects/{project_id}/export.mid")
    def project_midi(project_id: str):
        return midi_response(project_id)

    @app.get("/api/v1/projects/{project_id}/tracks/{track_id}/export.mid")
    def track_midi(project_id: str, track_id: str):
        return midi_response(project_id, track_id)

    return app
