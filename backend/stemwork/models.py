from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Note(Contract):
    id: str = Field(min_length=1, max_length=100)
    pitch: int = Field(ge=0, le=127)
    startSeconds: float = Field(ge=0, le=86400)
    durationSeconds: float = Field(gt=0, le=86400)
    velocity: int = Field(ge=1, le=127)


class TrackAnalysis(Contract):
    """Measured source audio levels; this is not instrument confidence."""

    rmsDbfs: float
    peakDbfs: float
    relativeRmsDb: float
    lowSignal: bool
    autoTranscriptionSkipped: bool


class Track(Contract):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["vocal", "drums", "bass", "other", "piano", "guitar", "strings"]
    program: int = Field(ge=0, le=127)
    isDrum: bool = False
    muted: bool = False
    solo: bool = False
    volume: float = Field(default=1, ge=0, le=1)
    pan: float = Field(default=0, ge=-1, le=1)
    audioUrl: str | None = None
    transcriptionStatus: Literal["completed", "unsupported", "failed"] = "completed"
    notes: list[Note] = Field(default_factory=list, max_length=100000)
    warnings: list[str] = Field(default_factory=list)
    analysis: TrackAnalysis | None = None
    transcriptionEngine: Literal["basic_pitch", "piano_highres", "cymbal_onsets"] | None = None

    @model_validator(mode="after")
    def unique_notes(self):
        if len({n.id for n in self.notes}) != len(self.notes):
            raise ValueError("同一音轨的音符 id 必须唯一")
        return self


class Project(Contract):
    id: str
    title: str
    status: Literal["empty", "queued", "processing", "ready", "failed", "cancelled"]
    bpm: float
    timeSignature: Literal["4/4"]
    durationSeconds: float
    revision: int
    createdAt: str
    updatedAt: str
    sourceAudioUrl: str | None = None
    latestJobId: str | None = None
    tracks: list[Track] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class CreateProject(Contract):
    title: str = Field(min_length=1, max_length=200)
    bpm: float = Field(default=120, ge=20, le=300)
    timeSignature: Literal["4/4"] = "4/4"


class SaveProject(Contract):
    expectedRevision: int = Field(ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    bpm: float | None = Field(default=None, ge=20, le=300)
    timeSignature: Literal["4/4"] | None = None
    tracks: list[Track] = Field(max_length=64)

    @model_validator(mode="after")
    def unique_tracks(self):
        if len({t.id for t in self.tracks}) != len(self.tracks):
            raise ValueError("音轨 id 必须唯一")
        return self


class Job(Contract):
    id: str
    projectId: str
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    stage: Literal["queued", "decode", "separate", "transcribe", "merge", "done", "failed", "cancelled"]
    progress: float | None = Field(ge=0, le=1)
    message: str
    error: str | None = None
    createdAt: str
    updatedAt: str


class ProjectList(Contract):
    items: list[Project]


class UploadAccepted(Contract):
    project: Project
    job: Job
