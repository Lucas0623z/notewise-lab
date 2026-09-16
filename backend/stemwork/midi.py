import io
import mido


def non_overlapping_notes(notes):
    """MIDI cannot reliably distinguish overlapping voices of one pitch/channel."""
    merged = []
    for note in sorted(notes, key=lambda n: (n["pitch"], n["startSeconds"])):
        if merged and merged[-1]["pitch"] == note["pitch"] and note["startSeconds"] < merged[-1]["startSeconds"] + merged[-1]["durationSeconds"]:
            old = merged[-1]
            end = max(old["startSeconds"] + old["durationSeconds"], note["startSeconds"] + note["durationSeconds"])
            old["durationSeconds"] = end - old["startSeconds"]
            old["velocity"] = max(old["velocity"], note["velocity"])
        else:
            merged.append(dict(note))
    return merged


def export_midi(project: dict, track_id: str | None = None) -> bytes:
    tracks = project["tracks"]
    if track_id is not None:
        tracks = [t for t in tracks if t["id"] == track_id]
        if not tracks:
            raise KeyError(track_id)
    if sum(not t["isDrum"] for t in tracks) > 15:
        raise ValueError("当前 MIDI 导出最多支持 15 个有音高音轨，另加鼓轨")
    midi = mido.MidiFile(type=1, ticks_per_beat=480, charset="utf-8")
    tempo = mido.bpm2tempo(project["bpm"])
    numerator, denominator = map(int, project["timeSignature"].split("/"))
    conductor = mido.MidiTrack()
    conductor.extend([mido.MetaMessage("track_name", name=project["title"]),
                      mido.MetaMessage("set_tempo", tempo=tempo),
                      mido.MetaMessage("time_signature", numerator=numerator, denominator=denominator)])
    midi.tracks.append(conductor)
    channels = iter([c for c in range(16) if c != 9])
    has_solo = any(t["solo"] for t in tracks)
    for track in tracks:
        channel = 9 if track["isDrum"] else next(channels)
        output = mido.MidiTrack()
        output.append(mido.MetaMessage("track_name", name=track["name"]))
        if not track["isDrum"]:
            output.append(mido.Message("program_change", channel=channel, program=track["program"]))
        audible = not track["muted"] and (not has_solo or track["solo"])
        output.append(mido.Message("control_change", channel=channel, control=7,
                                   value=round(127 * track["volume"]) if audible else 0))
        output.append(mido.Message("control_change", channel=channel, control=10,
                                   value=max(0, min(127, round(64 + 63 * track["pan"])))))
        events = []
        if track["isDrum"]:
            # Distinct attacks must not be unioned into a sustained note.
            notes = sorted((dict(n) for n in track["notes"]), key=lambda n: (n["pitch"], n["startSeconds"]))
            for current, following in zip(notes, notes[1:]):
                gap = following["startSeconds"] - current["startSeconds"]
                if current["pitch"] == following["pitch"] and gap > 0:
                    current["durationSeconds"] = min(current["durationSeconds"], gap)
        else:
            notes = non_overlapping_notes(track["notes"])
        for note in notes:
            start = round(mido.second2tick(note["startSeconds"], 480, tempo))
            end = max(start + 1, round(mido.second2tick(note["startSeconds"] + note["durationSeconds"], 480, tempo)))
            events.append((start, 1, mido.Message("note_on", channel=channel, note=note["pitch"], velocity=note["velocity"])))
            events.append((end, 0, mido.Message("note_off", channel=channel, note=note["pitch"], velocity=0)))
        previous = 0
        for tick, _, message in sorted(events, key=lambda e: (e[0], e[1])):
            output.append(message.copy(time=tick - previous))
            previous = tick
        midi.tracks.append(output)
    buffer = io.BytesIO()
    midi.save(file=buffer)
    return buffer.getvalue()
