/**
 * Levenberg–Marquardt for small nonlinear least-squares problems
 * min_x ½‖r(x)‖², with a forward-difference Jacobian. Scaffold auto-correct
 * has six unknowns, so a dense solve is cheap.
 */

export interface LMOptions {
  maxIterations?: number;
  /** Stop when the step is smaller than this (max abs component). */
  stepTolerance?: number;
  /** Stop when the cost falls below this (or improves by a negligible fraction). */
  costTolerance?: number;
  /** Finite-difference step for the Jacobian. */
  h?: number;
}

export interface LMResult {
  x: number[];
  cost: number;
  iterations: number;
}

export function levenbergMarquardt(
  residuals: (x: number[]) => number[],
  x0: number[],
  options: LMOptions = {},
): LMResult {
  const { maxIterations = 200, stepTolerance = 1e-12, costTolerance = 1e-20, h = 1e-7 } = options;
  const n = x0.length;
  let x = x0.slice();
  let r = residuals(x);
  let cost = sumSquares(r);
  let lambda = 1e-3;
  let iterations = 0;

  for (; iterations < maxIterations && cost > costTolerance; iterations++) {
    const m = r.length;
    // Jacobian J (m × n), forward differences.
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const xh = x.slice();
      const step = h * Math.max(1, Math.abs(x[j]));
      xh[j] += step;
      const rh = residuals(xh);
      for (let i = 0; i < m; i++) J[i][j] = (rh[i] - r[i]) / step;
    }
    // Normal equations JᵀJ δ = −Jᵀr.
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      const Ji = J[i];
      for (let a = 0; a < n; a++) {
        g[a] += Ji[a] * r[i];
        for (let b = a; b < n; b++) A[a][b] += Ji[a] * Ji[b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    const floor = 1e-6 * Math.max(1e-300, ...A.map((row, a) => row[a]));

    let improved = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      // Marquardt scaling plus a small isotropic term: directions the residuals
      // don't see (e.g. a line's length under a pure direction constraint) stay
      // put instead of drifting on finite-difference noise.
      const D = A.map((row, a) => row.map((v, b) => (a === b ? v + lambda * v + floor : v)));
      const delta = solve(D, g.map((v) => -v));
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, k) => v + delta[k]);
      const rn = residuals(xn);
      const cn = sumSquares(rn);
      if (cn < cost) {
        const stepSize = Math.max(...delta.map(Math.abs));
        const negligible = cost - cn <= 1e-12 * cost;
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
        if (stepSize < stepTolerance || negligible) return { x, cost, iterations: iterations + 1 };
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { x, cost, iterations };
}

function sumSquares(r: number[]) {
  let s = 0;
  for (const v of r) s += v * v;
  return s;
}

/** Solve A x = b by Gaussian elimination with partial pivoting; null if singular. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}
