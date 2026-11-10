/**
 * three.js view: a white, paper-like room with light grid lines, the drawing
 * (under a navigation transform), the user's hands and pen cursor, and the
 * stroke being drawn. Works on a desktop canvas (orbit camera) and in WebXR
 * (the renderer's XR camera replaces it).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HAND_BONES } from '@ygingold/webhands3d';
import type { DrawingState } from '../model/drawing';
import type { Keypoint } from '../shape/autocorrect';
import type { Navigation } from '../input/gestures';
import type { PenHand } from '../input/hands';
import type { Vec3 } from '../geometry/vec';

export type Mode = 'scaffold' | 'shape';

export const COLORS = {
  background: 0xffffff,
  grid: 0xdde3ea,
  scaffold: 0x8a8f96,
  keypoint: 0x5c636b,
  shape: 0x111111,
  raw: 0xe0603a,
  scaffoldCursor: 0x3d7bd9,
  shapeCursor: 0x111111,
  highlight: 0xf2a33a,
  hand: 0x9aa6b2,
};

/** Line thickness in physical metres; the drawing scales with zoom, so radii are divided by it. */
const SCAFFOLD_RADIUS = 0.0008;
const SHAPE_RADIUS = 0.0022;
const KEYPOINT_RADIUS = 0.0028;

export type Environment = 'desktop' | 'xr';

/** Shared by every stroke; meshes are rebuilt, materials are not. */
const MATERIALS = {
  scaffold: new THREE.MeshStandardMaterial({ color: COLORS.scaffold, roughness: 0.9 }),
  shape: new THREE.MeshStandardMaterial({ color: COLORS.shape, roughness: 0.6 }),
  keypoint: new THREE.MeshStandardMaterial({ color: COLORS.keypoint }),
  raw: new THREE.LineBasicMaterial({ color: COLORS.raw, transparent: true, opacity: 0.6 }),
};

