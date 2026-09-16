import { beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../types";
import { useEditorStore } from "./editorStore";

function fixture(): Project {
  return {
    id: "project-1",
    title: "Original",
    status: "ready",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 10,
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    latestJobId: "job-1",
    sourceAudioUrl: "/api/v1/audio",
    warnings: [],
    tracks: [
      {
        id: "piano",
        name: "Piano",
        kind: "piano",
        program: 0,
        isDrum: false,
        muted: false,
        solo: false,
        volume: 0.8,
        pan: 0,
        audioUrl: "/api/v1/piano",
        transcriptionStatus: "completed",
        warnings: [],
        notes: [
          {
            id: "a",
            pitch: 60,
            startSeconds: 0.2,
            durationSeconds: 0.4,
            velocity: 80,
          },
          {
            id: "b",
            pitch: 64,
            startSeconds: 1.2,
            durationSeconds: 0.8,
            velocity: 90,
          },
        ],
      },
      {
        id: "bass",
        name: "Bass",
        kind: "bass",
        program: 33,
        isDrum: false,
        muted: false,
        solo: false,
        volume: 0.7,
        pan: 0,
        audioUrl: null,
        transcriptionStatus: "completed",
        warnings: [],
        notes: [],
      },
    ],
  };
}

const state = () => useEditorStore.getState();
const current = () => state().project!;

beforeEach(() => {
  state().loadProject(fixture(), true);
  state().selectTrack("piano");
  state().setSelection([]);
  useEditorStore.setState({ clipboard: [], snap: "1/8", pixelsPerSecond: 64 });
});

describe("editor draft protection", () => {
  function streamedProject(): Project {
    const project = fixture();
    return {
      ...project,
      id: "streaming-six-stem-project",
      status: "processing",
      tracks: [
        {
          ...project.tracks[0]!,
          id: "vocals",
          kind: "vocal",
          notes: [],
          analysis: {
            rmsDbfs: -91,
            peakDbfs: -54,
            relativeRmsDb: -58,
            lowSignal: true,
            autoTranscriptionSkipped: true,
          },
        },
      ],
    };
  }

  it("replaces an automatic weak-track selection when a useful pitched track arrives", () => {
    const partial = streamedProject();
    state().loadProject(partial);
    expect(state().selectedTrackId).toBe("vocals");
    state().loadProject({
      ...partial,
      revision: 2,
      tracks: [...partial.tracks, fixture().tracks[0]!],
    });
    expect(state().selectedTrackId).toBe("piano");
    expect(state().dirty).toBe(false);
    expect(state().past).toHaveLength(0);
  });

  it("keeps an explicitly selected weak track when later streamed tracks arrive", () => {
    const partial = streamedProject();
    state().loadProject(partial);
    expect(state().selectedTrackId).toBe("vocals");
    // The ID does not change, but this click must still pin the user's choice.
    state().selectTrack("vocals");
    state().loadProject({
      ...partial,
      revision: 2,
      tracks: [...partial.tracks, fixture().tracks[0]!],
    });
    expect(state().selectedTrackId).toBe("vocals");
    expect(state().dirty).toBe(false);
    expect(state().past).toHaveLength(0);
  });

  it("opens the useful pitched result first and preserves a deliberate selection on same-project refresh", () => {
    const project = fixture();
    const quiet = {
      rmsDbfs: -91,
      peakDbfs: -54,
      relativeRmsDb: -58,
      lowSignal: true,
      autoTranscriptionSkipped: true,
    };
    const piano = project.tracks[0]!;
    project.id = "six-stem-project";
    project.tracks = [
      { ...piano, id: "vocals", kind: "vocal", analysis: quiet, notes: [] },
      { ...piano, id: "drums", kind: "drums", isDrum: true, notes: [] },
      { ...piano, id: "other", kind: "other", notes: [] },
      piano,
      { ...piano, id: "guitar", kind: "guitar", analysis: quiet, notes: [] },
    ];
    state().loadProject(project);
    expect(state().selectedTrackId).toBe("piano");
    state().selectTrack("vocals");
    state().loadProject({ ...project, revision: 2 });
    expect(state().selectedTrackId).toBe("vocals");
    state().loadProject({ ...project, id: "another-project" });
    expect(state().selectedTrackId).toBe("piano");
  });

  it("has safe default selections for legacy, drum-only, low-signal, and empty projects", () => {
    const base = fixture();
    state().loadProject({ ...base, id: "legacy" });
    expect(state().selectedTrackId).toBe("piano");
    const drum = {
      ...base.tracks[0]!,
      id: "drums",
      kind: "drums" as const,
      isDrum: true,
      notes: [],
    };
    state().loadProject({ ...base, id: "drum-only", tracks: [drum] });
    expect(state().selectedTrackId).toBe("drums");
    state().loadProject({
      ...base,
      id: "low-signal",
      tracks: [
        {
          ...base.tracks[0]!,
          analysis: {
            rmsDbfs: -240,
            peakDbfs: -240,
            relativeRmsDb: -240,
            lowSignal: true,
            autoTranscriptionSkipped: true,
          },
        },
      ],
    });
    expect(state().selectedTrackId).toBe("piano");
    state().loadProject({ ...base, id: "empty", tracks: [] });
    expect(state().selectedTrackId).toBeNull();
  });

  it("protects a dirty draft from refetch, with an explicit force reload escape hatch", () => {
    state().rename("Local draft");
    const refreshed = { ...fixture(), title: "Server version", revision: 2 };
    state().loadProject(refreshed);
    expect(current().title).toBe("Local draft");
    expect(current().revision).toBe(1);
    expect(state().dirty).toBe(true);
    state().loadProject(refreshed, true);
    expect(current().title).toBe("Server version");
    expect(state().dirty).toBe(false);
    expect(state().past).toHaveLength(0);
  });

  it("blocks processing edits but permits selection, copying and display controls", () => {
    state().loadProject({ ...fixture(), status: "processing" }, true);
    state().setSelection(["a"]);
    state().copySelected();
    state().setSnap("off");
    state().setPixelsPerSecond(100);
    state().rename("Changed");
    state().setBpm(80);
    state().patchTrack("piano", { muted: true });
    state().setNotes("piano", []);
    state().updateSelectedNotes({ pitch: 70 });
    state().deleteSelected();
    state().pasteAt(3);
    state().undo();
    state().redo();
    expect(current().title).toBe("Original");
    expect(current().bpm).toBe(120);
    expect(current().tracks[0]?.notes).toHaveLength(2);
    expect(current().tracks[0]?.muted).toBe(false);
    expect(state().clipboard).toHaveLength(1);
    expect(state().selectedNoteIds).toEqual(["a"]);
    expect(state().pixelsPerSecond).toBe(100);
    expect(state().snap).toBe("off");
    expect(state().dirty).toBe(false);
    expect(state().past).toHaveLength(0);
  });

  it("takes independent copies of loaded and submitted note data", () => {
    const incoming = fixture();
    state().loadProject(incoming, true);
    incoming.title = "Mutated externally";
    const notes = [
      {
        id: "new",
        pitch: 70,
        startSeconds: 2,
        durationSeconds: 1,
        velocity: 90,
      },
    ];
    state().setNotes("piano", notes);
    notes[0]!.pitch = 1;
    expect(current().title).toBe("Original");
    expect(current().tracks[0]?.notes[0]?.pitch).toBe(70);
  });
});

describe("note editing and history", () => {
  it("clears every solo in one undo step without changing mute, notes or audio", () => {
    const project = fixture();
    project.tracks.forEach((track) => {
      track.solo = true;
    });
    project.tracks[1]!.muted = true;
    state().loadProject(project, true);
    state().clearSolo();
    expect(current().tracks.map((track) => track.solo)).toEqual([false, false]);
    expect(current().tracks[1]!.muted).toBe(true);
    expect(current().tracks[0]!.notes).toEqual(project.tracks[0]!.notes);
    expect(current().tracks[0]!.audioUrl).toBe(project.tracks[0]!.audioUrl);
    expect(state().past).toHaveLength(1);
    state().clearSolo();
    expect(state().past).toHaveLength(1);
    state().undo();
    expect(current().tracks.map((track) => track.solo)).toEqual([true, true]);
    expect(state().dirty).toBe(false);
  });

  it("clamps a batch once, preserves note IDs and treats the batch as one undo action", () => {
    state().setSelection(["a", "b", "missing", "a"]);
    state().updateSelectedNotes({
      id: "replacement",
      pitch: 200,
      velocity: 0,
      startSeconds: -5,
      durationSeconds: -1,
    });
    expect(current().tracks[0]?.notes).toEqual([
      {
        id: "a",
        pitch: 127,
        velocity: 1,
        startSeconds: 0,
        durationSeconds: 0.01,
      },
      {
        id: "b",
        pitch: 127,
        velocity: 1,
        startSeconds: 0,
        durationSeconds: 0.01,
      },
    ]);
    expect(state().past).toHaveLength(1);
    state().undo();
    expect(current().tracks[0]?.notes).toEqual(fixture().tracks[0]?.notes);
    expect(state().dirty).toBe(false);
    state().redo();
    expect(current().tracks[0]?.notes[0]?.pitch).toBe(127);
    state().rename("New branch");
    expect(state().future).toHaveLength(0);
  });

  it("pastes relative timing on another track with fresh IDs and one undo commit", () => {
    state().setSelection(["a", "b"]);
    state().copySelected();
    state().selectTrack("bass");
    state().pasteAt(2.36);
    const pasted = current().tracks[1]!.notes;
    expect(pasted.map((note) => note.startSeconds)).toEqual([2.25, 3.25]);
    expect(pasted.map((note) => note.durationSeconds)).toEqual([0.4, 0.8]);
    expect(pasted[0]!.id).not.toBe("a");
    expect(pasted[1]!.id).not.toBe("b");
    expect(pasted[0]!.id).not.toBe(pasted[1]!.id);
    expect(state().selectedNoteIds).toEqual(pasted.map((note) => note.id));
    expect(state().past).toHaveLength(1);
    state().undo();
    expect(current().tracks[1]?.notes).toEqual([]);
    expect(state().selectedNoteIds).toEqual([]);
    state().pasteAt(-2);
    expect(current().tracks[1]?.notes.map((note) => note.startSeconds)).toEqual(
      [0, 1],
    );
  });

  it("preserves relative pasted times at the maximum allowed timeline position", () => {
    state().setSelection(["a", "b"]);
    state().copySelected();
    state().selectTrack("bass");
    state().pasteAt(100_000);
    expect(current().tracks[1]?.notes.map((note) => note.startSeconds)).toEqual(
      [86_399, 86_400],
    );
  });

  it("extends the timeline and validates mixer values without changing audio assets", () => {
    state().patchTrack("piano", {
      id: "changed-id",
      name: "  Keyboard  ",
      volume: 5,
      pan: -8,
      program: 500,
      audioUrl: "/fake",
    });
    expect(current().tracks[0]).toMatchObject({
      id: "piano",
      name: "Keyboard",
      volume: 1,
      pan: -1,
      program: 127,
      audioUrl: "/api/v1/piano",
    });
    state().setBpm(1);
    expect(current().bpm).toBe(20);
    state().setNotes("piano", [
      {
        id: "end",
        pitch: 60,
        velocity: 100,
        startSeconds: 15,
        durationSeconds: 1,
      },
    ]);
    expect(current().durationSeconds).toBe(16);
    state().undo();
    expect(current().durationSeconds).toBe(10);
  });

  it("limits undo history to 50 edits and does not create entries for no-ops", () => {
    state().rename("Original");
    expect(state().past).toHaveLength(0);
    for (let index = 1; index <= 55; index += 1)
      state().rename(`Edit ${index}`);
    expect(state().past).toHaveLength(50);
    for (let index = 0; index < 55; index += 1) state().undo();
    expect(current().title).toBe("Edit 5");
    expect(state().future).toHaveLength(50);
  });
});

describe("saving while the editor remains interactive", () => {
  it.each([
    null,
    {
      rmsDbfs: -91,
      peakDbfs: -54,
      relativeRmsDb: -58,
      lowSignal: true,
      autoTranscriptionSkipped: true,
    },
  ])(
    "keeps server analysis through edits made during save, undo and redo (%j)",
    (analysis) => {
      state().rename("Submitted title");
      const submitted = structuredClone(current());
      state().setBpm(90);
      const saved = {
        ...submitted,
        revision: 2,
        tracks: submitted.tracks.map((track) => ({ ...track, analysis })),
      };
      state().markSaved(saved, submitted);
      expect(current().bpm).toBe(90);
      expect(current().tracks[0]!.analysis).toEqual(analysis);
      if (analysis) expect(current().tracks[0]!.analysis).not.toBe(analysis);
      expect(state().dirty).toBe(true);
      state().undo();
      expect(current().bpm).toBe(120);
      expect(current().tracks[0]!.analysis).toEqual(analysis);
      expect(state().dirty).toBe(false);
      state().redo();
      expect(current().bpm).toBe(90);
      expect(current().tracks[0]!.analysis).toEqual(analysis);
      expect(state().dirty).toBe(true);
    },
  );

  it("adopts a normal save and keeps the newest revision through undo and redo", () => {
    state().rename("Saved title");
    const submitted = structuredClone(current());
    const saved = {
      ...submitted,
      revision: 2,
      updatedAt: "2026-01-01T00:01:00Z",
    };
    state().markSaved(saved, submitted);
    expect(state().dirty).toBe(false);
    state().undo();
    expect(current().title).toBe("Original");
    expect(current().revision).toBe(2);
    expect(state().dirty).toBe(true);
    state().redo();
    expect(current().title).toBe("Saved title");
    expect(current().revision).toBe(2);
    expect(state().dirty).toBe(false);
  });

  it("keeps edits made during a request and clears dirty only when they match the saved baseline", () => {
    state().rename("Submitted title");
    const submitted = structuredClone(current());
    state().setBpm(90);
    const saved = {
      ...submitted,
      revision: 2,
      updatedAt: "2026-01-01T00:01:00Z",
    };
    state().markSaved(saved, submitted);
    expect(current()).toMatchObject({
      title: "Submitted title",
      bpm: 90,
      revision: 2,
    });
    expect(state().dirty).toBe(true);
    state().undo();
    expect(current()).toMatchObject({
      title: "Submitted title",
      bpm: 120,
      revision: 2,
    });
    expect(state().dirty).toBe(false);
    state().markSaved({ ...submitted, revision: 1 }, submitted);
    expect(current().revision).toBe(2);
  });

  it("ignores an old save result after the user has changed projects", () => {
    const submitted = structuredClone(current());
    state().loadProject({
      ...fixture(),
      id: "project-2",
      title: "Other project",
    });
    state().markSaved({ ...submitted, revision: 2 }, submitted);
    expect(current().id).toBe("project-2");
    expect(current().title).toBe("Other project");
  });
});
