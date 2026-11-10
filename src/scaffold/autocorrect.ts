/**
 * Scaffold-line auto-correct (paper §4.1). A newly drawn straight line l = (a, b)
 * is related to the existing scaffold by candidate constraints (point–point,
 * point–line, perpendicular, parallel, equal length). Candidates within their
 * inclusion threshold are combined by iteratively re-weighted least squares
 * (IRLS) so that a mutually satisfiable subset ends up exactly satisfied and
 * conflicting candidates are discarded.
 */

import { levenbergMarquardt } from '../optimize/levenbergMarquardt';
import {
  cross,
  dist,
  dot,
  norm,
  normalize,
  projectParameter,
  scale,
  sub,
  type Vec3,
} from '../geometry/vec';

/** Thresholds in drawing units (lengths) and degrees / ratios (scale-free). */
export interface ScaffoldThresholds {
  /** Endpoint–keypoint inclusion distance. Paper: 5 cm. */
  pointPoint: number;
  /** Endpoint–line inclusion distance. Paper: 5 cm. */
  pointLine: number;
  /** Paper: 10°. */
  parallelDegrees: number;
  /** Paper: 10°. */
  perpendicularDegrees: number;
  /** Relative length difference. Paper: 25%. */
  lengthRatio: number;
}

/** What the new line is auto-corrected against. */
export interface ScaffoldContext {
  /** Keypoints: line endpoints, midpoints and tick marks. */
  keypoints: Vec3[];
  /** Existing scaffold lines as endpoint pairs. */
  lines: [Vec3, Vec3][];
  /** Unit directions to be parallel or perpendicular to (existing lines and the vertical axis). */
  directions: Vec3[];
  /** Existing line lengths. */
  lengths: number[];
}

export type ConstraintKind = 'point-point' | 'point-line' | 'perpendicular' | 'parallel' | 'equal-length';

export interface Constraint {
  kind: ConstraintKind;
  /** Which endpoint (0 = a, 1 = b) for point constraints. */
  end?: 0 | 1;
  /** Index into the context's keypoints / lines / directions / lengths. */
  target: number;
  /**
   * Residual vector, normalised so that ‖r‖² = 1 exactly at the inclusion
   * threshold. C(l) = ‖r‖² is the paper's squared deviation (up to the
   * threshold scale, which makes different kinds comparable).
   */
  residual: (a: Vec3, b: Vec3) => number[];
  /** Initial IRLS weight: paper favours point–point with 100, others 1. */
  initialWeight: number;
}

export interface ScaffoldResult {
  a: Vec3;
  b: Vec3;
  /** All candidates considered. */
  candidates: Constraint[];
  /** Candidates that are satisfied by the result. */
  satisfied: Constraint[];
  iterations: number;
}

const DEG = Math.PI / 180;
/** The ε in w = 1/(ε + C). C is threshold-normalised, so this is a residual of 1% of the threshold. */
const IRLS_EPSILON = 1e-4;
/** A constraint whose normalised C is below this after IRLS counts as satisfied. */
const SATISFIED = 1e-2;
const MAX_IRLS_ITERATIONS = 20;

/** Enumerate the candidate constraints for a drawn line (a, b) whose value is under threshold. */
export function candidateConstraints(a: Vec3, b: Vec3, context: ScaffoldContext, th: ScaffoldThresholds): Constraint[] {
  const result: Constraint[] = [];
  const ends: [Vec3, Vec3] = [a, b];
  const consider = (c: Constraint) => {
    if (sumSquares(c.residual(a, b)) < 1) result.push(c);
  };
  const endpoint = (e: 0 | 1) => (x: Vec3, y: Vec3) => (e === 0 ? x : y);

  // Point–point: each endpoint to every keypoint. Skip a keypoint that is closer
  // to the other endpoint, so both ends can't collapse onto the same point.
  context.keypoints.forEach((p, i) => {
    for (const e of [0, 1] as const) {
      const here = ends[e];
      const other = ends[1 - e];
      if (dist(other, p) < dist(here, p)) continue;
      const pick = endpoint(e);
      consider({
        kind: 'point-point',
        end: e,
        target: i,
        initialWeight: 100,
        residual: (x, y) => scale(sub(pick(x, y), p), 1 / th.pointPoint),
      });
    }
  });

  // Point–line: each endpoint to every scaffold line it abuts (its projection
  // falls on the segment, allowing the threshold's slack at either end).
  context.lines.forEach(([ka, kb], i) => {
    const length = dist(ka, kb);
    if (length === 0) return;
    const axis = sub(ka, kb);
    const slack = th.pointLine / length;
    for (const e of [0, 1] as const) {
      const t = projectParameter(ends[e], ka, kb);
      if (t < -slack || t > 1 + slack) continue;
      const pick = endpoint(e);
      consider({
        kind: 'point-line',
        end: e,
        target: i,
        initialWeight: 1,
        residual: (x, y) => scale(cross(axis, sub(ka, pick(x, y))), 1 / (length * th.pointLine)),
      });
    }
  });

  // Perpendicular and parallel to each direction. As in the paper, the residuals
  // use the line vector l_b − l_a itself (normalised by the drawn length L₀, a
  // constant), not its unit direction: they are then linear in the endpoints, so
  // the solver rotates the line instead of stretching it to shrink the angle.
  // |(l_b − l_a)·d| / L₀ = sin(angle from perpendicular) and
  // ‖(l_b − l_a) × d‖ / L₀ = sin(angle from parallel) at the drawn line.
  const drawnLength = dist(a, b);
  if (drawnLength > 0) {
    const perpendicularScale = 1 / (drawnLength * Math.sin(th.perpendicularDegrees * DEG));
    const parallelScale = 1 / (drawnLength * Math.sin(th.parallelDegrees * DEG));
    context.directions.forEach((d, i) => {
      consider({
        kind: 'perpendicular',
        target: i,
        initialWeight: 1,
        residual: (x, y) => [dot(sub(y, x), d) * perpendicularScale],
      });
      consider({
        kind: 'parallel',
        target: i,
        initialWeight: 1,
        residual: (x, y) => scale(cross(sub(y, x), d), parallelScale),
      });
    });
  }

  // Equal length to each existing length.
  context.lengths.forEach((length, i) => {
    if (length <= 0) return;
    consider({
      kind: 'equal-length',
      target: i,
      initialWeight: 1,
      residual: (x, y) => [(dist(x, y) / length - 1) / th.lengthRatio],
    });
  });

  return result;
}

