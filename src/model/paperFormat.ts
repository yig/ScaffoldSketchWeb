/**
 * The original ScaffoldSketch's saved format (the paper's user study files;
 * `paper-models/vis_json.py` reads it): a JSON array of full drawing
 * snapshots, one appended per change, followed by two strings,
 * `"start_time<YYYY_MM_DD_HH_MM_SS_ms_Time Zone Name>"` and
 * `"undo_count<n>"`. Readers use the last snapshot (`data[-3]`).
 *
 * A snapshot:
 *   construction_lines      [[a, b], …]           auto-corrected scaffold lines
 *   shape_curves            [[p, …], …]           auto-corrected shape strokes
 *   raw_construction_lines  [[a, b], …]           as drawn (empty without auto-correct)
 *   raw_shape_curves        [[p, …], …]           as drawn, resampled; also strokes that failed
 *                                                 to auto-correct, so not index-aligned with shape_curves
 *   line_points             [p, …]                keypoints: line ends, midpoints, tick marks
 *   line_directions         [d, …]                vertical, then distinct line directions
 *   line_lengths            [l, …]                distinct line lengths
 *   points_info             {"i": [d, …]}         directions of the lines at line_points[i]
 *
 * Coordinates are metres in WebXR space (+y up, floor at y = 0).
 */

import { keypoints, type DrawingState, type ScaffoldLine, type ShapeStroke, type Tick } from './drawing';
import { dist, midpoint, normalize, pointSegmentDistance2, sub, type Vec3 } from '../geometry/vec';

export interface PaperSnapshot {
  construction_lines: [Vec3, Vec3][];
  shape_curves: Vec3[][];
  raw_construction_lines: [Vec3, Vec3][];
  raw_shape_curves: Vec3[][];
  line_points: Vec3[];
  line_directions: Vec3[];
  line_lengths: number[];
  points_info: Record<string, Vec3[]>;
}

export type PaperFile = (PaperSnapshot | string)[];

function isSnapshot(x: unknown): x is PaperSnapshot {
  return !!x && typeof x === 'object' && !Array.isArray(x) && Array.isArray((x as PaperSnapshot).construction_lines) && Array.isArray((x as PaperSnapshot).shape_curves);
}

/** Whether parsed JSON is in the paper's format. */
export function isPaperFormat(data: unknown): data is PaperFile {
  return Array.isArray(data) && data.some(isSnapshot);
}

/** Points closer than this are the same point (the files store exact copies). */
const SAME = 1e-6;
/** A line point farther than this from every line end and midpoint is a tick mark. */
const TICK = 1e-4;

const samePoints = (a: Vec3[], b: Vec3[]) => a.length === b.length && a.every((p, i) => dist(p, b[i]) < SAME);

export interface PaperImport {
  /** Every distinct state, oldest first (starting empty); the last is the drawing. */
  timeline: DrawingState[];
  startTime?: string;
  undoCount?: number;
  /** The file was drawn with auto-correct off (no raw input recorded). */
  withoutAutocorrect: boolean;
}

/**
 * Convert a paper file to drawing states. Items carry over between snapshots
 * (same id) while unchanged; a stroke's raw input is the raw curve recorded in
 * the step that added it.
 */
