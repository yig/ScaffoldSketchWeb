import { describe, expect, it } from 'vitest';
import { autocorrectScaffoldLine, type ScaffoldContext } from '../src/scaffold/autocorrect';
import { autocorrectShapeStroke, curvatureVariation, mengerCurvature, sampleBeziers } from '../src/shape/autocorrect';
import {
  DEFAULT_SETTINGS,
  addScaffoldStroke,
  addShapeStroke,
  deserialize,
  EMPTY,
  History,
  keypoints,
  serialize,
  type DrawingState,
} from '../src/model/drawing';
import { dist, dot, normalize, sub, type Vec3 } from '../src/geometry/vec';
import { levenbergMarquardt } from '../src/optimize/levenbergMarquardt';
import { bfgs } from '../src/optimize/bfgs';

const th = DEFAULT_SETTINGS.scaffold;
const close = (a: Vec3, b: Vec3, tol = 1e-6) => expect(dist(a, b)).toBeLessThan(tol);
const angleDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.min(1, Math.abs(dot(normalize(a), normalize(b))))) * 180) / Math.PI;

function emptyContext(): ScaffoldContext {
  return { keypoints: [], lines: [], directions: [[0, 1, 0]], lengths: [] };
}

describe('optimizers', () => {
  it('LM solves a small nonlinear least squares problem', () => {
    const r = levenbergMarquardt((x) => [x[0] - 1, 10 * (x[1] - x[0] * x[0])], [-1.2, 1]);
    expect(r.x[0]).toBeCloseTo(1, 6);
    expect(r.x[1]).toBeCloseTo(1, 6);
  });
  it('BFGS minimises the Rosenbrock function', () => {
    const r = bfgs((x) => (1 - x[0]) ** 2 + 100 * (x[1] - x[0] ** 2) ** 2, [-1.2, 1], { maxIterations: 500 });
    expect(r.x[0]).toBeCloseTo(1, 3);
    expect(r.x[1]).toBeCloseTo(1, 3);
  });
});

