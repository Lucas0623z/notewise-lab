import { create } from "zustand";
import type { Note, Project, Track } from "../types";
import { snapSeconds, type Snap } from "../lib/music";

const HISTORY_LIMIT = 50;
const MAX_SECONDS = 86_400;
const MIN_DURATION_SECONDS = 0.01;

export interface EditorState {
  project: Project | null;
  selectedTrackId: string | null;
  selectedNoteIds: string[];
  snap: Snap;
  pixelsPerSecond: number;
  dirty: boolean;
  past: Project[];
  future: Project[];
  clipboard: Note[];
  loadProject(project: Project, force?: boolean): void;
  selectTrack(trackId: string | null): void;
  setSelection(noteIds: string[]): void;
  setSnap(snap: Snap): void;
  setPixelsPerSecond(pixelsPerSecond: number): void;
  rename(title: string): void;
  setBpm(bpm: number): void;
  patchTrack(trackId: string, patch: Partial<Track>): void;
  clearSolo(): void;
  setNotes(trackId: string, notes: Note[]): void;
  updateSelectedNotes(patch: Partial<Note>): void;
  deleteSelected(): void;
  copySelected(): void;
  pasteAt(seconds: number): void;
  undo(): void;
  redo(): void;
  markSaved(serverProject: Project, submittedProject: Project): void;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function validNote(note: Note): Note {
  return {
    id: note.id,
    pitch: Math.round(clamp(note.pitch, 0, 127, 60)),
    startSeconds: clamp(note.startSeconds, 0, MAX_SECONDS, 0),
    durationSeconds: clamp(
      note.durationSeconds,
      MIN_DURATION_SECONDS,
      MAX_SECONDS,
      MIN_DURATION_SECONDS,
    ),
    velocity: Math.round(clamp(note.velocity, 1, 127, 100)),
  };
}

function validNotes(notes: readonly Note[]): Note[] {
  const seen = new Set<string>();
  return notes.flatMap((note) => {
    if (!note.id || seen.has(note.id)) return [];
    seen.add(note.id);
    return [validNote(note)];
  });
}

function editable(project: Project): string {
  return JSON.stringify({
    title: project.title,
    bpm: project.bpm,
    timeSignature: project.timeSignature,
    // Audio measurements are server metadata, not unsaved user edits.
    tracks: project.tracks.map((track) => ({
      ...track,
      analysis: undefined,
      transcriptionEngine: undefined,
    })),
  });
}

function canEdit(project: Project | null): project is Project {
  return (
    project !== null &&
    project.status !== "queued" &&
    project.status !== "processing"
  );
}

function defaultTrackId(tracks: Track[]): string | null {
  const pitched = tracks.filter(
    (track) =>
      !track.isDrum && track.kind !== "drums" && !track.analysis?.lowSignal,
  );
  return (
    (
      pitched.find((track) => track.notes.length > 0) ??
      pitched[0] ??
      tracks.find((track) => !track.analysis?.lowSignal) ??
      tracks[0]
    )?.id ?? null
  );
}

function notesEnd(project: Project): number {
  let end = 0;
  for (const track of project.tracks) {
    for (const note of track.notes)
      end = Math.max(end, note.startSeconds + note.durationSeconds);
  }
  return end;
}

/** User edits can extend a timeline; the server knows the original audio's length. */
function extendDuration(project: Project): Project {
  project.durationSeconds = Math.max(
    project.durationSeconds,
    notesEnd(project),
  );
  return project;
}

function validSelection(
  project: Project | null,
  trackId: string | null,
  ids: readonly string[],
): string[] {
  const allowed = new Set(
    project?.tracks
      .find((track) => track.id === trackId)
      ?.notes.map((note) => note.id) ?? [],
  );
  return [...new Set(ids)].filter((id) => allowed.has(id));
}

/** History restores edits, never a stale revision, task state, or server asset URL. */
function restoreEdits(snapshot: Project, metadata: Project): Project {
  const currentTracks = new Map(
    metadata.tracks.map((track) => [track.id, track]),
  );
  const restored: Project = {
    ...copy(metadata),
    title: snapshot.title,
    bpm: snapshot.bpm,
    timeSignature: snapshot.timeSignature,
    tracks: copy(snapshot.tracks).map((track) => {
      const current = currentTracks.get(track.id);
      return current
        ? {
            ...track,
            audioUrl: current.audioUrl,
            analysis: copy(current.analysis),
            transcriptionEngine: current.transcriptionEngine,
          }
        : track;
    }),
    durationSeconds: snapshot.durationSeconds,
  };
  return extendDuration(restored);
}

// Private baseline: project metadata does not make the local editor dirty.
let savedBaseline: Project | null = null;

export const useEditorStore = create<EditorState>((set, get) => {
  // Automatic choices can improve as streamed tracks arrive. A deliberate
  // user choice is local UI state, not project data or an undoable edit.
  let trackSelectionIsExplicit = false;
  const dirtyFor = (project: Project): boolean =>
    savedBaseline?.id !== project.id ||
    editable(project) !== editable(savedBaseline);

  /** All mutations use this one boundary; a pointer gesture commits on pointerup. */
  const commit = (
    change: (draft: Project, state: EditorState) => void,
  ): void => {
    set((state) => {
      if (!canEdit(state.project)) return state;
      const next = copy(state.project);
      change(next, state);
      extendDuration(next);
      if (editable(next) === editable(state.project)) return state;
      return {
        project: next,
        dirty: dirtyFor(next),
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: [],
        selectedNoteIds: validSelection(
          next,
          state.selectedTrackId,
          state.selectedNoteIds,
        ),
      };
    });
  };

  return {
    project: null,
    selectedTrackId: null,
    selectedNoteIds: [],
    snap: "1/8",
    pixelsPerSecond: 64,
    dirty: false,
    past: [],
    future: [],
    clipboard: [],

    loadProject(project, force = false) {
      set((state) => {
        const sameProject = state.project?.id === project.id;
        if (sameProject && state.dirty && !force) return state;
        const next = copy(project);
        savedBaseline = copy(next);
        if (!sameProject || force) trackSelectionIsExplicit = false;
        const preserveSelection =
          trackSelectionIsExplicit &&
          next.tracks.some((track) => track.id === state.selectedTrackId);
        if (!preserveSelection) trackSelectionIsExplicit = false;
        const selectedTrackId = preserveSelection
          ? state.selectedTrackId
          : defaultTrackId(next.tracks);
        return {
          project: next,
          selectedTrackId,
          selectedNoteIds: sameProject
            ? validSelection(next, selectedTrackId, state.selectedNoteIds)
            : [],
          dirty: false,
          past: [],
          future: [],
        };
      });
    },

    selectTrack(trackId) {
      set((state) => {
        const next = state.project?.tracks.some((track) => track.id === trackId)
          ? trackId
          : null;
        // Clicking the automatically selected track is still an explicit choice.
        trackSelectionIsExplicit = next !== null;
        return next === state.selectedTrackId
          ? state
          : { selectedTrackId: next, selectedNoteIds: [] };
      });
    },

    setSelection(noteIds) {
      set((state) => ({
        selectedNoteIds: validSelection(
          state.project,
          state.selectedTrackId,
          noteIds,
        ),
      }));
    },

    setSnap(snap) {
      if (["off", "1/4", "1/8", "1/16"].includes(snap)) set({ snap });
    },

    setPixelsPerSecond(pixelsPerSecond) {
      set((state) => ({
        pixelsPerSecond: clamp(pixelsPerSecond, 8, 512, state.pixelsPerSecond),
      }));
    },

    rename(title) {
      const trimmed = title.trim().slice(0, 200);
      if (trimmed)
        commit((draft) => {
          draft.title = trimmed;
        });
    },

    setBpm(bpm) {
      commit((draft) => {
        draft.bpm = clamp(bpm, 20, 300, draft.bpm);
      });
    },

    patchTrack(trackId, patch) {
      commit((draft) => {
        const index = draft.tracks.findIndex((track) => track.id === trackId);
        const previous = draft.tracks[index];
        if (!previous) return;
        const track = { ...previous, ...copy(patch), id: previous.id };
        track.name = track.name.trim().slice(0, 200) || previous.name;
        track.program = Math.round(
          clamp(track.program, 0, 127, previous.program),
        );
        track.volume = clamp(track.volume, 0, 1, previous.volume);
        track.pan = clamp(track.pan, -1, 1, previous.pan);
        track.notes = validNotes(track.notes);
        // Audio files are owned by the server, never changed by a local MIDI edit.
        track.audioUrl = previous.audioUrl;
        track.analysis = previous.analysis;
        track.transcriptionEngine = previous.transcriptionEngine;
        draft.tracks[index] = track;
      });
    },

    clearSolo() {
      commit((draft) => {
        for (const track of draft.tracks) track.solo = false;
      });
    },

    setNotes(trackId, notes) {
      commit((draft) => {
        const track = draft.tracks.find((item) => item.id === trackId);
        if (track) track.notes = validNotes(notes);
      });
    },

    updateSelectedNotes(patch) {
      commit((draft, state) => {
        const track = draft.tracks.find(
          (item) => item.id === state.selectedTrackId,
        );
        if (!track) return;
        const ids = new Set(state.selectedNoteIds);
        track.notes = track.notes.map((note) =>
          ids.has(note.id)
            ? validNote({ ...note, ...patch, id: note.id })
            : note,
        );
      });
    },

    deleteSelected() {
      commit((draft, state) => {
        const track = draft.tracks.find(
          (item) => item.id === state.selectedTrackId,
        );
        if (!track) return;
        const ids = new Set(state.selectedNoteIds);
        track.notes = track.notes.filter((note) => !ids.has(note.id));
      });
    },

    copySelected() {
      set((state) => {
        const ids = new Set(state.selectedNoteIds);
        const notes =
          state.project?.tracks.find(
            (track) => track.id === state.selectedTrackId,
          )?.notes ?? [];
        return { clipboard: copy(notes.filter((note) => ids.has(note.id))) };
      });
    },

    pasteAt(seconds) {
      const state = get();
      if (
        !canEdit(state.project) ||
        !state.clipboard.length ||
        !state.project.tracks.some(
          (track) => track.id === state.selectedTrackId,
        )
      )
        return;
      let firstStart = Number.POSITIVE_INFINITY;
      let lastStart = 0;
      for (const note of state.clipboard) {
        firstStart = Math.min(firstStart, note.startSeconds);
        lastStart = Math.max(lastStart, note.startSeconds);
      }
      const destination = clamp(
        snapSeconds(seconds, state.project.bpm, state.snap),
        0,
        Math.max(0, MAX_SECONDS - (lastStart - firstStart)),
        0,
      );
      const pasted = state.clipboard.map((note) =>
        validNote({
          ...note,
          id: crypto.randomUUID(),
          startSeconds: destination + note.startSeconds - firstStart,
        }),
      );
      commit((draft) => {
        const track = draft.tracks.find(
          (item) => item.id === state.selectedTrackId,
        );
        if (track) track.notes.push(...pasted);
      });
      set({ selectedNoteIds: pasted.map((note) => note.id) });
    },

    undo() {
      set((state) => {
        const previous = state.past[state.past.length - 1];
        if (!canEdit(state.project) || !previous) return state;
        const project = restoreEdits(previous, state.project);
        return {
          project,
          dirty: dirtyFor(project),
          past: state.past.slice(0, -1),
          future: [state.project, ...state.future].slice(0, HISTORY_LIMIT),
          selectedNoteIds: validSelection(
            project,
            state.selectedTrackId,
            state.selectedNoteIds,
          ),
        };
      });
    },

    redo() {
      set((state) => {
        const next = state.future[0];
        if (!canEdit(state.project) || !next) return state;
        const project = restoreEdits(next, state.project);
        return {
          project,
          dirty: dirtyFor(project),
          past: [...state.past, state.project].slice(-HISTORY_LIMIT),
          future: state.future.slice(1),
          selectedNoteIds: validSelection(
            project,
            state.selectedTrackId,
            state.selectedNoteIds,
          ),
        };
      });
    },

    markSaved(serverProject, submittedProject) {
      set((state) => {
        if (
          !state.project ||
          state.project.id !== serverProject.id ||
          submittedProject.id !== serverProject.id ||
          serverProject.revision < state.project.revision
        )
          return state;
        const changedDuringSave =
          editable(state.project) !== editable(submittedProject);
        savedBaseline = copy(serverProject);
        const project = changedDuringSave
          ? restoreEdits(state.project, serverProject)
          : copy(serverProject);
        return {
          project,
          dirty: dirtyFor(project),
          selectedNoteIds: validSelection(
            project,
            state.selectedTrackId,
            state.selectedNoteIds,
          ),
        };
      });
    },
  };
});
