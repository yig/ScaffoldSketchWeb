/**
 * A small panel of 3D buttons for use in a headset, pressed by poking with the
 * dominant index fingertip. It floats beside the non-dominant hand when that
 * palm faces the user (a "wrist menu"), and is hidden otherwise, so it never
 * gets in the way of drawing.
 */

import * as THREE from 'three';
import type { Vec3 } from '../geometry/vec';
import { INDEX_MCP, PINKY_MCP, WRIST, type PenHand } from '../input/hands';

export interface MenuButton {
  id: string;
  label: () => string;
  /** Highlighted (e.g. the current mode). */
  active?: () => boolean;
  action: () => void;
}

const BUTTON_W = 0.07;
const BUTTON_H = 0.03;
const GAP = 0.006;
/** The fingertip presses when within this distance in front of (or behind) the button's face. */
const PRESS_DEPTH = 0.012;
/** …and must withdraw this far before the button can be pressed again. */
const RELEASE_DEPTH = 0.03;

export class PokeMenu {
  readonly group = new THREE.Group();
  private readonly meshes: { button: MenuButton; mesh: THREE.Mesh; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; drawn: string }[] = [];
  private armed = true;
  /** Whether the menu is showing (and so whether the dominant hand is poking rather than drawing). */
  visible = false;

  constructor(buttons: MenuButton[]) {
    const columns = 2;
    buttons.forEach((button, i) => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 110;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BUTTON_W, BUTTON_H), new THREE.MeshBasicMaterial({ map: texture }));
      const row = Math.floor(i / columns);
      const col = i % columns;
      mesh.position.set(col * (BUTTON_W + GAP), -row * (BUTTON_H + GAP), 0);
      this.group.add(mesh);
      this.meshes.push({ button, mesh, canvas, texture, drawn: '' });
    });
    this.group.visible = false;
    this.refresh();
  }

  /** Redraw labels that changed. */
  refresh(hover?: string) {
    for (const m of this.meshes) {
      const label = m.button.label();
      const active = m.button.active?.() ?? false;
      const key = `${label}|${active}|${hover === m.button.id}`;
      if (key === m.drawn) continue;
      m.drawn = key;
      const ctx = m.canvas.getContext('2d')!;
      ctx.fillStyle = active ? '#2f6fd0' : hover === m.button.id ? '#e8eef6' : '#f6f7f9';
      ctx.fillRect(0, 0, m.canvas.width, m.canvas.height);
      ctx.strokeStyle = '#9aa6b2';
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, m.canvas.width - 6, m.canvas.height - 6);
      ctx.fillStyle = active ? '#ffffff' : '#1d232a';
      ctx.font = '600 40px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, m.canvas.width / 2, m.canvas.height / 2);
      m.texture.needsUpdate = true;
    }
  }

  /**
   * Place the menu by the other hand when its palm faces the head, and press
   * buttons the dominant index fingertip pokes. Returns true while the menu is
   * shown (so the caller can suspend drawing).
   */
  update(other: PenHand | undefined, dominant: PenHand | undefined, head: THREE.Vector3): boolean {
    // Not while that hand is making a gesture (fingertips together draws; fists navigate).
    this.visible = !!other && !other.bunched && !other.fist && palmFacing(other, head);
    this.group.visible = this.visible;
    if (!this.visible || !other) return false;

    // Beside the hand, above the wrist, facing the head.
    const wrist = new THREE.Vector3(...other.joints[WRIST]);
    const index = new THREE.Vector3(...other.joints[INDEX_MCP]);
    const pinky = new THREE.Vector3(...other.joints[PINKY_MCP]);
    const across = index.clone().sub(pinky).normalize();
    const anchor = wrist.clone().add(index).multiplyScalar(0.5).addScaledVector(across, 0.06).add(new THREE.Vector3(0, 0.06, 0));
    this.group.position.copy(anchor);
    this.group.lookAt(head);
    this.group.updateMatrixWorld();

    let hover: string | undefined;
    if (dominant) {
      const tip = new THREE.Vector3(...dominant.pen);
      let closest = Infinity;
      for (const m of this.meshes) {
        const local = m.mesh.worldToLocal(tip.clone());
        const inside = Math.abs(local.x) < BUTTON_W / 2 && Math.abs(local.y) < BUTTON_H / 2;
        if (inside && Math.abs(local.z) < RELEASE_DEPTH) hover = m.button.id;
        if (inside) closest = Math.min(closest, Math.abs(local.z));
        if (inside && Math.abs(local.z) < PRESS_DEPTH && this.armed) {
          this.armed = false;
          m.button.action();
        }
      }
      if (closest > RELEASE_DEPTH) this.armed = true;
    }
    this.refresh(hover);
    return true;
  }
}

/** The palm's normal points toward the head (palm turned up/toward the face). */
function palmFacing(hand: PenHand, head: THREE.Vector3): boolean {
  const w = hand.joints[WRIST];
  const i = hand.joints[INDEX_MCP];
  const p = hand.joints[PINKY_MCP];
  const a: Vec3 = [i[0] - w[0], i[1] - w[1], i[2] - w[2]];
  const b: Vec3 = [p[0] - w[0], p[1] - w[1], p[2] - w[2]];
  // Palm normal (out of the palm) for a right hand is a × b; mirrored for the left.
  const n = new THREE.Vector3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]).normalize();
  if (hand.handedness === 'Left') n.negate();
  const toHead = head.clone().sub(new THREE.Vector3(...w)).normalize();
  return n.dot(toHead) > 0.6;
}
