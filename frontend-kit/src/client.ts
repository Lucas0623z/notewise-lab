import type {
  CreateProjectInput,
  Health,
  ServiceStatus,
  Job,
  JobEvent,
  JobEventHandlers,
  JobEventName,
  JobSubscription,
  Project,
  ProjectList,
  RequestOptions,
  SaveProjectInput,
  SubscribeOptions,
  Track,
  UploadAudioInput,
  UploadAudioResult,
} from "./types.js";

export interface ClientOptions {
  /** Origin or proxy prefix, without /api/v1. Empty means same-origin. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  createEventSource?: (url: string, options: EventSourceInit) => EventSource;
}

/** HTTP failures retain FastAPI's original detail and the HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly body: unknown;

  constructor(status: number, detail: unknown, body: unknown) {
    super(errorMessage(status, detail));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
}

function errorMessage(status: number, detail: unknown): string {
  if (typeof detail === "string" && detail) return detail;
  if (detail && typeof detail === "object" && "message" in detail) {
    if (typeof detail.message === "string") return detail.message;
  }
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((item: unknown) => {
      if (
        item &&
        typeof item === "object" &&
        "msg" in item &&
        typeof item.msg === "string"
      ) {
        return [item.msg];
      }
      return [];
    });
    if (messages.length) return messages.join("; ");
  }
  return `Request failed with HTTP ${status}`;
}

function objectDetail(body: unknown): unknown {
  return body && typeof body === "object" && "detail" in body
    ? body.detail
    : body;
}

const JOB_EVENTS: readonly JobEventName[] = [
  "job.updated",
  "track.ready",
  "job.completed",
  "job.failed",
  "job.cancelled",
];

const TERMINAL_EVENTS: ReadonlySet<JobEventName> = new Set([
  "job.completed",
  "job.failed",
  "job.cancelled",
]);

/** Uses browser primitives only. No React, playback, or state library dependency. */
export class StemStudioClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly createEventSource: (
    url: string,
    options: EventSourceInit,
  ) => EventSource;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createEventSource =
      options.createEventSource ?? ((url, init) => new EventSource(url, init));
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  private projectPath(id: string): string {
    return `/projects/${encodeURIComponent(id)}`;
  }

  private jobPath(id: string): string {
    return `/jobs/${encodeURIComponent(id)}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(this.url(path), init);
    const raw = await response.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = raw;
      }
    }
    if (!response.ok)
      throw new ApiError(response.status, objectDetail(body), body);
    if (typeof body === "string" || body === null) {
      throw new Error(
        "The server returned a successful response without a JSON object.",
      );
    }
    return body as T;
  }

  health(options: RequestOptions = {}): Promise<Health> {
    return this.request("/health", options);
  }

  getServiceStatus(options: RequestOptions = {}): Promise<ServiceStatus> {
    return this.request("/system/status", options);
  }

  listProjects(options: RequestOptions = {}): Promise<ProjectList> {
    return this.request("/projects", options);
  }

  createProject(
    input: CreateProjectInput,
    options: RequestOptions = {},
  ): Promise<Project> {
    return this.request("/projects", {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  getProject(id: string, options: RequestOptions = {}): Promise<Project> {
    return this.request(this.projectPath(id), options);
  }

  saveProject(
    id: string,
    input: SaveProjectInput,
    options: RequestOptions = {},
  ): Promise<Project> {
    return this.request(this.projectPath(id), {
      ...options,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  uploadAudio(
    id: string,
    input: UploadAudioInput,
    options: RequestOptions = {},
  ): Promise<UploadAudioResult> {
    const form = new FormData();
    if (input.filename !== undefined)
      form.append("file", input.file, input.filename);
    else form.append("file", input.file);
    form.append("mode", input.mode ?? "demucs_basic_pitch");
    form.append("separationModel", input.separationModel ?? "htdemucs");
    form.append("device", input.device ?? "auto");
    form.append(
      "transcriptionModel",
      input.transcriptionModel ?? "basic_pitch",
    );
    form.append("drumTranscription", input.drumTranscription ?? "none");
    if (input.bpm !== undefined) form.append("bpm", String(input.bpm));
    // The browser supplies the multipart boundary; do not set Content-Type here.
    return this.request(`${this.projectPath(id)}/audio`, {
      ...options,
      method: "POST",
      body: form,
    });
  }

  getJob(id: string, options: RequestOptions = {}): Promise<Job> {
    return this.request(this.jobPath(id), options);
  }

  cancelJob(id: string, options: RequestOptions = {}): Promise<Job> {
    return this.request(`${this.jobPath(id)}/cancel`, {
      ...options,
      method: "POST",
    });
  }

  projectMidiUrl(projectId: string): string {
    return this.url(`${this.projectPath(projectId)}/export.mid`);
  }

  originalAudioUrl(projectId: string): string {
    return this.url(`${this.projectPath(projectId)}/audio/original`);
  }

  trackAudioUrl(projectId: string, trackId: string): string {
    return this.url(
      `${this.projectPath(projectId)}/tracks/${encodeURIComponent(trackId)}/audio`,
    );
  }

  trackMidiUrl(projectId: string, trackId: string): string {
    return this.url(
      `${this.projectPath(projectId)}/tracks/${encodeURIComponent(trackId)}/export.mid`,
    );
  }

  /** Resolve a URL returned by the API when using a different API origin. */
  resolveAssetUrl(url: string | null): string | null {
    if (url === null) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("/api/v1/")) return `${this.baseUrl}${url}`;
    throw new Error("Expected an HTTP(S) URL or an /api/v1/ asset path.");
  }

  subscribeToJob(
    id: string,
    handlers: JobEventHandlers,
    options: SubscribeOptions = {},
  ): JobSubscription {
    const source = this.createEventSource(
      this.url(`${this.jobPath(id)}/events`),
      {
        withCredentials: options.withCredentials ?? false,
      },
    );
    let closed = false;
    let lastEventId: string | null = null;
    const listeners: Array<[string, EventListener]> = [];

    const add = (name: string, listener: EventListener): void => {
      source.addEventListener(name, listener);
      listeners.push([name, listener]);
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      for (const [name, listener] of listeners)
        source.removeEventListener(name, listener);
      source.close();
      handlers.onConnectionChange?.("closed");
    };

    add("open", () => {
      if (!closed) handlers.onConnectionChange?.("open");
    });
    add("error", (event) => {
      if (closed) return;
      if (source.readyState === 2) close();
      else handlers.onConnectionChange?.("reconnecting");
      handlers.onConnectionError?.(event);
    });

    for (const name of JOB_EVENTS) {
      add(name, (event) => {
        if (closed) return;
        const message = event as MessageEvent<string>;
        let data: unknown;
        try {
          data = JSON.parse(message.data) as unknown;
          if (
            !data ||
            typeof data !== "object" ||
            !("id" in data) ||
            typeof data.id !== "string"
          ) {
            throw new Error(`Invalid payload for ${name}`);
          }
        } catch (error) {
          handlers.onInvalidEvent?.(
            error instanceof Error ? error : new Error(String(error)),
            message,
          );
          return;
        }
        if (message.lastEventId) lastEventId = message.lastEventId;
        const jobEvent: JobEvent =
          name === "track.ready"
            ? { type: name, data: data as Track, id: message.lastEventId }
            : { type: name, data: data as Job, id: message.lastEventId };
        try {
          handlers.onEvent(jobEvent);
        } finally {
          if (TERMINAL_EVENTS.has(name)) close();
        }
      });
    }

    handlers.onConnectionChange?.("connecting");
    return { close, getLastEventId: () => lastEventId };
  }
}
