/**
 * The drawing: scaffold lines, tick marks and shape strokes, in drawing
 * coordinates (metres at zoom 1). Immutable snapshots make undo/redo trivial.
 * `Sketch` applies the auto-correct algorithms to raw input, converting the
 * paper's physical thresholds into drawing units with the current zoom.
 */

import {
  autocorrectScaffoldLine,
  uniqueDirections,
  uniqueLengths,
  type ConstraintKind,
  type ScaffoldThresholds,
} from '../scaffold/autocorrect';
import { autocorrectShapeStroke, type Keypoint, type ShapeKind, type ShapeThresholds } from '../shape/autocorrect';
import {
  dist,
  lerp,
  midpoint,
  normalize,
  pointSegmentDistance2,
  projectParameter,
  sub,
  type Vec3,
} from '../geometry/vec';

export interface ScaffoldLine {
  id: number;
  a: Vec3;
  b: Vec3;
  /** As drawn, before auto-correct. */
  raw: [Vec3, Vec3];
  /** Kinds of constraints auto-correct satisfied (for display). */
  constraints?: ConstraintKind[];
}

/** An extra keypoint on a scaffold line, from a very short scaffold stroke across it. */
export interface Tick {
  id: number;
  point: Vec3;
  /** The scaffold line it lies on. */
  line: number;
  raw: [Vec3, Vec3];
}

export interface ShapeStroke {
  id: number;
  kind: ShapeKind | 'raw';
  points: Vec3[];
  raw: Vec3[];
}

export interface DrawingState {
  lines: ScaffoldLine[];
  ticks: Tick[];
  strokes: ShapeStroke[];
}

export const EMPTY: DrawingState = { lines: [], ticks: [], strokes: [] };

/** Physical thresholds from the paper (metres, degrees, ratios), in the user's own coordinates. */
export interface Settings {
  scaffold: ScaffoldThresholds;
  shape: ShapeThresholds;
  /** A scaffold stroke shorter than this is a tick mark. */
  tickLength: number;
  /** Include the vertical axis as a parallel/perpendicular direction. */
  vertical: Vec3;
  /** Auto-correct on (paper) or off (the user study's baseline; also for free sketching). */
  autocorrect: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  scaffold: { pointPoint: 0.05, pointLine: 0.05, parallelDegrees: 10, perpendicularDegrees: 10, lengthRatio: 0.25 },
  shape: { keypointDistance: 0.03, tangentDegrees: 25, sampleSpacing: 0.01, straightDeviation: 0.08, straightLength: 0.1 },
  tickLength: 0.03,
  vertical: [0, 1, 0],
  autocorrect: true,
};

/** Two keypoints closer than this (drawing units) are the same keypoint. */
const SAME_POINT = 1e-5;

/**
 * All keypoints: each line's endpoints and midpoint, and every tick, merged
 * where they coincide, with the directions of the lines passing through each.
 */
export function keypoints(state: DrawingState): Keypoint[] {
  const positions: Vec3[] = [];
  const addPoint = (p: Vec3) => {
    if (!positions.some((q) => dist(p, q) < SAME_POINT)) positions.push(p);
  };
  for (const l of state.lines) {
    addPoint(l.a);
    addPoint(l.b);
    addPoint(midpoint(l.a, l.b));
  }
  for (const t of state.ticks) addPoint(t.point);
  return positions.map((position) => ({
    position,
    directions: uniqueDirections(
      state.lines.filter((l) => pointSegmentDistance2(position, l.a, l.b) < SAME_POINT * SAME_POINT).map((l) => sub(l.b, l.a)),
    ),
  }));
}

/** Convert physical thresholds to drawing units for a world scale (physical = drawing × scale). */
export function scaledSettings(settings: Settings, worldScale: number) {
  const s = 1 / worldScale;
  return {
    scaffold: { ...settings.scaffold, pointPoint: settings.scaffold.pointPoint * s, pointLine: settings.scaffold.pointLine * s },
    shape: {
      ...settings.shape,
      keypointDistance: settings.shape.keypointDistance * s,
      sampleSpacing: settings.shape.sampleSpacing * s,
    },
    tickLength: settings.tickLength * s,
  };
}

export type AddResult =
  | { type: 'line'; line: ScaffoldLine; state: DrawingState }
  | { type: 'tick'; tick: Tick; state: DrawingState }
  | { type: 'stroke'; stroke: ShapeStroke; state: DrawingState }
  | { type: 'rejected'; reason: string };

