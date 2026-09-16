import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Note, Track } from "../types";
import { audioEngine } from "../audio/engine";
import { formatTime, pitchName, snapSeconds, type Snap } from "../lib/music";
import { useEditorStore } from "../state/editorStore";
import { Button } from "./ui/button";
import {
  drumRowLabel,
  drumVoiceName,
  isDrumTrack,
} from "../lib/transcriptionPresentation";
import "./PianoRoll.css";

export interface PianoRollProps {
  track: Track | null;
  durationSeconds: number;
  bpm: number;
  disabled: boolean;
  color: string;
  cursorSeconds?: number;
  onSeek?: (seconds: number) => void;
}

const KEY_WIDTH = 62;
const RULER_HEIGHT = 30;
const MIN_DURATION = 0.01;
const MAX_SECONDS = 86_400;
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const bound = (value: number, minimum: number, maximum: number) =>
  Math.max(
    minimum,
    Math.min(maximum, Number.isFinite(value) ? value : minimum),
  );

type Point = { x: number; y: number };
type Gesture = {
  kind: "move" | "resize" | "marquee";
  pointerId: number;
  trackId: string;
  from: Point;
  to: Point;
  client: Point;
  notes: Note[];
  selected: Set<string>;
  anchor: Note | null;
  originalSelection: string[];
  additive: boolean;
  moved: boolean;
};

type View = {
  track: Track | null;
  bpm: number;
  disabled: boolean;
  color: string;
  pixelsPerSecond: number;
  snap: Snap;
  rowHeight: number;
  selected: Set<string>;
  width: number;
  height: number;
  followPlayback: boolean;
  cursorSeconds?: number;
};

function validNotes(track: Track | null): Note[] {
  return (track?.notes ?? []).filter(
    (note) =>
      Number.isFinite(note.pitch) &&
      Number.isFinite(note.startSeconds) &&
      Number.isFinite(note.durationSeconds) &&
      note.pitch >= 0 &&
      note.pitch <= 127 &&
      note.startSeconds >= 0 &&
      note.durationSeconds > 0,
  );
}

function hitsResizeEdge(
  point: Point,
  note: Note,
  pixelsPerSecond: number,
): boolean {
  const width = Math.max(4, note.durationSeconds * pixelsPerSecond);
  const edge = note.startSeconds * pixelsPerSecond + width;
  return Math.abs(point.x - edge) <= Math.min(7, width / 3);
}

