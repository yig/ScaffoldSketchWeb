/**
 * Shape-stroke auto-correct (paper §4.2). The drawn 3D stroke selects a
 * sequence of scaffold keypoints Q and tangent directions D. Consecutive
 * keypoints are joined by cubic Bézier segments whose inner control points lie
 * along D; the two tangent magnitudes per segment are optimised to minimise
 * the variation of (Menger) curvature, which gives circular arcs where the
 * constraints allow and clothoid-like curves otherwise. Nearly straight input
 * becomes a straight segment.
 */

import { bfgs } from '../optimize/bfgs';
import {
  add,
  addScaled,
  cross,
  dist,
  dot,
  norm,
  normalize,
  polylineLength,
  principalAxis,
  resample,
  scale,
  sub,
  unsignedAngle,
  type Vec3,
} from '../geometry/vec';

export interface ShapeThresholds {
  /** Distance from a stroke sample to a keypoint for the keypoint to be selected. Paper: 3 cm. */
  keypointDistance: number;
  /** Snap to a scaffold line's direction if within this angle. Paper: 25°. */
  tangentDegrees: number;
  /** Input resampling step. Paper: 1 cm. */
  sampleSpacing: number;
  /** Straight if the max distance to the PCA line is below this fraction of its length. Paper: 8%. */
  straightDeviation: number;
  /** …and the PCA line length is within this fraction of the stroke's arc length. Paper: 10%. */
  straightLength: number;
}

/** A scaffold keypoint and the unit directions of the scaffold lines passing through it. */
export interface Keypoint {
  position: Vec3;
  directions: Vec3[];
}

export type ShapeKind = 'curve' | 'straight' | 'freeform';

export interface ShapeResult {
  kind: ShapeKind;
  /** The auto-corrected stroke as a dense polyline. */
  points: Vec3[];
  /** Indices into the keypoint list, in stroke order (Q). */
  keypoints: number[];
  /** Unit tangent at each selected keypoint (D). */
  tangents: Vec3[];
  /** For curves: the Bézier control points, four per segment. */
  beziers?: [Vec3, Vec3, Vec3, Vec3][];
}

const DEG = Math.PI / 180;
/** Output polyline samples per Bézier segment. */
const OUTPUT_SAMPLES = 32;
/** Samples used by the curvature objective across the whole curve. */
const OBJECTIVE_SAMPLES = 120;

export function autocorrectShapeStroke(raw: Vec3[], keypoints: Keypoint[], th: ShapeThresholds): ShapeResult | null {
  const samples = resample(raw, th.sampleSpacing);
  if (samples.length < 3) return null;

  const { order, runs } = selectKeypoints(samples, keypoints, th.keypointDistance);
  const closed = order.length >= 3 && order[0] === order[order.length - 1];

  if (isStraight(samples, th)) {
    if (order.length >= 2 && order[0] !== order[order.length - 1]) {
      const a = keypoints[order[0]].position;
      const b = keypoints[order[order.length - 1]].position;
      const d = normalize(sub(b, a));
      return { kind: 'straight', points: [a, b], keypoints: [order[0], order[order.length - 1]], tangents: [d, d] };
    }
    const segment = pcaSegment(samples);
    return { kind: 'straight', points: segment, keypoints: [], tangents: [] };
  }

  if (order.length < 2) {
    // Not attached to the scaffold: keep the stroke, lightly smoothed.
    return { kind: 'freeform', points: smooth(samples, 4), keypoints: [], tangents: [] };
  }

  const tangents = order.map((k, i) => {
    let indices = runs[i];
    // A closed stroke starts and ends at the same keypoint: one tangent for both.
    if (closed && (i === 0 || i === order.length - 1)) indices = [...runs[runs.length - 1], ...runs[0]];
    return chooseTangent(samples, indices, keypoints[k], th.tangentDegrees, closed && (i === 0 || i === order.length - 1));
  });

  const points = order.map((k) => keypoints[k].position);
  const magnitudes = optimizeMagnitudes(points, tangents, closed);
  const beziers = bezierSegments(points, tangents, magnitudes);
  return { kind: 'curve', points: sampleBeziers(beziers, OUTPUT_SAMPLES), keypoints: order, tangents, beziers };
}

/**
 * For each sample, the nearest keypoint within `threshold`. Returns the
 * sequence of selected keypoints with consecutive repeats removed (Q), and
 * for each entry the sample indices that selected it.
 */