export function fromPaperFormat(data: PaperFile): PaperImport {
  const snapshots = data.filter(isSnapshot);
  const strings = data.filter((x): x is string => typeof x === 'string');
  const startTime = strings.find((s) => s.startsWith('start_time'))?.slice('start_time'.length);
  const undo = strings.find((s) => s.startsWith('undo_count'));
  const withoutAutocorrect =
    snapshots.some((s) => s.construction_lines.length || s.shape_curves.length) &&
    snapshots.every((s) => !s.raw_construction_lines.length && !s.raw_shape_curves.length);

  let nextId = 1;
  let state: DrawingState = { lines: [], ticks: [], strokes: [] };
  let previousRaw = 0;
  const timeline: DrawingState[] = [state];

  for (const snap of snapshots) {
    const lines: ScaffoldLine[] = snap.construction_lines.map(([a, b], i) => {
      const old = state.lines[i];
      if (old && samePoints([old.a, old.b], [a, b])) return old;
      const raw = snap.raw_construction_lines[i];
      return { id: nextId++, a, b, raw: raw ? [raw[0], raw[1]] : [a, b] };
    });

    const rawGrew = snap.raw_shape_curves.length > previousRaw;
    const strokes: ShapeStroke[] = snap.shape_curves.map((points, i) => {
      const old = state.strokes[i];
      if (old && samePoints(old.points, points)) return old;
      const raw =
        rawGrew && i === snap.shape_curves.length - 1
          ? snap.raw_shape_curves[snap.raw_shape_curves.length - 1]
          : snap.raw_shape_curves.length === snap.shape_curves.length
            ? snap.raw_shape_curves[i]
            : points;
      return { id: nextId++, kind: withoutAutocorrect ? 'raw' : 'curve', points, raw };
    });
    previousRaw = snap.raw_shape_curves.length;

    const ends = lines.flatMap((l) => [l.a, l.b, midpoint(l.a, l.b)]);
    const ticks: Tick[] = [];
    for (const p of snap.line_points) {
      if (ends.some((q) => dist(p, q) < TICK)) continue;
      const old = state.ticks.find((t) => dist(t.point, p) < SAME);
      if (old) {
        ticks.push(old);
        continue;
      }
      let line = lines[0];
      let best = Infinity;
      for (const l of lines) {
        const d = pointSegmentDistance2(p, l.a, l.b);
        if (d < best) {
          best = d;
          line = l;
        }
      }
      if (line) ticks.push({ id: nextId++, point: p, line: line.id, raw: [p, p] });
    }

    const next: DrawingState = { lines, ticks, strokes };
    const changed =
      lines.length !== state.lines.length || strokes.length !== state.strokes.length || ticks.length !== state.ticks.length ||
      lines.some((l, i) => l !== state.lines[i]) || strokes.some((s, i) => s !== state.strokes[i]) || ticks.some((t, i) => t !== state.ticks[i]);
    if (changed) {
      state = next;
      timeline.push(state);
    }
  }
  const undoCount = undo ? Number(undo.slice('undo_count'.length)) : undefined;
  return { timeline, startTime, undoCount: Number.isFinite(undoCount) ? undoCount : undefined, withoutAutocorrect };
}

/** One state as a paper snapshot. */
export function toPaperSnapshot(state: DrawingState): PaperSnapshot {
  const kps = keypoints(state);
  // Directions: vertical first, then each line's, skipping near-duplicates (either sign).
  const directions: Vec3[] = [[0, 1, 0]];
  for (const l of state.lines) {
    const d = normalize(sub(l.b, l.a));
    if (!directions.some((e) => e.every((v, i) => Math.abs(v - d[i]) <= 0.015) || e.every((v, i) => Math.abs(v + d[i]) <= 0.015))) directions.push(d);
  }
  const lengths: number[] = [];
  for (const l of state.lines) {
    const len = dist(l.a, l.b);
    if (!lengths.some((e) => Math.abs(e - len) <= 1e-3)) lengths.push(len);
  }
  return {
    construction_lines: state.lines.map((l) => [l.a, l.b]),
    shape_curves: state.strokes.map((s) => s.points),
    raw_construction_lines: state.lines.map((l) => l.raw),
    raw_shape_curves: state.strokes.map((s) => s.raw),
    line_points: kps.map((k) => k.position),
    line_directions: directions,
    line_lengths: lengths,
    points_info: Object.fromEntries(kps.map((k, i) => [String(i), k.directions])),
  };
}

/**
 * A paper file: one snapshot per state in `timeline` (just the last if
 * `history` is false), then the start time and undo count.
 */
export function toPaperFormat(timeline: DrawingState[], options: { history: boolean; start: Date; undoCount: number }): PaperFile {
  const states = options.history ? timeline : timeline.slice(-1);
  return [...states.map(toPaperSnapshot), `start_time${paperTime(options.start)}`, `undo_count${options.undoCount}`];
}

/** The original's timestamp: 2021_03_16_09_38_56_762_Eastern Daylight Time. */
export function paperTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  let zone = '';
  try {
    zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? '';
  } catch {}
  return `${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}_${p(d.getHours())}_${p(d.getMinutes())}_${p(d.getSeconds())}_${d.getMilliseconds()}_${zone}`;
}