describe('scaffold auto-correct', () => {
  it('leaves an unconstrained line alone', () => {
    const r = autocorrectScaffoldLine([0, 0, 0], [0.3, 0.1, 0.2], { ...emptyContext(), directions: [] }, th);
    close(r.a, [0, 0, 0]);
    close(r.b, [0.3, 0.1, 0.2]);
  });

  it('snaps a nearly vertical line to vertical', () => {
    const r = autocorrectScaffoldLine([0, 0, 0], [0.02, 0.3, 0.01], emptyContext(), th);
    expect(angleDeg(sub(r.b, r.a), [0, 1, 0])).toBeLessThan(1e-4);
  });

  it('closes a square: endpoints meet, sides perpendicular and equal', () => {
    let state: DrawingState = EMPTY;
    const add = (a: Vec3, b: Vec3) => {
      const r = addScaffoldStroke(state, a, b, DEFAULT_SETTINGS, 1);
      if (r.type !== 'line') throw new Error('expected a line');
      state = r.state;
      return r.line;
    };
    // A rough 30 cm square in the horizontal plane (directions: x, z).
    const l1 = add([0, 0, 0], [0.3, 0.004, 0.01]);
    const l2 = add([0.31, 0.0, 0.02], [0.305, 0.006, 0.32]);
    const l3 = add([0.29, 0.01, 0.3], [0.01, 0.0, 0.305]);
    const l4 = add([-0.01, 0.0, 0.31], [0.015, -0.005, 0.01]);
    close(l2.a, l1.b, 1e-5);
    close(l3.a, l2.b, 1e-5);
    close(l4.a, l3.b, 1e-5);
    close(l4.b, l1.a, 1e-5);
    expect(angleDeg(sub(l1.b, l1.a), sub(l2.b, l2.a))).toBeGreaterThan(90 - 1e-3);
    expect(Math.abs(dist(l3.a, l3.b) - dist(l1.a, l1.b))).toBeLessThan(1e-5);
    // Square stays horizontal-ish: perpendicular to vertical.
    expect(Math.abs(dot(normalize(sub(l2.b, l2.a)), [0, 1, 0]))).toBeLessThan(1e-4);
  });

  it('resolves conflicting point-point candidates to one instead of compromising', () => {
    const context: ScaffoldContext = {
      keypoints: [
        [0, 0, 0],
        [0.03, 0, 0],
      ],
      lines: [],
      directions: [],
      lengths: [],
    };
    const r = autocorrectScaffoldLine([0.012, 0.01, 0], [0.1, 0.5, 0.3], context, th);
    const d = Math.min(dist(r.a, [0, 0, 0]), dist(r.a, [0.03, 0, 0]));
    expect(d).toBeLessThan(1e-5);
  });

  it('attaches an endpoint to the middle of a line (point-line)', () => {
    let state: DrawingState = EMPTY;
    let r = addScaffoldStroke(state, [0, 0, 0], [0.4, 0, 0], DEFAULT_SETTINGS, 1);
    state = r.type === 'line' ? r.state : state;
    r = addScaffoldStroke(state, [0.13, 0.02, 0.01], [0.15, 0.03, 0.25], DEFAULT_SETTINGS, 1);
    if (r.type !== 'line') throw new Error();
    expect(Math.abs(r.line.a[1]) + Math.abs(r.line.a[2])).toBeLessThan(1e-5);
  });

  it('thresholds scale with zoom: a 4 cm gap snaps at zoom 1 but not when zoomed in 4×', () => {
    let state: DrawingState = EMPTY;
    const r0 = addScaffoldStroke(state, [0, 0, 0], [0.3, 0.1, 0.05], DEFAULT_SETTINGS, 1);
    state = r0.type === 'line' ? r0.state : state;
    const near: Vec3 = [0.3 + 0.03, 0.1 + 0.02, 0.05];
    const far: Vec3 = [0.5, 0.42, 0.33];
    const snapped = addScaffoldStroke(state, near, far, DEFAULT_SETTINGS, 1);
    const unsnapped = addScaffoldStroke(state, near, far, DEFAULT_SETTINGS, 4);
    if (snapped.type !== 'line' || unsnapped.type !== 'line') throw new Error();
    close(snapped.line.a, [0.3, 0.1, 0.05], 1e-5);
    expect(dist(unsnapped.line.a, [0.3, 0.1, 0.05])).toBeGreaterThan(0.01);
  });

  it('a very short stroke across a line becomes a tick keypoint', () => {
    let state: DrawingState = EMPTY;
    const r0 = addScaffoldStroke(state, [0, 0, 0], [0.4, 0, 0], DEFAULT_SETTINGS, 1);
    state = r0.type === 'line' ? r0.state : state;
    const r = addScaffoldStroke(state, [0.1, -0.01, 0.005], [0.105, 0.01, 0.0], DEFAULT_SETTINGS, 1);
    expect(r.type).toBe('tick');
    if (r.type !== 'tick') return;
    expect(Math.abs(r.tick.point[1]) + Math.abs(r.tick.point[2])).toBeLessThan(1e-9);
    expect(keypoints(r.state)).toHaveLength(4);
  });
});

/** A square scaffold of side 0.3 in the xz plane, with tangents along the edges. */
function squareScaffold(): DrawingState {
  let state: DrawingState = EMPTY;
  const corners: Vec3[] = [
    [0, 0, 0],
    [0.3, 0, 0],
    [0.3, 0, 0.3],
    [0, 0, 0.3],
  ];
  for (let i = 0; i < 4; i++) {
    const r = addScaffoldStroke(state, corners[i], corners[(i + 1) % 4], DEFAULT_SETTINGS, 1);
    if (r.type === 'line') state = r.state;
  }
  return state;
}

function wobble(points: Vec3[], amount: number, seed = 1): Vec3[] {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * amount;
  return points.map((p) => [p[0] + rand(), p[1] + rand(), p[2] + rand()]);
}

