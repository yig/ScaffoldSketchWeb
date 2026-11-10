/**
 * Gestures, independent of where the hands come from (webcams, headset, mouse):
 *
 * - the drawing hand's index fingertip is the pen (right hand by default);
 * - it draws (a scaffold line or a shape stroke, by mode) while Shift is held
 *   or while the other hand's five fingertips are together;
 * - bringing the drawing hand's five fingertips together toggles
 *   scaffold/shape (as does Tab, handled by the page);
 * - both hands in fists: move, turn about the vertical, and zoom the drawing
 *   by tracking the fists (the paper's zoom: thresholds are physical, so
 *   zooming in makes auto-correct finer).
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

/** Inputs that aren't hands. */
export interface Triggers {
  /** Shift key (or mouse button): draw. */
  draw: boolean;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 50;

export class GestureController {
  dominant: Handedness = 'Right';
  nav: Navigation = IDENTITY_NAVIGATION;
  /** Set false to stop gestures from starting strokes (e.g. while poking a menu). */
  drawingEnabled = true;

  private drawing = false;
  private fists: { start: Navigation; other: Vec3; dominant: Vec3 } | null = null;
  private wasBunched = false;

  constructor(private readonly events: GestureEvents) {}

  get isDrawing() {
    return this.drawing;
  }

  get isNavigating() {
    return this.fists !== null;
  }

  update(hands: PenHand[], triggers: Triggers) {
    const dom = hands.find((h) => h.handedness === this.dominant);
    const other = hands.find((h) => h.handedness !== this.dominant);

    // ---- both fists: navigate ----
    if (dom?.fist && other?.fist) {
      if (this.drawing) {
        this.drawing = false;
        this.events.strokeCancel();
      }
      if (!this.fists) this.fists = { start: this.nav, other: other.palm, dominant: dom.palm };
      this.setNav(twoHand(this.fists.start, this.fists.other, this.fists.dominant, other.palm, dom.palm), false);
      this.wasBunched = false;
      return;
    }
    if (this.fists) {
      this.fists = null;
      this.events.navigateEnd(this.nav);
    }

    // ---- drawing hand's fingertips together: toggle the mode ----
    const bunched = !!dom?.bunched;
    if (bunched && !this.wasBunched && !this.drawing) this.events.toggleMode();
    this.wasBunched = bunched;

    // ---- draw with the drawing hand's index fingertip ----
    const trigger = triggers.draw || !!other?.bunched;
    if (!this.drawing && trigger && dom && !bunched && this.drawingEnabled) {
      this.drawing = true;
      this.events.strokeStart(dom.pen);
    } else if (this.drawing && trigger && dom) {
      this.events.strokeMove(dom.pen);
    } else if (this.drawing && (!trigger || !dom)) {
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
 * Two-hand navigation: the drawing point under each fist at the start stays
 * under that fist (as far as a similarity about the vertical allows):
 * scale by the change in distance between the fists, turn by the change in
 * their horizontal bearing, and move the midpoint with them.
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