export class SketchView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Drawing coordinates; its matrix is the navigation transform. */
  readonly drawingRoot = new THREE.Group();
  /** Physical-space overlays (hands, cursor) and anything else outside the drawing. */
  readonly physicalRoot = new THREE.Group();

  /** The drawing's meshes (for export). */
  readonly drawingContent = new THREE.Group();
  private readonly rawContent = new THREE.Group();
  private readonly preview: THREE.Line;
  private readonly room = new THREE.Group();
  private readonly handLines = new Map<string, THREE.LineSegments>();
  private readonly cursor: THREE.Mesh;
  private readonly dropLine: THREE.Line;
  private readonly highlight: THREE.Mesh;
  private floorY = -0.45;
  private environment: Environment = 'desktop';
  private lastState: DrawingState | null = null;
  private lastScale = 1;
  showRaw = false;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(COLORS.background);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6de, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(0.5, 1, 0.3);
    this.scene.add(sun);

    // Desktop camera: roughly where the user's eyes are, looking toward the
    // screen (webcam at the origin), so hands appear as the user sees them.
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 50);
    this.camera.position.set(0, 0.12, -0.85);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, -0.08, -0.3);
    this.controls.enableDamping = true;
    this.controls.update();

    this.scene.add(this.room, this.drawingRoot, this.physicalRoot);
    this.drawingRoot.add(this.drawingContent, this.rawContent);
    this.buildRoom();

    this.preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.raw }));
    this.preview.frustumCulled = false;
    this.drawingRoot.add(this.preview);

    this.cursor = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial({ color: COLORS.scaffoldCursor }));
    this.cursor.visible = false;
    this.dropLine = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)),
      new THREE.LineDashedMaterial({ color: 0x9aa6b2, dashSize: 0.01, gapSize: 0.008 }),
    );
    this.dropLine.frustumCulled = false;
    this.dropLine.visible = false;
    this.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: COLORS.highlight, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.highlight.visible = false;
    this.physicalRoot.add(this.cursor, this.dropLine);
    this.drawingRoot.add(this.highlight);

    new ResizeObserver(() => this.resize(container)).observe(container);
    this.resize(container);
  }

  private resize(container: HTMLElement) {
    if (this.renderer.xr.isPresenting) return;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start(onFrame: (time: number, frame?: XRFrame) => void) {
    this.renderer.setAnimationLoop((time, frame) => {
      onFrame(time, frame);
      if (!this.renderer.xr.isPresenting) this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setEnvironment(environment: Environment) {
    this.environment = environment;
    // Desktop: webcam at the origin, hands ~0.1–0.4 m below it. XR: 'local'
    // space starts at the head, so the floor is ~1.5 m down.
    this.floorY = environment === 'xr' ? -1.5 : -0.45;
    this.buildRoom();
    this.dropLine.visible = false;
  }

  /** A box room with light grid lines on the floor and walls, like graph paper. */
  private buildRoom() {
    this.room.clear();
    const xr = this.environment === 'xr';
    const size = xr ? 6 : 1.6;
    const height = xr ? 3 : 1.2;
    const center = new THREE.Vector3(0, this.floorY, xr ? 0 : -0.3);
    const divisions = xr ? 30 : 16;
    const make = () => {
      const g = new THREE.GridHelper(size, divisions, COLORS.grid, COLORS.grid);
      (g.material as THREE.Material).transparent = true;
      (g.material as THREE.Material).opacity = 0.9;
      return g;
    };
    const floor = make();
    floor.position.copy(center);
    this.room.add(floor);
    // Back wall (beyond the drawing, as seen from the user) and side walls.
    const back = make();
    back.rotation.x = Math.PI / 2;
    back.position.set(center.x, this.floorY + height / 2, center.z + (xr ? -size / 2 : size / 2));
    back.scale.set(1, 1, height / size);
    this.room.add(back);
    for (const side of [-1, 1]) {
      const wall = make();
      wall.rotation.z = Math.PI / 2;
      wall.position.set(center.x + (side * size) / 2, this.floorY + height / 2, center.z);
      wall.scale.set(height / size, 1, 1);
      this.room.add(wall);
    }
  }

  setNavigation(nav: Navigation) {
    this.drawingRoot.position.set(...nav.position);
    this.drawingRoot.rotation.set(0, nav.angle, 0);
    this.drawingRoot.scale.setScalar(nav.scale);
    this.drawingRoot.updateMatrixWorld();
  }

  /** Rebuild the drawing's meshes (cheap for drawings of hundreds of strokes). */
  setDrawing(state: DrawingState, keypoints: Keypoint[], worldScale: number) {
    if (state === this.lastState && worldScale === this.lastScale) return;
    this.lastState = state;
    this.lastScale = worldScale;
    disposeChildren(this.drawingContent);
    disposeChildren(this.rawContent);
    const s = 1 / worldScale;

    for (const line of state.lines) this.drawingContent.add(tube([line.a, line.b], SCAFFOLD_RADIUS * s, MATERIALS.scaffold));
    for (const stroke of state.strokes) this.drawingContent.add(tube(stroke.points, SHAPE_RADIUS * s, MATERIALS.shape));

    if (keypoints.length) {
      const dots = new THREE.InstancedMesh(
        new THREE.SphereGeometry(KEYPOINT_RADIUS * s, 10, 8),
        MATERIALS.keypoint,
        keypoints.length,
      );
      const m = new THREE.Matrix4();
      keypoints.forEach((k, i) => dots.setMatrixAt(i, m.makeTranslation(...k.position)));
      dots.instanceMatrix.needsUpdate = true;
      this.drawingContent.add(dots);
    }

    for (const line of state.lines) this.rawContent.add(polyline(line.raw, MATERIALS.raw));
    for (const tick of state.ticks) this.rawContent.add(polyline(tick.raw, MATERIALS.raw));
    for (const stroke of state.strokes) this.rawContent.add(polyline(stroke.raw, MATERIALS.raw));
    this.rawContent.visible = this.showRaw;
  }

  setShowRaw(show: boolean) {
    this.showRaw = show;
    this.rawContent.visible = show;
  }

  /** The stroke being drawn (drawing coordinates), or null. */
  setPreview(points: Vec3[] | null) {
    const g = this.preview.geometry;
    if (!points || points.length < 2) {
      this.preview.visible = false;
      return;
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points.flat()), 3));
    g.computeBoundingSphere();
    this.preview.visible = true;
  }

  /** Hands (physical coordinates), the drawing hand's fingertip cursor (larger while drawing), and the keypoint it would snap to. */
  setHands(hands: PenHand[], dominant: string, mode: Mode, near: Vec3 | null, nearRadius: number, drawing: boolean) {
    const seen = new Set<string>();
    for (const hand of hands) {
      if (!hand.joints.length) continue; // the mouse pen has no hand
      seen.add(hand.handedness);
      let lines = this.handLines.get(hand.handedness);
      if (!lines) {
        lines = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_BONES.length * 6), 3)),
          new THREE.LineBasicMaterial({ color: COLORS.hand }),
        );
        lines.frustumCulled = false;
        this.physicalRoot.add(lines);
        this.handLines.set(hand.handedness, lines);
      }
      const pos = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
      HAND_BONES.forEach(([a, b], i) => {
        pos.setXYZ(i * 2, ...hand.joints[a]);
        pos.setXYZ(i * 2 + 1, ...hand.joints[b]);
      });
      pos.needsUpdate = true;
      // Darker while making a gesture pose (fist or fingertips together).
      (lines.material as THREE.LineBasicMaterial).color.set(hand.fist || hand.bunched ? 0x3d4650 : COLORS.hand);
      lines.visible = true;
    }
    for (const [side, lines] of this.handLines) if (!seen.has(side)) lines.visible = false;

    const pen = hands.find((h) => h.handedness === dominant);
    this.cursor.visible = !!pen;
    if (pen) {
      this.cursor.position.set(...pen.pen);
      this.cursor.scale.setScalar(drawing ? 0.006 : 0.0045);
      (this.cursor.material as THREE.MeshStandardMaterial).color.set(mode === 'scaffold' ? COLORS.scaffoldCursor : COLORS.shapeCursor);
      if (this.environment === 'desktop') {
        // Depth cue on a flat screen: a dashed line down to the floor grid.
        const pos = this.dropLine.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(0, ...pen.pen);
        pos.setXYZ(1, pen.pen[0], this.floorY, pen.pen[2]);
        pos.needsUpdate = true;
        this.dropLine.computeLineDistances();
        this.dropLine.visible = true;
      }
    } else this.dropLine.visible = false;

    this.highlight.visible = !!near;
    if (near) {
      this.highlight.position.set(...near);
      this.highlight.scale.setScalar(nearRadius);
    }
  }

  /** Pen position from a mouse event: on the plane through the orbit target facing the camera. */
  mouseToPhysical(event: { clientX: number; clientY: number }): Vec3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.controls.target);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, hit) ? [hit.x, hit.y, hit.z] : null;
  }
}

function tube(points: Vec3[], radius: number, material: THREE.Material): THREE.Mesh {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const vs = points.map((p) => new THREE.Vector3(...p));
  for (let i = 1; i < vs.length; i++) if (vs[i].distanceToSquared(vs[i - 1]) > 0) path.add(new THREE.LineCurve3(vs[i - 1], vs[i]));
  if (path.curves.length === 0) return new THREE.Mesh(new THREE.SphereGeometry(radius), material);
  const segments = Math.min(400, Math.max(1, path.curves.length));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, segments, radius, 6, false), material);
  // Round caps.
  for (const end of [vs[0], vs[vs.length - 1]]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), material);
    cap.position.copy(end);
    mesh.add(cap);
  }
  return mesh;
}

function polyline(points: Vec3[], material: THREE.Material) {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(points.flat()), 3));
  return new THREE.Line(g, material);
}

function disposeChildren(group: THREE.Object3D) {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Line) o.geometry.dispose();
  });
  group.clear();
}
