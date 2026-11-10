import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromPaperFormat, isPaperFormat, toPaperFormat, type PaperFile, type PaperSnapshot } from '../src/model/paperFormat';
import { DEFAULT_SETTINGS, EMPTY, History, addScaffoldStroke, addShapeStroke, keypoints, type DrawingState } from '../src/model/drawing';
import { midpoint, type Vec3 } from '../src/geometry/vec';

const snap = (s: Partial<PaperSnapshot>): PaperSnapshot => ({
  construction_lines: [],
  shape_curves: [],
  raw_construction_lines: [],
  raw_shape_curves: [],
  line_points: [],
  line_directions: [[0, 1, 0]],
  line_lengths: [],
  points_info: {},
  ...s,
});

describe('paper format: reading', () => {
  const a: Vec3 = [0, 1, 0];
  const b: Vec3 = [0.4, 1, 0];
  const rawLine: [Vec3, Vec3] = [[0.01, 1.01, 0], [0.39, 0.99, 0]];
  const curve: Vec3[] = [a, [0.2, 1.1, 0], b];
  const failedRaw: Vec3[] = [[1, 1, 1], [1.1, 1, 1]];
  const curveRaw: Vec3[] = [a, [0.2, 1.12, 0], b];
  const tick: Vec3 = [0.1, 1, 0];
  const file: PaperFile = [
    snap({}),
    snap({ construction_lines: [[a, b]], raw_construction_lines: [rawLine], line_points: [a, b, midpoint(a, b)] }),
    // A shape stroke that failed: raw recorded, no curve.
    snap({ construction_lines: [[a, b]], raw_construction_lines: [rawLine], raw_shape_curves: [failedRaw], line_points: [a, b, midpoint(a, b)] }),
    snap({ construction_lines: [[a, b]], raw_construction_lines: [rawLine], raw_shape_curves: [failedRaw], line_points: [a, b, midpoint(a, b), tick] }),
    snap({ construction_lines: [[a, b]], raw_construction_lines: [rawLine], shape_curves: [curve], raw_shape_curves: [failedRaw, curveRaw], line_points: [a, b, midpoint(a, b), tick] }),
    'start_time2021_03_16_09_38_56_762_Eastern Daylight Time',
    'undo_count5',
  ];

  it('detects the format', () => {
    expect(isPaperFormat(file)).toBe(true);
    expect(isPaperFormat({ format: 'scaffoldsketch-web' })).toBe(false);
  });

  it('converts snapshots to a history, pairing raw input by the step that added it', () => {
    const r = fromPaperFormat(file);
    expect(r.undoCount).toBe(5);
    expect(r.startTime).toBe('2021_03_16_09_38_56_762_Eastern Daylight Time');
    // empty, +line, +tick, +curve (the failed stroke changes nothing visible)
    expect(r.timeline).toHaveLength(4);
    const s = r.timeline[3];
    expect(s.lines[0].raw).toEqual(rawLine);
    expect(s.ticks).toHaveLength(1);
    expect(s.ticks[0].point).toEqual(tick);
    expect(s.ticks[0].line).toBe(s.lines[0].id);
    expect(s.strokes[0].raw).toEqual(curveRaw);
    // Items carry over between states.
    expect(r.timeline[1].lines[0]).toBe(s.lines[0]);
    // Undo steps back through it.
    const h = new History();
    h.load(r.timeline, r.undoCount);
    h.undo();
    expect(h.state.strokes).toHaveLength(0);
    expect(h.undoCount).toBe(6);
  });
});