/**
 * Auto-correct a drawn scaffold line against the scaffold with IRLS:
 * repeatedly solve min Σ wᵢ Cᵢ(l), then set wᵢ = 1/(ε + Cᵢ). Satisfiable
 * constraints gain weight, conflicting ones lose it, until weights are
 * effectively binary. A final solve with only the satisfied constraints makes
 * them exact.
 */
export function autocorrectScaffoldLine(
  a: Vec3,
  b: Vec3,
  context: ScaffoldContext,
  th: ScaffoldThresholds,
): ScaffoldResult {
  const candidates = candidateConstraints(a, b, context, th);
  if (candidates.length === 0) return { a, b, candidates, satisfied: [], iterations: 0 };

  let x = [...a, ...b];
  // First weights come from the drawn line itself (favouring point–point), so
  // the first solve already leans towards the nearer of two conflicting candidates.
  let weights = normalizeMax(costs(candidates, x).map((c, i) => candidates[i].initialWeight / (IRLS_EPSILON + c)));
  let iterations = 0;
  for (; iterations < MAX_IRLS_ITERATIONS; iterations++) {
    const next = solveWeighted(candidates, weights, x);
    const change = Math.max(...next.map((v, i) => Math.abs(v - x[i])));
    x = next;
    const values = costs(candidates, x);
    weights = normalizeMax(values.map((c) => 1 / (IRLS_EPSILON + c)));
    if (change < 1e-9 * Math.max(1, ...x.map(Math.abs)) && iterations > 0) break;
  }

  // Polish: exactly satisfy the constraints IRLS kept.
  const values = costs(candidates, x);
  let satisfied = candidates.filter((_, i) => values[i] < SATISFIED);
  if (satisfied.length) {
    const polished = solveWeighted(satisfied, satisfied.map(() => 1), x);
    const after = costs(satisfied, polished);
    if (after.every((c) => c < 1e-8)) x = polished;
    const final = costs(candidates, x);
    satisfied = candidates.filter((_, i) => final[i] < SATISFIED);
  }
  return { a: [x[0], x[1], x[2]], b: [x[3], x[4], x[5]], candidates, satisfied, iterations };
}

function solveWeighted(constraints: Constraint[], weights: number[], x0: number[]): number[] {
  const roots = weights.map(Math.sqrt);
  const residuals = (x: number[]) => {
    const a: Vec3 = [x[0], x[1], x[2]];
    const b: Vec3 = [x[3], x[4], x[5]];
    const out: number[] = [];
    constraints.forEach((c, i) => {
      if (roots[i] === 0) return;
      for (const v of c.residual(a, b)) out.push(roots[i] * v);
    });
    return out;
  };
  return levenbergMarquardt(residuals, x0, { maxIterations: 100, h: 1e-8 }).x;
}

function costs(constraints: Constraint[], x: number[]): number[] {
  const a: Vec3 = [x[0], x[1], x[2]];
  const b: Vec3 = [x[3], x[4], x[5]];
  return constraints.map((c) => sumSquares(c.residual(a, b)));
}

function normalizeMax(weights: number[]) {
  const max = Math.max(...weights);
  return weights.map((w) => w / max);
}

function sumSquares(r: number[]) {
  let s = 0;
  for (const v of r) s += v * v;
  return s;
}

/** Remove near-duplicate directions (within `degrees`, either sign). */
export function uniqueDirections(directions: Vec3[], degrees = 0.5): Vec3[] {
  const out: Vec3[] = [];
  const limit = Math.cos(degrees * DEG);
  for (const d of directions) {
    const u = normalize(d);
    if (norm(u) === 0) continue;
    if (!out.some((o) => Math.abs(dot(o, u)) > limit)) out.push(u);
  }
  return out;
}

/** Remove near-duplicate lengths (within relative `tolerance`). */
export function uniqueLengths(lengths: number[], tolerance = 1e-3): number[] {
  const out: number[] = [];
  for (const l of lengths) if (l > 0 && !out.some((o) => Math.abs(o - l) <= tolerance * o)) out.push(l);
  return out;
}
