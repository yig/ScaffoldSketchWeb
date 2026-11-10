/**
 * BFGS quasi-Newton minimisation with a central-difference gradient and a
 * backtracking (Armijo) line search. Used for the shape-stroke minimum
 * variation of curvature optimisation, which has 2 unknowns per Bézier segment.
 */

export interface BFGSOptions {
  maxIterations?: number;
  /** Stop when the gradient's max abs component is below this. */
  gradientTolerance?: number;
  /** Stop when the relative decrease in f over an iteration is below this. */
  relativeTolerance?: number;
  /** Finite-difference step. */
  h?: number;
}

export interface BFGSResult {
  x: number[];
  value: number;
  iterations: number;
}

export function bfgs(f: (x: number[]) => number, x0: number[], options: BFGSOptions = {}): BFGSResult {
  const { maxIterations = 200, gradientTolerance = 1e-9, relativeTolerance = 1e-10, h = 1e-6 } = options;
  const n = x0.length;
  let x = x0.slice();
  let fx = f(x);
  let g = gradient(f, x, h);
  // Inverse Hessian approximation, starts as identity.
  let H: number[][] = identity(n);
  let iterations = 0;

  for (; iterations < maxIterations; iterations++) {
    if (Math.max(...g.map(Math.abs)) < gradientTolerance) break;
    // Search direction p = −H g; fall back to steepest descent if not a descent direction.
    let p = H.map((row) => -row.reduce((s, v, j) => s + v * g[j], 0));
    let slope = dotN(p, g);
    if (!(slope < 0)) {
      H = identity(n);
      p = g.map((v) => -v);
      slope = dotN(p, g);
    }
    let alpha = 1;
    let xn = x;
    let fn = fx;
    let accepted = false;
    for (let k = 0; k < 40; k++) {
      xn = x.map((v, i) => v + alpha * p[i]);
      fn = f(xn);
      if (Number.isFinite(fn) && fn <= fx + 1e-4 * alpha * slope) {
        accepted = true;
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) break;
    const gn = gradient(f, xn, h);
    const s = xn.map((v, i) => v - x[i]);
    const y = gn.map((v, i) => v - g[i]);
    const sy = dotN(s, y);
    const decrease = fx - fn;
    x = xn;
    g = gn;
    const previous = fx;
    fx = fn;
    if (sy > 1e-300) {
      // H ← (I − ρ s yᵀ) H (I − ρ y sᵀ) + ρ s sᵀ
      const rho = 1 / sy;
      const Hy = H.map((row) => dotN(row, y));
      const yHy = dotN(y, Hy);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          H[i][j] += (1 + rho * yHy) * rho * s[i] * s[j] - rho * (Hy[i] * s[j] + s[i] * Hy[j]);
        }
      }
    }
    if (decrease <= relativeTolerance * Math.max(Math.abs(previous), 1e-300)) break;
  }
  return { x, value: fx, iterations };
}

function gradient(f: (x: number[]) => number, x: number[], h: number): number[] {
  const g = new Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const step = h * Math.max(1, Math.abs(x[i]));
    const xp = x.slice();
    const xm = x.slice();
    xp[i] += step;
    xm[i] -= step;
    g[i] = (f(xp) - f(xm)) / (2 * step);
  }
  return g;
}

function identity(n: number) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

function dotN(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
