/**
 * Hands as pens. Converts webhands3d's Hand3D (camera-style axes: +y down,
 * +z forward) to three.js / WebXR axes (+y up, −z forward), and classifies two
 * hand poses with hysteresis, relative to hand size:
 *
 * - bunched: all five fingertips together (fingers extended, tips touching);
 * - fist: the four fingertips curled in to the palm.
 *
 * The pen is the index fingertip.
 */

import type { Hand3D, Handedness } from '@ygingold/webhands3d';
import type { Vec3 } from '../geometry/vec';

export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_MCP = 5;
export const INDEX_TIP = 8;
export const MIDDLE_MCP = 9;
export const MIDDLE_TIP = 12;
export const RING_MCP = 13;
export const RING_TIP = 16;
export const PINKY_MCP = 17;
export const PINKY_TIP = 20;

const FINGERTIPS = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];
const PALM = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];

export interface PenHand {
  handedness: Handedness;
  /** 21 joints in physical world coordinates (metres, +y up); empty for the mouse. */
  joints: Vec3[];
  /** All five fingertips together. */
  bunched: boolean;
  /** A fist. */
  fist: boolean;
  /** Where the pen draws: the index fingertip. */
  pen: Vec3;
  /** Centre of the palm (wrist and the four knuckles): what fist navigation tracks. */
  palm: Vec3;
}

/** Hand3D joints → three.js axes. */
export function jointsToWorld(hand: Hand3D): Vec3[] {
  const j = hand.joints;
  const out: Vec3[] = [];
  for (let i = 0; i < j.length / 3; i++) out.push([j[i * 3], -j[i * 3 + 1], -j[i * 3 + 2]]);
  return out;
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function mean(points: Vec3[]): Vec3 {
  const s: Vec3 = [0, 0, 0];
  for (const p of points) for (let i = 0; i < 3; i++) s[i] += p[i] / points.length;
  return s;
}

/** Hand size: mean of wrist–index knuckle, wrist–pinky knuckle and index–pinky knuckle distances (~8 cm). */
export function palmSize(joints: Vec3[]) {
  return (distance(joints[WRIST], joints[INDEX_MCP]) + distance(joints[WRIST], joints[PINKY_MCP]) + distance(joints[INDEX_MCP], joints[PINKY_MCP])) / 3;
}

/** Largest distance between any two fingertips, in palm sizes. Small when the five tips are bunched. */
export function fingertipSpread(joints: Vec3[]) {
  let max = 0;
  for (let i = 0; i < FINGERTIPS.length; i++)
    for (let j = i + 1; j < FINGERTIPS.length; j++) max = Math.max(max, distance(joints[FINGERTIPS[i]], joints[FINGERTIPS[j]]));
  return max / palmSize(joints);
}

/** Mean distance of the four fingertips (not the thumb) from the palm centre, in palm sizes. Small in a fist. */
export function fingertipReach(joints: Vec3[]) {
  const palm = mean(PALM.map((i) => joints[i]));
  const tips = FINGERTIPS.slice(1);
  return tips.reduce((s, i) => s + distance(joints[i], palm), 0) / tips.length / palmSize(joints);
}

export interface PoseOptions {
  /** Bunched when the fingertip spread falls below this (palm sizes)… */
  bunchClose: number;
  /** …and no longer once it rises above this. */
  bunchOpen: number;
  /** Fist when the fingertip reach falls below this (palm sizes)… */
  fistClose: number;
  /** …and no longer once it rises above this. */
  fistOpen: number;
  /** Keep a hand's last pose through tracking dropouts this long, ms. */
  graceMs: number;
}

// Typical values: open hand reach ≈ 1.7–2, fist ≈ 0.6–0.8, bunched tips reach
// ≈ 1.1–1.4 with spread ≈ 0.2–0.35; a fist's spread is ≈ 0.6–0.8.
export const DEFAULT_POSE: PoseOptions = { bunchClose: 0.4, bunchOpen: 0.55, fistClose: 0.95, fistOpen: 1.15, graceMs: 150 };

/** Turns per-frame Hand3D lists into PenHands with stable pose states. */
export class HandPoseDetector {
  private state = new Map<Handedness, { bunched: boolean; fist: boolean; lastSeen: number; last: PenHand | null }>();

  constructor(public options: PoseOptions = DEFAULT_POSE) {}

  update(hands: Hand3D[], now: number): PenHand[] {
    const o = this.options;
    const out: PenHand[] = [];
    const seen = new Set<Handedness>();
    for (const hand of hands) {
      if (seen.has(hand.handedness)) continue; // two hands labelled the same: keep the first
      seen.add(hand.handedness);
      const joints = jointsToWorld(hand);
      const s = this.state.get(hand.handedness) ?? { bunched: false, fist: false, lastSeen: now, last: null };
      const reach = fingertipReach(joints);
      const spread = fingertipSpread(joints);
      s.fist = s.fist ? reach < o.fistOpen : reach < o.fistClose;
      // A fist also brings the tips closer; bunched means tips together with the fingers extended.
      s.bunched = !s.fist && (s.bunched ? spread < o.bunchOpen : spread < o.bunchClose);
      const pen: PenHand = {
        handedness: hand.handedness,
        joints,
        bunched: s.bunched,
        fist: s.fist,
        pen: joints[INDEX_TIP],
        palm: mean(PALM.map((i) => joints[i])),
      };
      s.lastSeen = now;
      s.last = pen;
      this.state.set(hand.handedness, s);
      out.push(pen);
    }
    // Briefly lost hands keep their last pose, so a stroke isn't cut by a dropout.
    for (const [side, s] of this.state) {
      if (seen.has(side) || !s.last) continue;
      if (now - s.lastSeen < o.graceMs) out.push(s.last);
      else {
        s.bunched = s.fist = false;
        s.last = null;
      }
    }
    return out;
  }
}
