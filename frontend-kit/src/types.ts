/** The API uses seconds for note times and zero-based MIDI program numbers. */
export interface Note {
  id: string;
  /** Integer, 0–127. */
  pitch: number;
  startSeconds: number;
  durationSeconds: number;
  /** Integer, 1–127. */
  velocity: number;
}

export type TrackKind =
  | "vocal"
  | "drums"
  | "bass"
  | "other"
  | "piano"
  | "guitar"
  | "strings";

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** Integer, 0–127. */
  program: number;
  isDrum: boolean;
  muted: boolean;
  solo: boolean;
  /** Range 0–1. */
  volume: number;
  /** Range -1–1. */
  pan: number;
  audioUrl: string | null;
  transcriptionStatus: "completed" | "unsupported" | "failed";
  /** Server-owned provenance; absent on legacy projects. */
  transcriptionEngine?:
    | "basic_pitch"
    | "piano_highres"
    | "cymbal_onsets"
    | null;
  notes: Note[];
  warnings: string[];
  /** Measured audio levels, not instrument detection; absent on older projects. */
  analysis?: {
    rmsDbfs: number;
    peakDbfs: number;
    relativeRmsDb: number;
    lowSignal: boolean;
    autoTranscriptionSkipped: boolean;
  } | null;
}

export type ProjectStatus =
  | "empty"
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled";

export interface Project {
  id: string;
  title: string;
  status: ProjectStatus;
  bpm: number;
  /** The first version supports 4/4 only. */
  timeSignature: "4/4";
  durationSeconds: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceAudioUrl: string | null;
  /** Latest uploaded job, retained after completion; null before the first upload. */
  latestJobId: string | null;
  tracks: Track[];
  warnings: string[];
}

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type JobStage =
  | "queued"
  | "decode"
  | "separate"
  | "transcribe"
  | "merge"
  | "done"
  | "failed"
  | "cancelled";

export interface Job {
  id: string;
  projectId: string;
  status: JobStatus;
  stage: JobStage;
  /** Range 0–1; null means indeterminate. Never replace this with a simulated timer. */
  progress: number | null;
  message: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Health {
  status: "ok";
  version: "0.1.0";
  instanceId?: string | null;
}

export interface ServiceStatus {
  status: "ready" | "starting" | "unavailable";
  apiReady: boolean;
  workerReady: boolean;
  capabilities: {
    transcribeOnly: boolean;
    separate4: boolean;
    separate6: boolean;
    pianoTranscription?: boolean;
    cymbalOnsets?: boolean;
  };
  message: string;
  /** Desktop first-run setup; absent for an externally configured API. */
  setup?: {
    stage:
      | "preparing"
      | "downloading"
      | "installing"
      | "verifying"
      | "complete"
      | "failed";
    message: string;
    /** Actual current download bytes; null when the installer has no byte count. */
    bytesDownloaded: number | null;
    totalBytes: number | null;
    logPath?: string;
    logTail?: string;
  } | null;
}

export interface ProjectList {
  items: Project[];
}

export interface CreateProjectInput {
  title: string;
  bpm?: number;
  timeSignature?: "4/4";
}

export interface SaveProjectInput {
  expectedRevision: number;
  title?: string;
  bpm?: number;
  timeSignature?: "4/4";
  tracks: Track[];
}

interface UploadAudioOptions {
  mode?: "demucs_basic_pitch" | "transcribe_only";
  separationModel?: "htdemucs" | "htdemucs_6s";
  transcriptionModel?: "basic_pitch" | "piano_highres";
  drumTranscription?: "none" | "cymbal_onsets";
  device?: "auto" | "cpu" | "cuda";
  bpm?: number;
}

/** A plain Blob needs a filename with a supported extension; File preserves its name. */
export type UploadAudioInput = UploadAudioOptions &
  ({ file: File; filename?: string } | { file: Blob; filename: string });

export interface UploadAudioResult {
  project: Project;
  job: Job;
}

export type JobEventName =
  | "job.updated"
  | "track.ready"
  | "job.completed"
  | "job.failed"
  | "job.cancelled";

export type JobEvent =
  | { type: "track.ready"; data: Track; id: string }
  | { type: Exclude<JobEventName, "track.ready">; data: Job; id: string };

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface JobEventHandlers {
  onEvent: (event: JobEvent) => void;
  onConnectionChange?: (state: ConnectionState) => void;
  /** Transport errors reconnect automatically; this is not a failed AI job. */
  onConnectionError?: (event: Event) => void;
  onInvalidEvent?: (error: Error, event: MessageEvent<string>) => void;
}

export interface JobSubscription {
  close(): void;
  getLastEventId(): string | null;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface SubscribeOptions {
  withCredentials?: boolean;
}