function sampleDrawing(): DrawingState[] {
  const h = new History();
  const corners: Vec3[] = [[0, 1, 0], [0.3, 1, 0], [0.3, 1, 0.3], [0, 1, 0.3]];
  for (let i = 0; i < 4; i++) {
    const r = addScaffoldStroke(h.state, corners[i], corners[(i + 1) % 4], DEFAULT_SETTINGS, 1);
    if (r.type === 'line') h.push(r.state);
  }
  const t = addScaffoldStroke(h.state, [0.1, 0.99, -0.005], [0.105, 1.01, 0.005], DEFAULT_SETTINGS, 1);
  if (t.type === 'tick') h.push(t.state);
  const raw: Vec3[] = [];
  for (let k = 0; k <= 40; k++) raw.push([0.15 + 0.15 * Math.cos((Math.PI * k) / 40), 1, 0.15 - 0.15 * Math.sin((Math.PI * k) / 40)]);
  const s = addShapeStroke(h.state, raw, DEFAULT_SETTINGS, 1);
  if (s.type === 'stroke') h.push(s.state);
  return h.timeline();
}

describe('paper format: writing', () => {
  it('round-trips through the paper format', () => {
    const timeline = sampleDrawing();
    const file = JSON.parse(JSON.stringify(toPaperFormat(timeline, { history: true, start: new Date(2021, 2, 16, 9, 38, 56, 762), undoCount: 3 })));
    expect(file).toHaveLength(timeline.length + 2);
    expect(file[file.length - 2]).toMatch(/^start_time2021_03_16_09_38_56_762_/);
    expect(file[file.length - 1]).toBe('undo_count3');
    const last = file[file.length - 3] as PaperSnapshot;
    const s = timeline[timeline.length - 1];
    expect(last.line_points).toHaveLength(keypoints(s).length);
    expect(last.line_directions[0]).toEqual([0, 1, 0]);
    expect(Object.keys(last.points_info)).toHaveLength(last.line_points.length);
    const back = fromPaperFormat(file);
    const r = back.timeline[back.timeline.length - 1];
    expect(r.lines.map((l) => [l.a, l.b, l.raw])).toEqual(s.lines.map((l) => [l.a, l.b, l.raw]));
    expect(r.strokes.map((x) => [x.points, x.raw])).toEqual(s.strokes.map((x) => [x.points, x.raw]));
    expect(r.ticks.map((x) => x.point)).toEqual(s.ticks.map((x) => x.point));
    expect(back.timeline).toHaveLength(timeline.length);
  });

  it('without history writes only the last state', () => {
    const timeline = sampleDrawing();
    const file = toPaperFormat(timeline, { history: false, start: new Date(), undoCount: 0 });
    expect(file).toHaveLength(3);
    expect(fromPaperFormat(file).timeline.at(-1)!.strokes).toHaveLength(1);
    expect(toPaperFormat([EMPTY], { history: false, start: new Date(), undoCount: 0 })).toHaveLength(3);
  });
});

// The paper's user study files, if present (paper-models/ is not committed).
const dir = path.join(__dirname, '..', 'paper-models');
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).flatMap((d) => (fs.statSync(path.join(dir, d)).isDirectory() ? fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, d, f)) : []))
  : [];

describe.skipIf(!files.length)('paper format: the user study files', () => {
  it.each(files.map((f) => [path.relative(dir, f), f]))('%s', (_, file) => {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(isPaperFormat(data)).toBe(true);
    const r = fromPaperFormat(data);
    const last = data[data.length - 3] as PaperSnapshot;
    const s = r.timeline[r.timeline.length - 1];
    expect(s.lines).toHaveLength(last.construction_lines.length);
    expect(s.strokes).toHaveLength(last.shape_curves.length);
    expect(s.strokes.map((x) => x.points)).toEqual(last.shape_curves);
    // Every recorded keypoint is one of ours.
    const ours = keypoints(s).map((k) => k.position);
    for (const p of last.line_points) expect(ours.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4)).toBe(true);
    // Raw strokes come from the file's raw curves.
    if (last.raw_shape_curves.length) for (const x of s.strokes) expect(last.raw_shape_curves).toContainEqual(x.raw);
    // And it writes back to an equivalent final state.
    const again = fromPaperFormat(JSON.parse(JSON.stringify(toPaperFormat(r.timeline, { history: false, start: new Date(), undoCount: 0 }))));
    expect(again.timeline.at(-1)!.strokes.map((x) => x.points)).toEqual(last.shape_curves);
  });
});
