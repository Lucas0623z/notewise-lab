import { Midi } from "@tonejs/midi";
import type { Project } from "../types";
import { drumTriggerNotes, mergeOverlappingNotes } from "./music";

// midi-file writes strings as bytes; encode Chinese names as UTF-8 to match
// the Python export instead of truncating each Unicode character to one byte.
function midiText(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) =>
    String.fromCharCode(byte),
  ).join("");
}

/** Preserve note seconds while mapping them to the project's current tempo. */
export function projectMidi(project: Project): Uint8Array {
  if (project.tracks.filter((track) => !track.isDrum).length > 15) {
    throw new Error("当前 MIDI 导出最多支持 15 个有音高音轨，另加鼓轨。");
  }
  const midi = new Midi();
  midi.header.name = midiText(project.title);
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: [4, 4] }];
  midi.header.setTempo(project.bpm);
  let melodicChannel = 0;
  const hasSolo = project.tracks.some((track) => track.solo);
  for (const source of project.tracks) {
    const track = midi.addTrack();
    track.name = midiText(source.name);
    if (source.isDrum) track.channel = 9;
    else {
      if (melodicChannel === 9) melodicChannel += 1;
      track.channel = melodicChannel++;
    }
    track.instrument.number = source.program;
    const audible = !source.muted && (!hasSolo || source.solo);
    const volume = audible
      ? Math.round(127 * Math.max(0, Math.min(1, source.volume)))
      : 0;
    const pan = Math.max(0, Math.min(127, Math.round(64 + 63 * source.pan)));
    track.addCC({ number: 7, ticks: 0, value: volume / 127 });
    track.addCC({ number: 10, ticks: 0, value: pan / 127 });
    for (const note of source.isDrum
      ? drumTriggerNotes(source.notes)
      : mergeOverlappingNotes(source.notes)) {
      const ticks = midi.header.secondsToTicks(note.startSeconds);
      const end = Math.max(
        ticks + 1,
        midi.header.secondsToTicks(note.startSeconds + note.durationSeconds),
      );
      track.addNote({
        midi: note.pitch,
        ticks,
        durationTicks: end - ticks,
        velocity: note.velocity / 127,
      });
    }
  }
  return midi.toArray();
}
export async function saveBytes(data: Uint8Array, name: string) {
  if (window.desktop) return window.desktop.saveMidi(data, name);
  const blob = new Blob([new Uint8Array(data)], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
