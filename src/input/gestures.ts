/**
 * Gestures, independent of where the hands come from (webcams, headset, mouse):
 *
 * - dominant hand pinch: draw (a scaffold line or a shape stroke, by mode);
 * - other hand pinch and move: grab the drawing (translate);
 * - both hands pinched: zoom, turn about the vertical and translate the
 *   drawing (the paper's zoom: thresholds are physical, so zooming in makes
 *   auto-correct finer);
 * - other hand quick tap (short pinch, little motion): toggle scaffold/shape.
 *
 * Positions are physical (metres, +y up). The navigation transform maps
 * drawing coordinates to physical ones: physical = T · drawing, with
 * T = translate(position) · rotateY(angle) · scale(scale).
 */

import type { Handedness } from '@ygingold/webhands3d';
import type { Vec3 } from '../geometry/vec';
import type { PenHand } from './hands';

export interface Navigation {
  position: Vec3;
  /** Rotation about the vertical axis, radians. */
  angle: number;
  scale: number;
}

export const IDENTITY_NAVIGATION: Navigation = { position: [0, 0, 0], angle: 0, scale: 1 };

export function toPhysical(nav: Navigation, p: Vec3): Vec3 {
  const c = Math.cos(nav.angle);
  const s = Math.sin(nav.angle);
  const x = p[0] * nav.scale;
  const y = p[1] * nav.scale;
  const z = p[2] * nav.scale;
  return [c * x + s * z + nav.position[0], y + nav.position[1], -s * x + c * z + nav.position[2]];
}

export function toDrawing(nav: Navigation, p: Vec3): Vec3 {
  const x = p[0] - nav.position[0];
  const y = p[1] - nav.position[1];
  const z = p[2] - nav.position[2];
  const c = Math.cos(nav.angle);
  const s = Math.sin(nav.angle);
  return [(c * x - s * z) / nav.scale, y / nav.scale, (s * x + c * z) / nav.scale];
}

export interface GestureEvents {
  strokeStart(physical: Vec3): void;
  strokeMove(physical: Vec3): void;
  strokeEnd(): void;
  /** A stroke interrupted by navigation; discard it. */
  strokeCancel(): void;
  navigate(nav: Navigation): void;
  navigateEnd(nav: Navigation): void;
  toggleMode(): void;
}

const TAP_MS = 350;
const TAP_MOTION = 0.02;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 50;

export class GestureController {
  dominant: Handedness = 'Right';
  nav: Navigation = IDENTITY_NAVIGATION;
  /** Set false to stop gestures from drawing (e.g. while poking a menu). */
  drawingEnabled = true;

  private drawing = false;
  private grab: { start: Navigation; other: Vec3; dominant?: Vec3 } | null = null;
  private tap: { start: number; at: Vec3; spoiled: boolean } | null = null;
  private wasPinching = new Map<Handedness, boolean>();

  constructor(private readonly events: GestureEvents) {}

  update(hands: PenHand[], now: number) {
    const dom = hands.find((h) => h.handedness === this.dominant);
    const other = hands.find((h) => h.handedness !== this.dominant);
    const domPinch = !!dom?.pinching;
    const otherPinch = !!other?.pinching;
    const domStarted = domPinch && !this.wasPinching.get(this.dominant);
    const otherSide: Handedness = this.dominant === 'Right' ? 'Left' : 'Right';
    const otherStarted = otherPinch && !this.wasPinching.get(otherSide);
    this.wasPinching.set(this.dominant, domPinch);
    this.wasPinching.set(otherSide, otherPinch);

    // ---- other hand: taps and grabs ----
    if (otherStarted && other) {
      this.tap = { start: now, at: other.pen, spoiled: domPinch };
      this.grab = { start: this.nav, other: other.pen };
    }
    if (otherPinch && other && this.tap && dist(other.pen, this.tap.at) > TAP_MOTION) this.tap.spoiled = true;
    if (!otherPinch && this.tap) {
      if (!this.tap.spoiled && now - this.tap.start < TAP_MS) {
        // Undo any tiny grab motion and toggle.
        if (this.grab) this.setNav(this.grab.start, true);
        this.events.toggleMode();
      }
      this.tap = null;
    }
    if (!otherPinch && this.grab) {
      this.grab = null;
      this.events.navigateEnd(this.nav);
    }

    // ---- dominant hand: draw, unless the other hand is navigating ----
    if (this.grab && domPinch && dom) {
      if (this.drawing) {
        this.drawing = false;
        this.events.strokeCancel();
      }
      if (this.tap) this.tap.spoiled = true;
      // Two-hand navigation; (re)anchor when the dominant hand joins.
      if (domStarted || !this.grab.dominant) this.grab = { start: this.nav, other: other!.pen, dominant: dom.pen };
      this.setNav(twoHand(this.grab.start, this.grab.other, this.grab.dominant!, other!.pen, dom.pen), false);
      return;
    }
    if (this.grab && other) {
      if (this.grab.dominant) this.grab = { start: this.nav, other: other.pen }; // dominant released: back to one hand
      if (!this.drawing) {
        const d = sub(other.pen, this.grab.other);
        const s = this.grab.start;
        this.setNav({ ...s, position: [s.position[0] + d[0], s.position[1] + d[1], s.position[2] + d[2]] }, false);
      }
    }

    if (domStarted && dom && !this.grab && this.drawingEnabled) {
      this.drawing = true;
      this.events.strokeStart(dom.pen);
    } else if (this.drawing && domPinch && dom) {
      this.events.strokeMove(dom.pen);
    } else if (this.drawing && !domPinch) {
      this.drawing = false;
      this.events.strokeEnd();
    }
  }

  setNav(nav: Navigation, end: boolean) {
    this.nav = nav;
    this.events.navigate(nav);
    if (end) this.events.navigateEnd(nav);
  }
}

/**
 * Two-hand navigation: the drawing point under each hand at the start stays
 * under that hand (as far as a similarity about the vertical allows):
 * scale by the change in hand distance, turn by the change in the hands'
 * horizontal bearing, and move the midpoint with the hands.
 */
function twoHand(start: Navigation, a0: Vec3, b0: Vec3, a1: Vec3, b1: Vec3): Navigation {
  const d0 = sub(b0, a0);
  const d1 = sub(b1, a1);
  const k = Math.min(MAX_SCALE / start.scale, Math.max(MIN_SCALE / start.scale, Math.hypot(...d1) / Math.max(Math.hypot(...d0), 1e-6)));
  const turn = Math.atan2(-d1[2], d1[0]) - Math.atan2(-d0[2], d0[0]);
  const m0: Vec3 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2, (a0[2] + b0[2]) / 2];
  const m1: Vec3 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2, (a1[2] + b1[2]) / 2];
  // The drawing point at m0 must end at m1.
  const anchor = toDrawing(start, m0);
  const nav: Navigation = { position: [0, 0, 0], angle: start.angle + turn, scale: start.scale * k };
  const moved = toPhysical(nav, anchor);
  nav.position = [m1[0] - moved[0], m1[1] - moved[1], m1[2] - moved[2]];
  return nav;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: Vec3, b: Vec3) => Math.hypot(...sub(a, b));
