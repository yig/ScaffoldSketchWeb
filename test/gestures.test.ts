import { describe, expect, it } from 'vitest';
import type { Hand3D } from '@ygingold/webhands3d';
import { GestureController, toDrawing, toPhysical, type GestureEvents } from '../src/input/gestures';
import { HandPoseDetector, type PenHand } from '../src/input/hands';
import type { Vec3 } from '../src/geometry/vec';

const hand = (handedness: 'Left' | 'Right', p: Vec3, pose: { bunched?: boolean; fist?: boolean } = {}): PenHand => ({
  handedness,
  joints: [],
  bunched: !!pose.bunched,
  fist: !!pose.fist,
  pen: p,
  palm: p,
});
const noKeys = { draw: false };
const shift = { draw: true };

function recorder() {
  const log: string[] = [];
  const events: GestureEvents = {
    strokeStart: () => log.push('start'),
    strokeMove: () => log.push('move'),
    strokeEnd: () => log.push('end'),
    strokeCancel: () => log.push('cancel'),
    navigate: () => {},
    navigateEnd: () => log.push('navEnd'),
    toggleMode: () => log.push('toggle'),
  };
  return { log, events };
}

describe('navigation transform', () => {
  it('toDrawing inverts toPhysical', () => {
    const nav = { position: [0.1, -0.2, 0.3] as Vec3, angle: 0.7, scale: 2.5 };
    const p: Vec3 = [0.3, 0.4, -0.5];
    const q = toDrawing(nav, toPhysical(nav, p));
    p.forEach((v, i) => expect(q[i]).toBeCloseTo(v, 12));
  });
});

describe('gestures', () => {
  it('the right index fingertip draws while Shift is held', () => {
    const { log, events } = recorder();
    const g = new GestureController(events);
    g.update([hand('Right', [0, 0, 0])], noKeys);
    g.update([hand('Right', [0, 0, 0])], shift);
    g.update([hand('Right', [0.1, 0, 0])], shift);
    g.update([hand('Right', [0.1, 0, 0])], noKeys);
    expect(log).toEqual(['start', 'move', 'end']);
  });

  it('…or while the left hand’s fingertips are together', () => {
    const { log, events } = recorder();
    const g = new GestureController(events);
    g.update([hand('Right', [0, 0, 0]), hand('Left', [0.3, 0, 0], { bunched: true })], noKeys);
    g.update([hand('Right', [0.1, 0, 0]), hand('Left', [0.3, 0, 0], { bunched: true })], noKeys);
    g.update([hand('Right', [0.1, 0, 0]), hand('Left', [0.3, 0, 0])], noKeys);
    expect(log).toEqual(['start', 'move', 'end']);
  });

  it('right fingertips together toggles the mode once per gesture, and not while drawing', () => {
    const { log, events } = recorder();
    const g = new GestureController(events);
    g.update([hand('Right', [0, 0, 0], { bunched: true })], noKeys);
    g.update([hand('Right', [0, 0, 0], { bunched: true })], noKeys);
    g.update([hand('Right', [0, 0, 0])], noKeys);
    expect(log).toEqual(['toggle']);
    g.update([hand('Right', [0, 0, 0])], shift);
    g.update([hand('Right', [0, 0, 0], { bunched: true })], shift);
    expect(log.filter((e) => e === 'toggle')).toHaveLength(1);
  });

  it('two fists move, turn and zoom, keeping points under the fists', () => {
    const { log, events } = recorder();
    const g = new GestureController(events);
    const left0: Vec3 = [0.1, 0, 0];
    const right0: Vec3 = [0.3, 0, 0];
    const anchorLeft = toDrawing(g.nav, left0);
    const anchorRight = toDrawing(g.nav, right0);
    g.update([hand('Left', left0, { fist: true }), hand('Right', right0, { fist: true })], noKeys);
    const left1: Vec3 = [0.0, 0.05, 0.05];
    const right1: Vec3 = [0.4, 0.05, -0.1];
    g.update([hand('Left', left1, { fist: true }), hand('Right', right1, { fist: true })], noKeys);
    expect(g.nav.scale).toBeCloseTo(Math.hypot(0.4, 0.15) / 0.2, 6);
    const l = toPhysical(g.nav, anchorLeft);
    const r = toPhysical(g.nav, anchorRight);
    expect(Math.hypot(l[0] - left1[0], l[2] - left1[2])).toBeLessThan(1e-9);
    expect(Math.hypot(r[0] - right1[0], r[2] - right1[2])).toBeLessThan(1e-9);
    g.update([hand('Left', left1), hand('Right', right1, { fist: true })], noKeys);
    expect(log).toEqual(['navEnd']);
  });

  it('fists during a stroke cancel it', () => {
    const { log, events } = recorder();
    const g = new GestureController(events);
    g.update([hand('Right', [0, 0, 0])], shift);
    g.update([hand('Left', [0, 0, 0], { fist: true }), hand('Right', [0.2, 0, 0], { fist: true })], shift);
    expect(log).toEqual(['start', 'cancel']);
  });
});

/** A synthetic right hand (metres, camera axes as webhands3d reports): palm in the xy plane, fingers along −y. */
function syntheticHand(pose: 'open' | 'fist' | 'bunched'): Hand3D {
  const mcps: Vec3[] = [
    [0.035, -0.09, 0.5],
    [0.012, -0.095, 0.5],
    [-0.01, -0.09, 0.5],
    [-0.03, -0.08, 0.5],
  ];
  const wrist: Vec3 = [0, 0, 0.5];
  const palm: Vec3 = [0.0015, -0.071, 0.5];
  const j: Vec3[] = new Array(21).fill(0).map(() => [0, 0, 0.5] as Vec3);
  j[0] = wrist;
  j[1] = [0.03, -0.02, 0.5];
  j[2] = [0.05, -0.04, 0.5];
  j[3] = [0.06, -0.06, 0.5];
  const tipFor = (m: Vec3): Vec3 =>
    pose === 'open' ? [m[0], m[1] - 0.08, m[2]] : pose === 'fist' ? [m[0] * 0.8, palm[1] + 0.005, 0.47] : [0.005, -0.15, 0.45];
  mcps.forEach((m, f) => {
    const base = 5 + 4 * f;
    const tip = tipFor(m);
    j[base] = m;
    j[base + 1] = [m[0] + (tip[0] - m[0]) / 3, m[1] + (tip[1] - m[1]) / 3, m[2] + (tip[2] - m[2]) / 3];
    j[base + 2] = [m[0] + (2 * (tip[0] - m[0])) / 3, m[1] + (2 * (tip[1] - m[1])) / 3, m[2] + (2 * (tip[2] - m[2])) / 3];
    j[base + 3] = tip;
  });
  j[4] = pose === 'open' ? [0.07, -0.08, 0.5] : pose === 'fist' ? [0.0, -0.06, 0.465] : [0.01, -0.145, 0.45];
  return { handedness: 'Right', joints: new Float32Array(j.flat()), confidence: 1, timestamp: 0 };
}

describe('hand poses', () => {
  it('classifies open, fist and five fingertips together', () => {
    const classify = (pose: 'open' | 'fist' | 'bunched') => {
      const [h] = new HandPoseDetector().update([syntheticHand(pose)], 0);
      return { bunched: h.bunched, fist: h.fist };
    };
    expect(classify('open')).toEqual({ bunched: false, fist: false });
    expect(classify('fist')).toEqual({ bunched: false, fist: true });
    expect(classify('bunched')).toEqual({ bunched: true, fist: false });
  });
});
