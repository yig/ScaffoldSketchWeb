import { describe, expect, it } from 'vitest';
import { GestureController, toDrawing, toPhysical, type GestureEvents } from '../src/input/gestures';
import type { PenHand } from '../src/input/hands';
import type { Vec3 } from '../src/geometry/vec';

const pen = (handedness: 'Left' | 'Right', p: Vec3, pinching: boolean): PenHand => ({ handedness, joints: [], pinching, pen: p, indexTip: p });

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
  it('dominant pinch draws', () => {
    const { log, events } = recorder();
    const g = new GestureController(events);
    g.update([pen('Right', [0, 0, 0], true)], 0);
    g.update([pen('Right', [0.1, 0, 0], true)], 16);
    g.update([pen('Right', [0.1, 0, 0], false)], 32);
    expect(log).toEqual(['start', 'move', 'end']);
  });

  it('a quick pinch with the other hand toggles the mode', () => {
    const { log, events } = recorder();
    const g = new GestureController(events);
    g.update([pen('Left', [0, 0, 0], true)], 0);
    g.update([pen('Left', [0.001, 0, 0], false)], 150);
    expect(log).toContain('toggle');
    expect(g.nav.position).toEqual([0, 0, 0]);
  });

  it('other hand grab moves the drawing; both hands zoom keeping points under the hands', () => {
    const { log, events } = recorder();
    const g = new GestureController(events);
    g.update([pen('Left', [0, 0, 0], true)], 0);
    g.update([pen('Left', [0.1, 0, 0], true)], 500);
    expect(g.nav.position[0]).toBeCloseTo(0.1);
    const left0: Vec3 = [0.1, 0, 0];
    const right0: Vec3 = [0.3, 0, 0];
    const anchorLeft = toDrawing(g.nav, left0);
    const anchorRight = toDrawing(g.nav, right0);
    g.update([pen('Left', left0, true), pen('Right', right0, true)], 600);
    // Hands spread apart and turn about the vertical.
    const left1: Vec3 = [0.0, 0.05, 0.05];
    const right1: Vec3 = [0.4, 0.05, -0.1];
    g.update([pen('Left', left1, true), pen('Right', right1, true)], 700);
    expect(g.nav.scale).toBeCloseTo(Math.hypot(0.4, 0.15) / 0.2, 6);
    // Horizontal motion is exact; points stay under the hands up to the vertical offset of the midpoint.
    const l = toPhysical(g.nav, anchorLeft);
    const r = toPhysical(g.nav, anchorRight);
    expect(Math.hypot(l[0] - left1[0], l[2] - left1[2])).toBeLessThan(1e-9);
    expect(Math.hypot(r[0] - right1[0], r[2] - right1[2])).toBeLessThan(1e-9);
    expect(log).not.toContain('start');
  });
});