export function selectKeypoints(samples: Vec3[], keypoints: Keypoint[], threshold: number) {
  const order: number[] = [];
  const runs: number[][] = [];
  samples.forEach((p, i) => {
    let best = -1;
    let bestDistance = threshold;
    keypoints.forEach((k, j) => {
      const d = dist(p, k.position);
      if (d <= bestDistance) {
        bestDistance = d;
        best = j;
      }
    });
    if (best < 0) return;
    if (order.length && order[order.length - 1] === best) runs[runs.length - 1].push(i);
    else {
      order.push(best);
      runs.push([i]);
    }
  });
  return { order, runs };
}

/**
 * Tangent at a keypoint: the local direction of the input near it (samples
 * `indices`); if that is within `degrees` of a scaffold line through the
 * keypoint, the line's direction instead (oriented like the input).
 */
function chooseTangent(samples: Vec3[], indices: number[], keypoint: Keypoint, degrees: number, wraps: boolean): Vec3 {
  const local = localDirection(samples, indices, wraps);
  let best: Vec3 | null = null;
  let bestAngle = degrees * DEG;
  for (const d of keypoint.directions) {
    const angle = unsignedAngle(local, d);
    if (angle < bestAngle) {
      bestAngle = angle;
      best = dot(local, d) >= 0 ? normalize(d) : scale(normalize(d), -1);
    }
  }
  return best ?? local;
}

/** Average input direction over the samples near a keypoint. */
function localDirection(samples: Vec3[], indices: number[], wraps: boolean): Vec3 {
  const n = samples.length;
  let sum: Vec3 = [0, 0, 0];
  for (const i of indices) {
    // Forward difference (backward at the last sample; around the loop for closed strokes).
    const j = i + 1 < n ? i + 1 : wraps ? 1 : i;
    const k = i + 1 < n ? i : wraps ? 0 : i - 1;
    sum = add(sum, normalize(sub(samples[j], samples[k])));
  }
  if (norm(sum) > 1e-9) return normalize(sum);
  // Directions cancelled (e.g. a cusp at the keypoint): use the chord through the neighbourhood.
  const first = samples[Math.max(0, Math.min(...indices) - 1)];
  const last = samples[Math.min(n - 1, Math.max(...indices) + 1)];
  return normalize(sub(last, first));
}

function isStraight(samples: Vec3[], th: ShapeThresholds): boolean {
  const [a, b] = pcaSegment(samples);
  const length = dist(a, b);
  if (length === 0) return false;
  const axis = normalize(sub(b, a));
  let maxDeviation = 0;
  for (const p of samples) {
    const d = sub(p, a);
    maxDeviation = Math.max(maxDeviation, norm(sub(d, scale(axis, dot(d, axis)))));
  }
  const arc = polylineLength(samples);
  return maxDeviation < th.straightDeviation * length && Math.abs(arc - length) <= th.straightLength * arc;
}

/** The segment of the best-fit (PCA) line spanned by the samples' projections, oriented like the stroke. */
export function pcaSegment(samples: Vec3[]): [Vec3, Vec3] {
  const { center, axis } = principalAxis(samples);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of samples) {
    const t = dot(sub(p, center), axis);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const a = addScaled(center, axis, lo);
  const b = addScaled(center, axis, hi);
  return dot(sub(samples[samples.length - 1], samples[0]), axis) >= 0 ? [a, b] : [b, a];
}

/** Laplacian smoothing with fixed endpoints. */
function smooth(points: Vec3[], iterations: number): Vec3[] {
  let p = points.slice();
  for (let it = 0; it < iterations; it++) {
    p = p.map((q, i) => (i === 0 || i === p.length - 1 ? q : scale(add(add(p[i - 1], p[i + 1]), scale(q, 2)), 0.25)));
  }
  return p;
}

// ---------- Bézier splines and minimum variation of curvature ----------

export function bezierSegments(points: Vec3[], tangents: Vec3[], magnitudes: number[]): [Vec3, Vec3, Vec3, Vec3][] {
  const segments: [Vec3, Vec3, Vec3, Vec3][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const c0 = points[i];
    const c3 = points[i + 1];
    segments.push([c0, addScaled(c0, tangents[i], magnitudes[2 * i]), addScaled(c3, tangents[i + 1], -magnitudes[2 * i + 1]), c3]);
  }
  return segments;
}