/** Viewport-sized, retina canvas; native scrolling can reach all 128 MIDI pitches. */
export function PianoRoll({
  track,
  durationSeconds,
  bpm,
  disabled,
  color,
  cursorSeconds,
  onSeek,
}: PianoRollProps) {
  const drum = isDrumTrack(track);
  const pixelsPerSecond = useEditorStore((state) => state.pixelsPerSecond);
  const snap = useEditorStore((state) => state.snap);
  const selectedNoteIds = useEditorStore((state) => state.selectedNoteIds);
  const [rowHeight, setRowHeight] = useState(14);
  const [size, setSize] = useState({ width: 800, height: 548 });
  const [followPlayback, setFollowPlayback] = useState(true);
  const [message, setMessage] = useState("");
  const descriptionId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const previewRef = useRef<Map<string, Note>>(new Map());
  const dirtyRef = useRef(true);
  const manualViewportRef = useRef(false);
  const automaticScrollTopRef = useRef<number | null>(null);
  const viewRef = useRef<View>({
    track,
    bpm,
    disabled,
    color,
    pixelsPerSecond,
    snap,
    rowHeight,
    selected: new Set(selectedNoteIds),
    ...size,
    followPlayback,
    cursorSeconds,
  });

  const safeBpm = bound(bpm, 20, 300);
  const noteEnd = useMemo(() => {
    let end = 0;
    for (const note of track?.notes ?? []) {
      if (Number.isFinite(note.startSeconds + note.durationSeconds)) {
        end = Math.max(end, note.startSeconds + note.durationSeconds);
      }
    }
    return end;
  }, [track?.notes]);
  const timelineSeconds =
    Math.max(
      16,
      Number.isFinite(durationSeconds) ? durationSeconds : 0,
      noteEnd,
    ) +
    (60 / safeBpm) * 8;
  const contentWidth = Math.max(
    size.width,
    KEY_WIDTH + timelineSeconds * pixelsPerSecond,
  );
  const contentHeight = RULER_HEIGHT + 128 * rowHeight;

  function localPoint(client: Point): Point {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect
      ? { x: client.x - rect.left, y: client.y - rect.top }
      : { x: 0, y: 0 };
  }

  function worldPoint(client: Point): Point {
    const local = localPoint(client);
    const viewport = viewportRef.current;
    return {
      x: local.x - KEY_WIDTH + (viewport?.scrollLeft ?? 0),
      y: local.y - RULER_HEIGHT + (viewport?.scrollTop ?? 0),
    };
  }

  function hitNote(point: Point): Note | null {
    const view = viewRef.current;
    const notes = view.track?.notes ?? [];
    for (let index = notes.length - 1; index >= 0; index -= 1) {
      const note = notes[index]!;
      const x = note.startSeconds * view.pixelsPerSecond;
      const y = (127 - note.pitch) * view.rowHeight;
      if (
        point.x >= x &&
        point.x <=
          x + Math.max(4, note.durationSeconds * view.pixelsPerSecond) &&
        point.y >= y &&
        point.y < y + view.rowHeight
      )
        return note;
    }
    return null;
  }

  function cancelGesture() {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    previewRef.current = new Map();
    if (gesture && canvasRef.current?.hasPointerCapture(gesture.pointerId)) {
      canvasRef.current.releasePointerCapture(gesture.pointerId);
    }
    dirtyRef.current = true;
  }

  function updateGesture(client: Point) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const view = viewRef.current;
    gesture.client = client;
    gesture.to = worldPoint(client);
    if (
      Math.hypot(
        gesture.to.x - gesture.from.x,
        gesture.to.y - gesture.from.y,
      ) >= 3
    )
      gesture.moved = true;
    if (!gesture.moved || gesture.kind === "marquee" || !gesture.anchor) return;
    const selection = gesture.notes.filter((note) =>
      gesture.selected.has(note.id),
    );
    if (!selection.length) return;
    let smallestStart = MAX_SECONDS;
    let largestStart = 0;
    let lowestPitch = 127;
    let highestPitch = 0;
    let shortestDuration = MAX_SECONDS;
    let longestDuration = 0;
    for (const note of selection) {
      smallestStart = Math.min(smallestStart, note.startSeconds);
      largestStart = Math.max(largestStart, note.startSeconds);
      lowestPitch = Math.min(lowestPitch, note.pitch);
      highestPitch = Math.max(highestPitch, note.pitch);
      shortestDuration = Math.min(shortestDuration, note.durationSeconds);
      longestDuration = Math.max(longestDuration, note.durationSeconds);
    }
    const rawDelta = (gesture.to.x - gesture.from.x) / view.pixelsPerSecond;
    if (gesture.kind === "move") {
      const snapped = snapSeconds(
        gesture.anchor.startSeconds + rawDelta,
        view.bpm,
        view.snap,
      );
      const timeDelta = bound(
        snapped - gesture.anchor.startSeconds,
        -smallestStart,
        MAX_SECONDS - largestStart,
      );
      const pitchDelta = bound(
        Math.round((gesture.from.y - gesture.to.y) / view.rowHeight),
        -lowestPitch,
        127 - highestPitch,
      );
      previewRef.current = new Map(
        selection.map((note) => [
          note.id,
          {
            ...note,
            startSeconds: note.startSeconds + timeDelta,
            pitch: note.pitch + pitchDelta,
          },
        ]),
      );
    } else {
      const anchorEnd =
        gesture.anchor.startSeconds + gesture.anchor.durationSeconds;
      const snappedEnd = snapSeconds(anchorEnd + rawDelta, view.bpm, view.snap);
      const durationDelta = bound(
        snappedEnd - anchorEnd,
        MIN_DURATION - shortestDuration,
        MAX_SECONDS - longestDuration,
      );
      previewRef.current = new Map(
        selection.map((note) => [
          note.id,
          {
            ...note,
            durationSeconds: Math.max(
              MIN_DURATION,
              note.durationSeconds + durationDelta,
            ),
          },
        ]),
      );
    }
  }

  const updateGestureRef = useRef(updateGesture);
  updateGestureRef.current = updateGesture;

  function revealTransportCursor(seconds: number | undefined) {
    const viewport = viewportRef.current;
    const view = viewRef.current;
    if (!viewport || audioEngine.isPlaying() || !Number.isFinite(seconds))
      return;
    const position = Math.max(0, seconds!);
    const x = KEY_WIDTH + position * view.pixelsPerSecond - viewport.scrollLeft;
    if (x >= KEY_WIDTH && x <= viewport.clientWidth - 20) return;
    viewport.scrollLeft = Math.max(
      0,
      position * view.pixelsPerSecond -
        (viewport.clientWidth - KEY_WIDTH) * 0.2,
    );
    dirtyRef.current = true;
  }

  useEffect(() => {
    viewRef.current = {
      track,
      bpm: safeBpm,
      disabled,
      color,
      pixelsPerSecond,
      snap,
      rowHeight,
      selected: new Set(selectedNoteIds),
      ...size,
      followPlayback,
      cursorSeconds,
    };
    dirtyRef.current = true;
  }, [
    track,
    safeBpm,
    disabled,
    color,
    pixelsPerSecond,
    snap,
    rowHeight,
    selectedNoteIds,
    size,
    followPlayback,
  ]);

  useEffect(() => {
    // Transport updates should only move the cursor, not repaint every note.
    viewRef.current.cursorSeconds = cursorSeconds;
    revealTransportCursor(cursorSeconds);
  }, [cursorSeconds]);

  useEffect(
    () =>
      audioEngine.subscribe(() => {
        // Stop can keep the parent's cursor at zero; handle that transport event
        // even when React has no changed cursor prop to trigger another effect.
        if (!audioEngine.isPlaying())
          revealTransportCursor(audioEngine.position());
      }),
    [],
  );

  useEffect(() => {
    cancelGesture();
    setMessage("");
    manualViewportRef.current = false;
    automaticScrollTopRef.current = null;
  }, [track?.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || manualViewportRef.current || gestureRef.current) return;
    const pitches = validNotes(track)
      .map((note) => note.pitch)
      .sort((a, b) => a - b);
    const middle = Math.floor(pitches.length / 2);
    const median = pitches.length
      ? pitches.length % 2
        ? pitches[middle]!
        : (pitches[middle - 1]! + pitches[middle]!) / 2
      : 60;
    // Use the actual viewport, including compact desktop layouts. Continue to
    // center on resize until the user deliberately scrolls, zooms or edits.
    const visibleHeight = Math.max(1, viewport.clientHeight - RULER_HEIGHT);
    viewport.scrollTop = Math.max(
      0,
      (127 - median + 0.5) * rowHeight - visibleHeight / 2,
    );
    automaticScrollTopRef.current = viewport.scrollTop;
    dirtyRef.current = true;
  }, [track?.id, track?.notes, size.height, rowHeight]);

  useEffect(() => {
    // An external edit, task update or undo must never be overwritten by an old gesture.
    if (gestureRef.current) cancelGesture();
  }, [track?.notes, disabled]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      setSize({
        width: Math.max(1, viewport.clientWidth),
        height: Math.max(1, viewport.clientHeight),
      });
      dirtyRef.current = true;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const buffer = document.createElement("canvas");
    bufferRef.current = buffer;
    const staticContext = buffer.getContext("2d");
    if (!staticContext) return;
    let frame = 0;
    let lastRatio = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastTheme = "";
    let fontFamily = getComputedStyle(viewport).fontFamily;
    let mounted = true;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const themeChanged = () => {
      dirtyRef.current = true;
    };
    media.addEventListener("change", themeChanged);
    const fontsLoaded = () => {
      if (!mounted) return;
      fontFamily = getComputedStyle(viewport).fontFamily;
      dirtyRef.current = true;
      setSize({
        width: Math.max(1, viewport.clientWidth),
        height: Math.max(1, viewport.clientHeight),
      });
    };
    void document.fonts.ready.then(fontsLoaded);
    document.fonts.addEventListener("loadingdone", fontsLoaded);

    function palette() {
      const style = getComputedStyle(viewport!);
      const css = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
      return {
        background: css("--roll-background", "#ffffff"),
        alternate: css("--roll-alternate", "#f5f5f7"),
        border: css("--roll-border", "#d2d2d7"),
        subtle: css("--roll-subtle", "#e8e8ed"),
        text: css("--roll-text", "#1d1d1f"),
        secondary: css("--roll-secondary", "#6e6e73"),
        blackKey: css("--roll-black-key", "#3a3a3c"),
        whiteKey: css("--roll-white-key", "#ffffff"),
        accent: css("--roll-accent", "#007aff"),
      };
    }

    function drawNote(
      ctx: CanvasRenderingContext2D,
      note: Note,
      selected: boolean,
      view: View,
    ) {
      if (
        !Number.isFinite(note.startSeconds) ||
        !Number.isFinite(note.durationSeconds) ||
        !Number.isFinite(note.pitch) ||
        note.pitch < 0 ||
        note.pitch > 127 ||
        note.startSeconds < 0 ||
        note.durationSeconds <= 0
      )
        return;
      const x =
        KEY_WIDTH +
        note.startSeconds * view.pixelsPerSecond -
        viewport!.scrollLeft;
      const y =
        RULER_HEIGHT +
        (127 - note.pitch) * view.rowHeight -
        viewport!.scrollTop +
        1;
      const width = Math.max(4, note.durationSeconds * view.pixelsPerSecond);
      const height = view.rowHeight - 2;
      if (
        x + width < KEY_WIDTH ||
        x > view.width ||
        y + height < RULER_HEIGHT ||
        y > view.height
      )
        return;
      ctx.globalAlpha = selected
        ? 1
        : 0.78 + bound(note.velocity / 127, 0, 1) * 0.22;
      ctx.fillStyle = view.color || "#007aff";
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, Math.max(2, width - 1), height - 1, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (selected) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#1d1d1f";
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
      }
      if (width >= 32 && view.rowHeight >= 14) {
        ctx.fillStyle = "#ffffff";
        ctx.font = `500 ${Math.min(12, view.rowHeight - 4)}px ${fontFamily}`;
        ctx.textBaseline = "middle";
        ctx.fillText(
          isDrumTrack(view.track)
            ? drumVoiceName(note.pitch)
            : pitchName(note.pitch),
          x + 5,
          y + height / 2,
          width - 10,
        );
      }
      if (selected && width >= 12) {
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fillRect(x + width - 5, y + 3, 1, Math.max(2, height - 6));
      }
    }

    function paintStatic(view: View) {
      const ctx = staticContext!;
      const colors = palette();
      fontFamily = getComputedStyle(viewport!).fontFamily;
      const left = viewport!.scrollLeft;
      const top = viewport!.scrollTop;
      ctx.clearRect(0, 0, view.width, view.height);
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, view.width, view.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        KEY_WIDTH,
        RULER_HEIGHT,
        view.width - KEY_WIDTH,
        view.height - RULER_HEIGHT,
      );
      ctx.clip();
      const firstRow = Math.max(0, Math.floor(top / view.rowHeight));
      const lastRow = Math.min(
        127,
        Math.ceil((top + view.height) / view.rowHeight),
      );
      for (let row = firstRow; row <= lastRow; row += 1) {
        const y = RULER_HEIGHT + row * view.rowHeight - top;
        const pitch = 127 - row;
        if (!isDrumTrack(view.track) && BLACK_KEYS.has(pitch % 12)) {
          ctx.fillStyle = colors.alternate;
          ctx.fillRect(KEY_WIDTH, y, view.width, view.rowHeight);
        }
        ctx.strokeStyle = pitch % 12 === 0 ? colors.border : colors.subtle;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(KEY_WIDTH, y + view.rowHeight + 0.5);
        ctx.lineTo(view.width, y + view.rowHeight + 0.5);
        ctx.stroke();
      }
      const quarter = 60 / view.bpm;
      let step =
        quarter / (view.snap === "1/16" ? 4 : view.snap === "1/8" ? 2 : 1);
      while (step * view.pixelsPerSecond < 10) step *= 2;
      const firstGrid = Math.max(
        0,
        Math.floor(left / view.pixelsPerSecond / step),
      );
      const lastGrid = Math.ceil(
        (left + view.width) / view.pixelsPerSecond / step,
      );
      for (let index = firstGrid; index <= lastGrid; index += 1) {
        const seconds = index * step;
        const bars = seconds / (quarter * 4);
        const major = Math.abs(bars - Math.round(bars)) < 0.00001;
        const x = KEY_WIDTH + seconds * view.pixelsPerSecond - left;
        ctx.strokeStyle = major ? colors.border : colors.subtle;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_HEIGHT);
        ctx.lineTo(Math.round(x) + 0.5, view.height);
        ctx.stroke();
      }
      const editing = gestureRef.current;
      for (const note of view.track?.notes ?? []) {
        if (
          editing &&
          editing.kind !== "marquee" &&
          editing.selected.has(note.id)
        )
          continue;
        drawNote(ctx, note, view.selected.has(note.id), view);
      }
      ctx.restore();

      // Keyboard and ruler remain fixed while the notes scroll beneath them.
      ctx.fillStyle = colors.whiteKey;
      ctx.fillRect(0, RULER_HEIGHT, KEY_WIDTH, view.height);
      for (let row = firstRow; row <= lastRow; row += 1) {
        const pitch = 127 - row;
        const y = RULER_HEIGHT + row * view.rowHeight - top;
        if (y < RULER_HEIGHT - view.rowHeight) continue;
        ctx.fillStyle = colors.whiteKey;
        ctx.fillRect(0, y, KEY_WIDTH, view.rowHeight);
        ctx.strokeStyle = colors.border;
        ctx.strokeRect(-0.5, y + 0.5, KEY_WIDTH, view.rowHeight);
        if (!isDrumTrack(view.track) && BLACK_KEYS.has(pitch % 12)) {
          ctx.fillStyle = colors.blackKey;
          ctx.fillRect(0, y + 1, KEY_WIDTH * 0.58, view.rowHeight - 2);
        }
        if (
          (isDrumTrack(view.track) || pitch % 12 === 0) &&
          view.rowHeight >= 10
        ) {
          ctx.font = `${isDrumTrack(view.track) ? 9 : 11}px ${fontFamily}`;
          ctx.textBaseline = "middle";
          ctx.fillStyle = colors.text;
          ctx.fillText(
            isDrumTrack(view.track) ? drumRowLabel(pitch) : pitchName(pitch),
            isDrumTrack(view.track) ? 5 : KEY_WIDTH - 27,
            y + view.rowHeight / 2,
            KEY_WIDTH - 8,
          );
        }
      }
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, view.width, RULER_HEIGHT);
      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(0, RULER_HEIGHT - 0.5);
      ctx.lineTo(view.width, RULER_HEIGHT - 0.5);
      ctx.moveTo(KEY_WIDTH - 0.5, 0);
      ctx.lineTo(KEY_WIDTH - 0.5, view.height);
      ctx.stroke();
      ctx.fillStyle = colors.secondary;
      ctx.font = `11px ${fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.fillText("小节", 14, RULER_HEIGHT / 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(KEY_WIDTH, 0, view.width - KEY_WIDTH, RULER_HEIGHT);
      ctx.clip();
      const barSeconds = quarter * 4;
      const barStride = Math.max(
        1,
        Math.ceil(54 / (barSeconds * view.pixelsPerSecond)),
      );
      const firstBar = Math.max(
        0,
        Math.floor(left / view.pixelsPerSecond / barSeconds / barStride) *
          barStride,
      );
      const lastBar = Math.ceil(
        (left + view.width) / view.pixelsPerSecond / barSeconds,
      );
      for (let index = firstBar; index <= lastBar; index += barStride) {
        const x = KEY_WIDTH + index * barSeconds * view.pixelsPerSecond - left;
        ctx.fillText(`${index + 1}`, x + 6, 10);
        ctx.fillText(formatTime(index * barSeconds), x + 6, 22);
      }
      ctx.restore();
    }

    function render() {
      const view = viewRef.current;
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      if (
        ratio !== lastRatio ||
        view.width !== lastWidth ||
        view.height !== lastHeight
      ) {
        lastRatio = ratio;
        lastWidth = view.width;
        lastHeight = view.height;
        canvas!.width = buffer.width = Math.round(view.width * ratio);
        canvas!.height = buffer.height = Math.round(view.height * ratio);
        context!.setTransform(ratio, 0, 0, ratio, 0, 0);
        staticContext!.setTransform(ratio, 0, 0, ratio, 0, 0);
        dirtyRef.current = true;
      }
      const theme =
        document.documentElement.className +
        document.documentElement.dataset.theme;
      if (theme !== lastTheme) {
        lastTheme = theme;
        dirtyRef.current = true;
      }
      const gesture = gestureRef.current;
      if (gesture) {
        const point = localPoint(gesture.client);
        const dx =
          point.x < KEY_WIDTH + 18 ? -12 : point.x > view.width - 18 ? 12 : 0;
        const dy =
          point.y < RULER_HEIGHT + 18
            ? -10
            : point.y > view.height - 18
              ? 10
              : 0;
        if (gesture.moved && (dx || dy)) {
          manualViewportRef.current = true;
          const beforeLeft = viewport!.scrollLeft;
          const beforeTop = viewport!.scrollTop;
          viewport!.scrollLeft += dx;
          viewport!.scrollTop += dy;
          if (
            beforeLeft !== viewport!.scrollLeft ||
            beforeTop !== viewport!.scrollTop
          ) {
            dirtyRef.current = true;
            updateGestureRef.current(gesture.client);
          }
        }
      }
      const position = audioEngine.isPlaying()
        ? audioEngine.position()
        : Number.isFinite(view.cursorSeconds)
          ? Math.max(0, view.cursorSeconds!)
          : audioEngine.position();
      if (!gesture && view.followPlayback && audioEngine.isPlaying()) {
        const playX =
          KEY_WIDTH + position * view.pixelsPerSecond - viewport!.scrollLeft;
        if (playX < KEY_WIDTH || playX > view.width - 30) {
          viewport!.scrollLeft = Math.max(
            0,
            position * view.pixelsPerSecond - (view.width - KEY_WIDTH) * 0.2,
          );
          dirtyRef.current = true;
        }
      }
      if (dirtyRef.current) {
        paintStatic(view);
        dirtyRef.current = false;
      }
      context!.clearRect(0, 0, view.width, view.height);
      context!.drawImage(buffer, 0, 0, view.width, view.height);
      context!.save();
      context!.beginPath();
      context!.rect(
        KEY_WIDTH,
        RULER_HEIGHT,
        Math.max(0, view.width - KEY_WIDTH),
        Math.max(0, view.height - RULER_HEIGHT),
      );
      context!.clip();
      if (gesture && gesture.kind !== "marquee") {
        const notes = previewRef.current.size
          ? previewRef.current.values()
          : gesture.notes.filter((note) => gesture.selected.has(note.id));
        for (const note of notes) drawNote(context!, note, true, view);
      }
      if (gesture?.kind === "marquee" && gesture.moved) {
        const x =
          KEY_WIDTH +
          Math.min(gesture.from.x, gesture.to.x) -
          viewport!.scrollLeft;
        const y =
          RULER_HEIGHT +
          Math.min(gesture.from.y, gesture.to.y) -
          viewport!.scrollTop;
        const width = Math.abs(gesture.to.x - gesture.from.x);
        const height = Math.abs(gesture.to.y - gesture.from.y);
        context!.fillStyle = "rgba(0,122,255,0.12)";
        context!.fillRect(x, y, width, height);
        context!.strokeStyle = "#007aff";
        context!.lineWidth = 1;
        context!.strokeRect(x + 0.5, y + 0.5, width, height);
      }
      context!.restore();
      const cursorX =
        KEY_WIDTH + position * view.pixelsPerSecond - viewport!.scrollLeft;
      if (cursorX >= KEY_WIDTH && cursorX <= view.width) {
        context!.strokeStyle = "#ff3b30";
        context!.lineWidth = 1.5;
        context!.beginPath();
        context!.moveTo(cursorX, 0);
        context!.lineTo(cursorX, view.height);
        context!.stroke();
        context!.fillStyle = "#ff3b30";
        context!.beginPath();
        context!.moveTo(cursorX - 5, 0);
        context!.lineTo(cursorX + 5, 0);
        context!.lineTo(cursorX, 7);
        context!.closePath();
        context!.fill();
      }
      frame = requestAnimationFrame(render);
    }

    frame = requestAnimationFrame(render);
    return () => {
      mounted = false;
      cancelAnimationFrame(frame);
      media.removeEventListener("change", themeChanged);
      document.fonts.removeEventListener("loadingdone", fontsLoaded);
      bufferRef.current = null;
    };
  }, []);

  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    canvasRef.current?.focus({ preventScroll: true });
    const view = viewRef.current;
    const client = { x: event.clientX, y: event.clientY };
    const local = localPoint(client);
    if (local.x >= KEY_WIDTH && local.y < RULER_HEIGHT) {
      const seconds = bound(
        worldPoint(client).x / view.pixelsPerSecond,
        0,
        MAX_SECONDS,
      );
      if (onSeek) onSeek(seconds);
      else
        void audioEngine
          .seek(seconds)
          .catch((error) =>
            setMessage(error instanceof Error ? error.message : "定位失败"),
          );
      return;
    }
    if (local.x < KEY_WIDTH || local.y < RULER_HEIGHT || !view.track) return;
    manualViewportRef.current = true;
    event.preventDefault();
    const from = worldPoint(client);
    const hit = hitNote(from);
    const store = useEditorStore.getState();
    const previousSelection = store.selectedNoteIds;
    let nextSelection = [...previousSelection];
    if (hit) {
      if (event.shiftKey) {
        nextSelection = previousSelection.includes(hit.id)
          ? previousSelection.filter((id) => id !== hit.id)
          : [...previousSelection, hit.id];
      } else if (!previousSelection.includes(hit.id)) nextSelection = [hit.id];
      store.setSelection(nextSelection);
      if (view.disabled || !nextSelection.includes(hit.id)) return;
    } else if (!event.shiftKey) {
      store.setSelection([]);
    }
    const atRightEdge = hit && hitsResizeEdge(from, hit, view.pixelsPerSecond);
    gestureRef.current = {
      kind: hit ? (atRightEdge ? "resize" : "move") : "marquee",
      pointerId: event.pointerId,
      trackId: view.track.id,
      from,
      to: from,
      client,
      notes: view.track.notes,
      selected: new Set(nextSelection),
      anchor: hit,
      originalSelection: previousSelection,
      additive: event.shiftKey,
      moved: false,
    };
    previewRef.current = new Map();
    canvasRef.current?.setPointerCapture(event.pointerId);
    dirtyRef.current = true;
  }

  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (gestureRef.current?.pointerId === event.pointerId) {
      updateGesture({ x: event.clientX, y: event.clientY });
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const local = localPoint({ x: event.clientX, y: event.clientY });
    if (local.x < KEY_WIDTH || local.y < RULER_HEIGHT) {
      canvas.style.cursor = "default";
      return;
    }
    const point = worldPoint({ x: event.clientX, y: event.clientY });
    const hit = hitNote(point);
    const view = viewRef.current;
    canvas.style.cursor = view.disabled
      ? "default"
      : hit
        ? hitsResizeEdge(point, hit, view.pixelsPerSecond)
          ? "ew-resize"
          : "grab"
        : "crosshair";
  }

  function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    updateGesture({ x: event.clientX, y: event.clientY });
    const view = viewRef.current;
    const store = useEditorStore.getState();
    const previews = previewRef.current;
    cancelGesture();
    if (view.track?.id !== gesture.trackId) return;
    if (gesture.kind === "marquee") {
      if (!gesture.moved) return;
      const minX = Math.min(gesture.from.x, gesture.to.x);
      const maxX = Math.max(gesture.from.x, gesture.to.x);
      const minY = Math.min(gesture.from.y, gesture.to.y);
      const maxY = Math.max(gesture.from.y, gesture.to.y);
      const enclosed = gesture.notes
        .filter((note) => {
          const x = note.startSeconds * view.pixelsPerSecond;
          const y = (127 - note.pitch) * view.rowHeight;
          return (
            x < maxX &&
            x + note.durationSeconds * view.pixelsPerSecond > minX &&
            y < maxY &&
            y + view.rowHeight > minY
          );
        })
        .map((note) => note.id);
      store.setSelection(
        gesture.additive
          ? [...gesture.originalSelection, ...enclosed]
          : enclosed,
      );
      setMessage("框选完成");
    } else if (gesture.moved && !view.disabled) {
      store.setNotes(
        gesture.trackId,
        gesture.notes.map((note) => previews.get(note.id) ?? note),
      );
      setMessage(
        gesture.kind === "resize" ? "已调整所选音符时长" : "已移动所选音符",
      );
    }
  }

  function addNote(event: ReactMouseEvent<HTMLCanvasElement>) {
    const view = viewRef.current;
    const client = { x: event.clientX, y: event.clientY };
    const local = localPoint(client);
    if (
      !view.track ||
      view.disabled ||
      local.x < KEY_WIDTH ||
      local.y < RULER_HEIGHT
    )
      return;
    const point = worldPoint(client);
    if (hitNote(point)) return;
    cancelGesture();
    const quarter = 60 / view.bpm;
    const note: Note = {
      id: crypto.randomUUID(),
      pitch: bound(127 - Math.floor(point.y / view.rowHeight), 0, 127),
      startSeconds: bound(
        snapSeconds(point.x / view.pixelsPerSecond, view.bpm, view.snap),
        0,
        MAX_SECONDS,
      ),
      durationSeconds: isDrumTrack(view.track)
        ? 0.1
        : Math.max(
            MIN_DURATION,
            quarter / (view.snap === "1/16" ? 4 : view.snap === "1/8" ? 2 : 1),
          ),
      velocity: 96,
    };
    useEditorStore
      .getState()
      .setNotes(view.track.id, [...view.track.notes, note]);
    useEditorStore.getState().setSelection([note.id]);
    setMessage(
      `已添加 ${isDrumTrack(view.track) ? drumVoiceName(note.pitch) : pitchName(note.pitch)}，起点 ${note.startSeconds.toFixed(2)} 秒`,
    );
  }

  function revealNote(selected: Note) {
    const viewport = viewportRef.current;
    const view = viewRef.current;
    if (!viewport) return;
    manualViewportRef.current = true;
    viewport.scrollLeft = Math.max(
      0,
      selected.startSeconds * view.pixelsPerSecond -
        (view.width - KEY_WIDTH) / 3,
    );
    viewport.scrollTop = Math.max(
      0,
      (127 - selected.pitch) * view.rowHeight -
        (view.height - RULER_HEIGHT) / 2,
    );
    dirtyRef.current = true;
    canvasRef.current?.focus({ preventScroll: true });
  }

  function locateSelection() {
    const view = viewRef.current;
    const notes = validNotes(view.track);
    const selected =
      notes.find((note) => view.selected.has(note.id)) ?? notes[0];
    if (selected) revealNote(selected);
  }

  function changeRowHeight(nextHeight: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    manualViewportRef.current = true;
    const center =
      (viewport.scrollTop + (size.height - RULER_HEIGHT) / 2) / rowHeight;
    const next = bound(nextHeight, 10, 28);
    setRowHeight(next);
    requestAnimationFrame(() => {
      viewport.scrollTop = Math.max(
        0,
        center * next - (size.height - RULER_HEIGHT) / 2,
      );
      dirtyRef.current = true;
    });
  }

  function zoomTimeline(next: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    manualViewportRef.current = true;
    const centerSeconds =
      (viewport.scrollLeft + (size.width - KEY_WIDTH) / 2) / pixelsPerSecond;
    const bounded = bound(next, 8, 512);
    useEditorStore.getState().setPixelsPerSecond(bounded);
    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(
        0,
        centerSeconds * bounded - (size.width - KEY_WIDTH) / 2,
      );
      dirtyRef.current = true;
    });
  }

  return (
    <section
      className="piano-roll"
      aria-label={drum ? "打击乐鼓点编辑器" : "钢琴卷帘音符编辑器"}
    >
      <div className="piano-roll__toolbar">
        <div className="piano-roll__heading">
          <strong>{drum ? "打击乐编辑" : "钢琴卷帘"}</strong>
          <span>
            {track
              ? `${track.notes.length} 个${drum ? "鼓点" : "音符"}`
              : "选择一个音轨"}
          </span>
        </div>
        <div className="piano-roll__controls">
          <label className="piano-roll__select-label">
            吸附
            <select
              value={snap}
              onChange={(event) =>
                useEditorStore.getState().setSnap(event.target.value as Snap)
              }
              aria-label="时间网格吸附"
            >
              <option value="off">关闭</option>
              <option value="1/4">1/4</option>
              <option value="1/8">1/8</option>
              <option value="1/16">1/16</option>
            </select>
          </label>
          <div className="piano-roll__zoom" aria-label="时间缩放">
            <span>时间</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => zoomTimeline(pixelsPerSecond / 1.25)}
              disabled={pixelsPerSecond <= 8}
              aria-label="缩小时间网格"
            >
              −
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => zoomTimeline(pixelsPerSecond * 1.25)}
              disabled={pixelsPerSecond >= 512}
              aria-label="放大时间网格"
            >
              +
            </Button>
          </div>
          <div className="piano-roll__zoom" aria-label="音高行缩放">
            <span>{drum ? "鼓音行" : "音高"}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => changeRowHeight(rowHeight - 2)}
              disabled={rowHeight <= 10}
              aria-label="缩小音高行"
            >
              −
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => changeRowHeight(rowHeight + 2)}
              disabled={rowHeight >= 28}
              aria-label="放大音高行"
            >
              +
            </Button>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={locateSelection}
            disabled={!track?.notes.length}
          >
            定位音符
          </Button>
          <label className="piano-roll__follow">
            <input
              type="checkbox"
              checked={followPlayback}
              onChange={(event) => setFollowPlayback(event.target.checked)}
            />
            跟随播放
          </label>
        </div>
      </div>
      <p id={descriptionId} className="piano-roll__sr-only">
        {drum
          ? "打击乐编辑：行号为 GM 鼓音编号，音符起点为击打点，长度为 MIDI 触发长度。"
          : "钢琴卷帘。"}
        双击空白添加音符，单击选择，按住 Shift 增减选择，拖动空白框选。
        拖动音符移动，拖动音符右边缘调整时长。滚动浏览全部 128 个音高。
        网格获得焦点后，Home 回到开头，Page Up 和 Page Down 浏览音高，Escape
        取消拖动。 按住 Alt 或 Option 并按左右方向键，可以逐个选择音符。
        上方工具栏可通过键盘调整网格和定位音符，页面音符属性面板可精确编辑所选音符。
      </p>
      <div
        ref={viewportRef}
        className="piano-roll__viewport"
        onWheel={() => {
          manualViewportRef.current = true;
        }}
        onPointerDownCapture={(event) => {
          if (event.target === event.currentTarget)
            manualViewportRef.current = true;
        }}
        onScroll={() => {
          const viewport = viewportRef.current;
          if (
            viewport &&
            automaticScrollTopRef.current !== null &&
            Math.abs(viewport.scrollTop - automaticScrollTopRef.current) > 1
          )
            manualViewportRef.current = true;
          dirtyRef.current = true;
        }}
      >
        <div
          className="piano-roll__space"
          style={{ width: contentWidth, height: contentHeight }}
        >
          <canvas
            ref={canvasRef}
            className="piano-roll__canvas"
            style={{ width: size.width, height: size.height }}
            tabIndex={0}
            aria-label={
              track
                ? `${track.name}，${track.notes.length} 个${drum ? "鼓点" : "音符"}，已选 ${selectedNoteIds.length} 个`
                : "尚未选择音轨"
            }
            aria-describedby={descriptionId}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={cancelGesture}
            onLostPointerCapture={() => {
              if (gestureRef.current) cancelGesture();
            }}
            onDoubleClick={addNote}
            onKeyDown={(event) => {
              const viewport = viewportRef.current;
              if (!viewport) return;
              if (event.key === "Escape" && gestureRef.current) {
                cancelGesture();
                event.preventDefault();
                event.stopPropagation();
              } else if (event.key === "Home") {
                manualViewportRef.current = true;
                viewport.scrollLeft = 0;
                event.preventDefault();
                event.stopPropagation();
              } else if (
                event.altKey &&
                (event.key === "ArrowLeft" || event.key === "ArrowRight")
              ) {
                const notes = validNotes(viewRef.current.track).sort(
                  (a, b) =>
                    a.startSeconds - b.startSeconds || a.pitch - b.pitch,
                );
                const selectedId = useEditorStore.getState().selectedNoteIds[0];
                const currentIndex = notes.findIndex(
                  (note) => note.id === selectedId,
                );
                const direction = event.key === "ArrowLeft" ? -1 : 1;
                const nextIndex =
                  currentIndex < 0
                    ? direction > 0
                      ? 0
                      : notes.length - 1
                    : bound(currentIndex + direction, 0, notes.length - 1);
                const note = notes[nextIndex];
                if (note) {
                  useEditorStore.getState().setSelection([note.id]);
                  revealNote(note);
                  setMessage(
                    `已选择 ${isDrumTrack(viewRef.current.track) ? drumVoiceName(note.pitch) : pitchName(note.pitch)}，起点 ${note.startSeconds.toFixed(2)} 秒，时长 ${note.durationSeconds.toFixed(2)} 秒`,
                  );
                }
                event.preventDefault();
                event.stopPropagation();
              } else if (event.key === "PageUp" || event.key === "PageDown") {
                manualViewportRef.current = true;
                viewport.scrollTop +=
                  (event.key === "PageUp" ? -1 : 1) * rowHeight * 12;
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            你的浏览器需要支持 Canvas
            才能显示钢琴卷帘。可使用音符属性面板编辑已选音符。
          </canvas>
        </div>
      </div>
      <div className="piano-roll__footer">
        <span>
          {disabled
            ? drum && track?.transcriptionStatus !== "completed"
              ? "此工程未生成可编辑鼓点"
              : "任务处理中，完成后可编辑"
            : "双击添加 · 拖动移动 · 右边缘调整时长 · Shift 多选"}
        </span>
        <span aria-live="polite">
          {message ? `${message} · ` : ""}已选择 {selectedNoteIds.length} 个
          {drum ? "鼓点" : "音符"}
        </span>
      </div>
    </section>
  );
}

export default PianoRoll;
