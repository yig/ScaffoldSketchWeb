/** Small 3D vector helpers on plain tuples, so the algorithms run anywhere (browser, tests) without three.js. */

export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
/** a + s·b */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm2 = (a: Vec3) => dot(a, a);
export const norm = (a: Vec3) => Math.sqrt(dot(a, a));
export const dist = (a: Vec3, b: Vec3) => norm(sub(a, b));
export const dist2 = (a: Vec3, b: Vec3) => norm2(sub(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => addScaled(a, sub(b, a), t);
export const midpoint = (a: Vec3, b: Vec3): Vec3 => lerp(a, b, 0.5);

/** Unit vector along `a` (zero vector stays zero). */
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
}

/** Squared distance from `p` to the infinite line through `a` and `b`. */
export function pointLineDistance2(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(a, b);
  const len2 = norm2(ab);
  if (len2 === 0) return dist2(p, a);
  return norm2(cross(ab, sub(a, p))) / len2;
}

/** Parameter t of the closest point a + t·(b − a) on the infinite line to `p`. */
export function projectParameter(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = norm2(ab);
  return len2 === 0 ? 0 : dot(sub(p, a), ab) / len2;
}

/** Squared distance from `p` to the segment [a, b]. */
export function pointSegmentDistance2(p: Vec3, a: Vec3, b: Vec3): number {
  const t = Math.min(1, Math.max(0, projectParameter(p, a, b)));
  return dist2(p, lerp(a, b, t));
}

/** Total length of a polyline. */
export function polylineLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/**
 * Resample a polyline at (approximately) even arc-length spacing `step`,
 * keeping the first and last points. Returns at least two points if the input
 * has two distinct points.
 */
export function resample(points: Vec3[], step: number): Vec3[] {
  if (points.length < 2) return points.slice();
  const total = polylineLength(points);
  if (total === 0) return [points[0]];
  const n = Math.max(2, Math.round(total / step) + 1);
  return resampleCount(points, n);
}

/** Resample a polyline to exactly `n` ≥ 2 points evenly spaced in arc length. */
export function resampleCount(points: Vec3[], n: number): Vec3[] {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + dist(points[i - 1], points[i]));
  const total = cumulative[cumulative.length - 1];
  const out: Vec3[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = (total * k) / (n - 1);
    while (seg < points.length - 2 && cumulative[seg + 1] < s) seg++;
    const len = cumulative[seg + 1] - cumulative[seg];
    const t = len > 0 ? (s - cumulative[seg]) / len : 0;
    out.push(lerp(points[seg], points[seg + 1], Math.min(1, Math.max(0, t))));
  }
  return out;
}

/** Angle in radians between two directions, ignoring sign (0…π/2). */
export function unsignedAngle(a: Vec3, b: Vec3): number {
  const c = Math.abs(dot(normalize(a), normalize(b)));
  return Math.acos(Math.min(1, c));
}

/**
 * Largest eigenvector of a symmetric 3×3 matrix via power iteration with
 * a deflation-free restart; good enough for PCA of stroke samples.
 */
export function principalAxis(points: Vec3[]): { center: Vec3; axis: Vec3 } {
  const n = points.length;
  let center: Vec3 = [0, 0, 0];
  for (const p of points) center = add(center, p);
  center = scale(center, 1 / n);
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const d = sub(p, center);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i * 3 + j] += d[i] * d[j];
  }
  // Start from the end-to-end direction (close to the answer for strokes), then iterate.
  let v = normalize(sub(points[n - 1], points[0]));
  if (norm2(v) === 0) v = [1, 0.3, 0.1];
  for (let it = 0; it < 100; it++) {
    const w: Vec3 = [
      c[0] * v[0] + c[1] * v[1] + c[2] * v[2],
      c[3] * v[0] + c[4] * v[1] + c[5] * v[2],
      c[6] * v[0] + c[7] * v[1] + c[8] * v[2],
    ];
    const next = normalize(w);
    if (norm2(next) === 0) break;
    const done = Math.abs(Math.abs(dot(next, v)) - 1) < 1e-14;
    v = next;
    if (done) break;
  }
  return { center, axis: v };
}