/** Add a scaffold stroke drawn from `a` to `b` (drawing units). */
export function addScaffoldStroke(state: DrawingState, a: Vec3, b: Vec3, settings: Settings, worldScale: number): AddResult {
  const th = scaledSettings(settings, worldScale);
  const id = nextId(state);
  if (dist(a, b) < th.tickLength) {
    // Tick mark: the stroke's midpoint projected onto the nearest scaffold line it crosses.
    const m = midpoint(a, b);
    let best: ScaffoldLine | null = null;
    let bestDistance = th.scaffold.pointLine;
    for (const l of state.lines) {
      const d = Math.sqrt(pointSegmentDistance2(m, l.a, l.b));
      if (d < bestDistance) {
        bestDistance = d;
        best = l;
      }
    }
    if (!best) return { type: 'rejected', reason: 'Tick mark not on a scaffold line' };
    const t = Math.min(1, Math.max(0, projectParameter(m, best.a, best.b)));
    const tick: Tick = { id, point: lerp(best.a, best.b, t), line: best.id, raw: [a, b] };
    return { type: 'tick', tick, state: { ...state, ticks: [...state.ticks, tick] } };
  }

  let line: ScaffoldLine = { id, a, b, raw: [a, b] };
  if (settings.autocorrect) {
    const context = {
      keypoints: keypoints(state).map((k) => k.position),
      lines: state.lines.map((l) => [l.a, l.b] as [Vec3, Vec3]),
      directions: uniqueDirections([settings.vertical, ...state.lines.map((l) => sub(l.b, l.a))]),
      lengths: uniqueLengths(state.lines.map((l) => dist(l.a, l.b))),
    };
    const result = autocorrectScaffoldLine(a, b, context, th.scaffold);
    line = { ...line, a: result.a, b: result.b, constraints: result.satisfied.map((c) => c.kind) };
  }
  return { type: 'line', line, state: { ...state, lines: [...state.lines, line] } };
}

/** Add a shape stroke (raw polyline, drawing units). */
export function addShapeStroke(state: DrawingState, raw: Vec3[], settings: Settings, worldScale: number): AddResult {
  const th = scaledSettings(settings, worldScale);
  const id = nextId(state);
  if (raw.length < 2) return { type: 'rejected', reason: 'Stroke too short' };
  let stroke: ShapeStroke;
  if (settings.autocorrect) {
    const result = autocorrectShapeStroke(raw, keypoints(state), th.shape);
    if (!result) return { type: 'rejected', reason: 'Stroke too short' };
    stroke = { id, kind: result.kind, points: result.points, raw };
  } else {
    stroke = { id, kind: 'raw', points: raw, raw };
  }
  return { type: 'stroke', stroke, state: { ...state, strokes: [...state.strokes, stroke] } };
}

function nextId(state: DrawingState) {
  let max = 0;
  for (const x of [...state.lines, ...state.ticks, ...state.strokes]) max = Math.max(max, x.id);
  return max + 1;
}

/** Undo/redo over immutable snapshots. */
export class History {
  private past: DrawingState[] = [];
  private future: DrawingState[] = [];
  private listeners = new Set<(state: DrawingState) => void>();

  constructor(public state: DrawingState = EMPTY) {}

  onChange(listener: (state: DrawingState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  push(state: DrawingState) {
    this.past.push(this.state);
    this.future = [];
    this.set(state);
  }

  undo() {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push(this.state);
    this.set(previous);
    return true;
  }

  redo() {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.state);
    this.set(next);
    return true;
  }

  /** Replace everything (e.g. after loading), clearing undo. */
  reset(state: DrawingState) {
    this.past = [];
    this.future = [];
    this.set(state);
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  /** Every state from the first to the current one, for exporting the drawing history. */
  timeline(): DrawingState[] {
    return [...this.past, this.state];
  }

  private set(state: DrawingState) {
    this.state = state;
    for (const l of this.listeners) l(state);
  }
}

// ---------- serialization ----------

export const FORMAT = 'scaffoldsketch-web';
export const FORMAT_VERSION = 1;

export interface SavedDrawing {
  format: typeof FORMAT;
  version: number;
  state: DrawingState;
  /** Optional: every state in order (the drawing history). */
  history?: DrawingState[];
}

export function serialize(state: DrawingState, history?: DrawingState[]): string {
  const saved: SavedDrawing = { format: FORMAT, version: FORMAT_VERSION, state, ...(history ? { history } : {}) };
  return JSON.stringify(saved);
}

export function deserialize(text: string): DrawingState {
  const saved = JSON.parse(text) as SavedDrawing;
  if (saved.format !== FORMAT) throw new Error('Not a ScaffoldSketch drawing');
  const s = saved.state;
  if (!Array.isArray(s?.lines) || !Array.isArray(s?.ticks) || !Array.isArray(s?.strokes)) throw new Error('Malformed drawing');
  return s;
}

/** Unit direction of a scaffold line. */
export const lineDirection = (l: ScaffoldLine) => normalize(sub(l.b, l.a));