describe('shape auto-correct', () => {
  it('menger curvature of points on a circle is 1/R', () => {
    const R = 0.2;
    const p = (t: number): Vec3 => [R * Math.cos(t), R * Math.sin(t), 0];
    expect(mengerCurvature(p(0), p(0.3), p(0.7))).toBeCloseTo(1 / R, 9);
  });

  it('a circle through the four edge midpoints becomes a near-circle', () => {
    const state = squareScaffold();
    const raw: Vec3[] = [];
    for (let k = 0; k <= 100; k++) {
      const t = (2 * Math.PI * k) / 100 - Math.PI / 2;
      raw.push([0.15 + 0.15 * Math.cos(t), 0, 0.15 + 0.15 * Math.sin(t)]);
    }
    const r = autocorrectShapeStroke(wobble(raw, 0.005), keypoints(state), DEFAULT_SETTINGS.shape);
    expect(r?.kind).toBe('curve');
    if (!r) return;
    expect(r.keypoints).toHaveLength(5); // four midpoints, closed
    const radii = r.points.map((p) => dist(p, [0.15, 0, 0.15]));
    const max = Math.max(...radii);
    const min = Math.min(...radii);
    expect(max - min).toBeLessThan(0.15 * 0.02); // within 2% of a circle
    // Tangent at a midpoint follows the square's edge.
    expect(angleDeg(r.tangents[0], [1, 0, 0])).toBeLessThan(1e-6);
  });

  it('a nearly straight stroke between corners becomes the exact diagonal', () => {
    const state = squareScaffold();
    const raw: Vec3[] = [];
    for (let k = 0; k <= 40; k++) raw.push([(0.3 * k) / 40, 0, (0.3 * k) / 40]);
    const r = autocorrectShapeStroke(wobble(raw, 0.004), keypoints(state), DEFAULT_SETTINGS.shape);
    expect(r?.kind).toBe('straight');
    close(r!.points[0], [0, 0, 0]);
    close(r!.points[1], [0.3, 0, 0.3]);
  });

  it('a stroke away from the scaffold stays freeform', () => {
    const state = squareScaffold();
    const raw: Vec3[] = [];
    for (let k = 0; k <= 40; k++) raw.push([1 + 0.1 * Math.cos(k / 10), 1, 0.1 * Math.sin(k / 10)]);
    const r = addShapeStroke(state, raw, DEFAULT_SETTINGS, 1);
    expect(r.type === 'stroke' && r.stroke.kind).toBe('freeform');
  });

  it('MVC beats the initial chord/3 magnitudes', () => {
    const state = squareScaffold();
    const raw: Vec3[] = [];
    for (let k = 0; k <= 50; k++) {
      const t = (Math.PI * k) / 50;
      raw.push([0.15 - 0.15 * Math.cos(t), 0, 0.15 * Math.sin(t) * 1.2]);
    }
    const r = autocorrectShapeStroke(raw, keypoints(state), DEFAULT_SETTINGS.shape);
    expect(r?.kind).toBe('curve');
    if (!r?.beziers) return;
    const initial = r.beziers.map(([c0, , , c3], i) => {
      const d = dist(c0, c3) / 3;
      const t0 = r.tangents[i];
      const t1 = r.tangents[i + 1];
      return [c0, [c0[0] + d * t0[0], c0[1] + d * t0[1], c0[2] + d * t0[2]], [c3[0] - d * t1[0], c3[1] - d * t1[1], c3[2] - d * t1[2]], c3] as [Vec3, Vec3, Vec3, Vec3];
    });
    expect(curvatureVariation(sampleBeziers(r.beziers, 40), false)).toBeLessThanOrEqual(
      curvatureVariation(sampleBeziers(initial, 40), false) + 1e-9,
    );
  });
});

describe('history and serialization', () => {
  it('undo and redo', () => {
    const h = new History();
    const s1 = squareScaffold();
    h.push(s1);
    expect(h.undo()).toBe(true);
    expect(h.state.lines).toHaveLength(0);
    expect(h.redo()).toBe(true);
    expect(h.state.lines).toHaveLength(4);
  });
  it('round-trips', () => {
    const s = squareScaffold();
    expect(deserialize(serialize(s))).toEqual(s);
  });
});