export function bezierPoint([c0, c1, c2, c3]: [Vec3, Vec3, Vec3, Vec3], t: number): Vec3 {
  const s = 1 - t;
  const w0 = s * s * s;
  const w1 = 3 * s * s * t;
  const w2 = 3 * s * t * t;
  const w3 = t * t * t;
  return [
    w0 * c0[0] + w1 * c1[0] + w2 * c2[0] + w3 * c3[0],
    w0 * c0[1] + w1 * c1[1] + w2 * c2[1] + w3 * c3[1],
    w0 * c0[2] + w1 * c1[2] + w2 * c2[2] + w3 * c3[2],
  ];
}

/** Sample segments with `counts[i]` samples on [0, 1) each, plus the final endpoint. */
function sampleWithCounts(segments: [Vec3, Vec3, Vec3, Vec3][], counts: number[], includeEnd: boolean): Vec3[] {
  const out: Vec3[] = [];
  segments.forEach((seg, i) => {
    for (let k = 0; k < counts[i]; k++) out.push(bezierPoint(seg, k / counts[i]));
  });
  if (includeEnd) out.push(segments[segments.length - 1][3]);
  return out;
}

export function sampleBeziers(segments: [Vec3, Vec3, Vec3, Vec3][], perSegment: number): Vec3[] {
  return sampleWithCounts(segments, segments.map(() => perSegment), true);
}

/** Menger curvature 1/R of the circle through a, b, c. */
export function mengerCurvature(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = dist(a, b);
  const bc = dist(b, c);
  const ca = dist(c, a);
  const denominator = ab * bc * ca;
  if (denominator < 1e-300) return 0;
  return (2 * norm(cross(sub(a, b), sub(c, b)))) / denominator;
}

/**
 * Discrete ∫(dκ/ds)² ds of a sampled curve: Σ (κᵢ₊₁ − κᵢ)² / Δsᵢ with Menger
 * curvature κ. Closed curves wrap around.
 */
export function curvatureVariation(samples: Vec3[], closed: boolean): number {
  const n = samples.length;
  const at = (i: number) => samples[((i % n) + n) % n];
  const curvatures: number[] = [];
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;
  for (let i = first; i <= last; i++) curvatures.push(mengerCurvature(at(i - 1), at(i), at(i + 1)));
  let total = 0;
  const pairs = closed ? curvatures.length : curvatures.length - 1;
  for (let k = 0; k < pairs; k++) {
    const i = first + k;
    const ds = Math.max(dist(at(i), at(i + 1)), 1e-12);
    const dk = curvatures[(k + 1) % curvatures.length] - curvatures[k];
    total += (dk * dk) / ds;
  }
  return total;
}

/**
 * Tangent magnitudes (two per segment) minimising the variation of curvature.
 * Magnitudes are optimised as log(x / chord), initialised to chord/3 (no cusps),
 * and kept within [2%, 150%] of the chord by a penalty.
 */
export function optimizeMagnitudes(points: Vec3[], tangents: Vec3[], closed = false): number[] {
  const chords = points.slice(1).map((p, i) => dist(points[i], p));
  const totalChord = chords.reduce((s, c) => s + c, 0);
  const counts = chords.map((c) => Math.max(8, Math.round((OBJECTIVE_SAMPLES * c) / totalChord)));
  // The energy scales like 1/length³; normalise so tolerances are scale-free.
  const normaliser = totalChord ** 3;
  const lo = Math.log(0.02);
  const hi = Math.log(1.5);
  const toMagnitudes = (y: number[]) => y.map((v, i) => chords[i >> 1] * Math.exp(v));
  const objective = (y: number[]) => {
    const samples = sampleWithCounts(bezierSegments(points, tangents, toMagnitudes(y)), counts, !closed);
    let penalty = 0;
    for (const v of y) {
      if (v < lo) penalty += (lo - v) ** 2;
      if (v > hi) penalty += (v - hi) ** 2;
    }
    return curvatureVariation(samples, closed) * normaliser + 1e3 * penalty;
  };
  const y0 = chords.flatMap(() => [Math.log(1 / 3), Math.log(1 / 3)]);
  const result = bfgs(objective, y0, { maxIterations: 150, gradientTolerance: 1e-7, relativeTolerance: 1e-9 });
  const y = result.value <= objective(y0) ? result.x : y0;
  return toMagnitudes(y.map((v) => Math.min(hi, Math.max(lo, v))));
}
