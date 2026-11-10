/**
 * Hands as pens. Converts webhands3d's Hand3D (camera-style axes: +y down,
 * +z forward) to three.js / WebXR axes (+y up, −z forward), and detects
 * pinches (thumb tip to index tip) with hysteresis relative to hand size.
 */

import type { Hand3D, Handedness } from '@ygingold/webhands3d';
import type { Vec3 } from '../geometry/vec';

export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_MCP = 5;
export const INDEX_TIP = 8;
export const PINKY_MCP = 17;

export interface PenHand {
  handedness: Handedness;
  /** 21 joints in physical world coordinates (metres, +y up). */
  joints: Vec3[];
  pinching: boolean;
  /** Midpoint of thumb tip and index tip: where the pen draws. */
  pen: Vec3;
  indexTip: Vec3;
}

/** Hand3D joints → three.js axes. */
export function jointsToWorld(hand: Hand3D): Vec3[] {
  const j = hand.joints;
  const out: Vec3[] = [];
  for (let i = 0; i < j.length / 3; i++) out.push([j[i * 3], -j[i * 3 + 1], -j[i * 3 + 2]]);
  return out;
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface PinchOptions {
  /** Pinch starts when thumb–index distance < this × palm size. */
  closeRatio: number;
  /** Pinch ends when thumb–index distance > this × palm size. */
  openRatio: number;
  /** Keep a pinch through tracking dropouts this long, ms. */
  graceMs: number;
}

export const DEFAULT_PINCH: PinchOptions = { closeRatio: 0.3, openRatio: 0.45, graceMs: 150 };

/** Turns per-frame Hand3D lists into PenHands with stable pinch state. */
export class PinchDetector {
  private state = new Map<Handedness, { pinching: boolean; lastSeen: number; last: PenHand | null }>();

  constructor(public options: PinchOptions = DEFAULT_PINCH) {}

  update(hands: Hand3D[], now: number): PenHand[] {
    const out: PenHand[] = [];
    const seen = new Set<Handedness>();
    for (const hand of hands) {
      if (seen.has(hand.handedness)) continue; // two hands labelled the same: keep the first
      seen.add(hand.handedness);
      const joints = jointsToWorld(hand);
      const palm = (distance(joints[WRIST], joints[INDEX_MCP]) + distance(joints[WRIST], joints[PINKY_MCP]) + distance(joints[INDEX_MCP], joints[PINKY_MCP])) / 3;
      const gap = distance(joints[THUMB_TIP], joints[INDEX_TIP]);
      const s = this.state.get(hand.handedness) ?? { pinching: false, lastSeen: now, last: null };
      if (s.pinching) s.pinching = gap < this.options.openRatio * palm;
      else s.pinching = gap < this.options.closeRatio * palm;
      const t = joints[THUMB_TIP];
      const i = joints[INDEX_TIP];
      const pen: PenHand = {
        handedness: hand.handedness,
        joints,
        pinching: s.pinching,
        pen: [(t[0] + i[0]) / 2, (t[1] + i[1]) / 2, (t[2] + i[2]) / 2],
        indexTip: i,
      };
      s.lastSeen = now;
      s.last = pen;
      this.state.set(hand.handedness, s);
      out.push(pen);
    }
    // Briefly lost hands keep their last pose (and pinch) so a stroke isn't cut by a dropout.
    for (const [side, s] of this.state) {
      if (seen.has(side) || !s.last) continue;
      if (now - s.lastSeen < this.options.graceMs) out.push(s.last);
      else {
        s.pinching = false;
        s.last = null;
      }
    }
    return out;
  }
}
