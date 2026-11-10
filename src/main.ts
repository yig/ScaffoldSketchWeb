/**
 * ScaffoldSketch (web): wires input (hands from webcams or a headset via
 * webhands3d, or the mouse) through gestures to the drawing model, and the
 * model to the 3D view and the page UI.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Handedness, StatusKind } from '@ygingold/webhands3d';
import {
  DEFAULT_SETTINGS,
  EMPTY,
  History,
  addScaffoldStroke,
  addShapeStroke,
  deserialize,
  keypoints as computeKeypoints,
  scaledSettings,
  serialize,
  type AddResult,
  type DrawingState,
  type Settings,
} from './model/drawing';
import { download, timestamp, toOBJ } from './model/export';
import { GestureController, IDENTITY_NAVIGATION, MAX_SCALE, MIN_SCALE, toDrawing, type Navigation } from './input/gestures';
import { PinchDetector, type PenHand } from './input/hands';
import { WebcamSource, startXR, xrSupported } from './input/sources';
import { SketchView, type Mode } from './render/view';
import { PokeMenu } from './render/menu';
import { dist, type Vec3 } from './geometry/vec';
import type { Keypoint } from './shape/autocorrect';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------
const AUTOSAVE_KEY = 'scaffoldsketch:autosave';
const PREFS_KEY = 'scaffoldsketch:prefs';
const history = new History(loadAutosave());
const settings: Settings = { ...DEFAULT_SETTINGS };
let mode: Mode = 'scaffold';
let source: 'none' | 'webcam' | 'xr' | 'mouse' = 'none';
let pens: PenHand[] = [];
let stroke: Vec3[] | null = null;
let keypointCache: { state: DrawingState; keypoints: Keypoint[] } | null = null;

const view = new SketchView($('scene'));
const pinch = new PinchDetector();
const gestures = new GestureController({
  strokeStart(p) {
    stroke = [toDrawing(gestures.nav, p)];
  },
  strokeMove(p) {
    if (!stroke) return;
    const q = toDrawing(gestures.nav, p);
    // Skip sub-millimetre jitter (physical) to keep strokes light.
    if (dist(q, stroke[stroke.length - 1]) * gestures.nav.scale > 0.001) stroke.push(q);
  },
  strokeEnd() {
    if (stroke) finishStroke(stroke);
    stroke = null;
  },
  strokeCancel() {
    stroke = null;
  },
  navigate(nav) {
    view.setNavigation(nav);
    updateZoomLabel();
  },
  navigateEnd() {
    // Line thickness is physical: rebuild for the new zoom.
    renderDrawing();
    savePrefs();
  },
  toggleMode() {
    setMode(mode === 'scaffold' ? 'shape' : 'scaffold');
  },
});

function keypoints(): Keypoint[] {
  if (keypointCache?.state !== history.state) keypointCache = { state: history.state, keypoints: computeKeypoints(history.state) };
  return keypointCache.keypoints;
}

// ---------- drawing ----------
function finishStroke(points: Vec3[]) {
  const t0 = performance.now();
  let result: AddResult;
  if (mode === 'scaffold') {
    if (points.length < 2) return;
    result = addScaffoldStroke(history.state, points[0], points[points.length - 1], settings, gestures.nav.scale);
  } else {
    result = addShapeStroke(history.state, points, settings, gestures.nav.scale);
  }
  const ms = (performance.now() - t0).toFixed(0);
  if (result.type === 'rejected') {
    say(result.reason, 'error');
    return;
  }
  history.push(result.state);
  if (result.type === 'line') say(describeLine(result.line.constraints ?? []) + ` (${ms} ms)`, 'ok');
  else if (result.type === 'tick') say('Added a keypoint', 'ok');
  else say(describeStroke(result.stroke.kind) + ` (${ms} ms)`, 'ok');
}

function describeLine(constraints: string[]) {
  if (!settings.autocorrect) return 'Scaffold line (auto-correct off)';
  if (!constraints.length) return 'Scaffold line: no relationships found';
  const counts = new Map<string, number>();
  for (const c of constraints) counts.set(c, (counts.get(c) ?? 0) + 1);
  return 'Scaffold line: ' + [...counts].map(([k, n]) => (n > 1 ? `${n}× ${k}` : k)).join(', ');
}

function describeStroke(kind: string) {
  return {
    curve: 'Shape curve through the scaffold',
    straight: 'Straight shape line',
    freeform: 'Freeform stroke (not near enough to the scaffold keypoints)',
    raw: 'Shape stroke (auto-correct off)',
  }[kind] ?? 'Shape stroke';
}

function renderDrawing() {
  view.setDrawing(history.state, keypoints(), gestures.nav.scale);
}

history.onChange(() => {
  renderDrawing();
  updateButtons();
  scheduleAutosave();
});

// ---------- per frame ----------
const mouse = { down: false, pen: null as Vec3 | null };
const menu = new PokeMenu([
  { id: 'scaffold', label: () => 'Scaffold', active: () => mode === 'scaffold', action: () => setMode('scaffold') },
  { id: 'shape', label: () => 'Shape', active: () => mode === 'shape', action: () => setMode('shape') },
  { id: 'undo', label: () => 'Undo', action: () => history.undo() },
  { id: 'redo', label: () => 'Redo', action: () => history.redo() },
  { id: 'autocorrect', label: () => (settings.autocorrect ? 'Auto ✓' : 'Auto ✗'), action: () => setAutocorrect(!settings.autocorrect) },
  { id: 'center', label: () => 'Center', action: () => frameDrawing() },
]);
view.physicalRoot.add(menu.group);

/** Hands from webcams or the headset. */
function onHands(hands: Parameters<PinchDetector['update']>[0]) {
  const now = performance.now();
  pens = pinch.update(hands, now);
  if (source === 'xr') {
    const head = new THREE.Vector3().setFromMatrixPosition(view.renderer.xr.getCamera().matrixWorld);
    const other = pens.find((p) => p.handedness !== gestures.dominant);
    const dominant = pens.find((p) => p.handedness === gestures.dominant);
    gestures.drawingEnabled = !menu.update(other, dominant, head);
  }
  gestures.update(pens, now);
}

/** The mouse as a pen held in the dominant hand; the button is the pinch. Fed per event so no motion is lost between frames. */
function onMouse() {
  pens = mouse.pen ? [{ handedness: gestures.dominant, joints: [], pinching: mouse.down, pen: mouse.pen, indexTip: mouse.pen }] : [];
  gestures.update(pens, performance.now());
}

view.start(() => {
  const pen = pens.find((p) => p.handedness === gestures.dominant);
  let near: Vec3 | null = null;
  const th = scaledSettings(settings, gestures.nav.scale);
  const radius = mode === 'shape' ? th.shape.keypointDistance : th.scaffold.pointPoint;
  if (pen && settings.autocorrect) {
    const p = toDrawing(gestures.nav, pen.pen);
    let best = radius;
    for (const k of keypoints()) {
      const d = dist(k.position, p);
      if (d < best) {
        best = d;
        near = k.position;
      }
    }
  }
  view.setHands(pens, gestures.dominant, mode, near, radius * 0.35);
  if (stroke && mode === 'scaffold' && pen) view.setPreview([stroke[0], toDrawing(gestures.nav, pen.pen)]);
  else view.setPreview(stroke);
});

// ---------- input sources ----------
const webcam = new WebcamSource(
  $<HTMLVideoElement>('video'),
  { calibration: $('calibration'), join: $('join'), cameraSelect: $<HTMLSelectElement>('cameraSelect') },
  (text, kind) => say(text, kind),
);
webcam.onHands((hands) => {
  if (source === 'webcam') onHands(hands);
});

function setSource(next: typeof source) {
  source = next;
  pens = [];
  stroke = null;
  for (const id of ['useWebcam', 'useMouse']) $(id).classList.toggle('active', (id === 'useWebcam' && next === 'webcam') || (id === 'useMouse' && next === 'mouse'));
  $('webcamSection').hidden = next !== 'webcam';
  const mouseMode = next === 'mouse';
  // Mouse: left button draws, so orbit moves to the right button.
  view.controls.mouseButtons = {
    LEFT: mouseMode ? null : THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: mouseMode ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
  } as typeof view.controls.mouseButtons;
  $('inputHint').textContent = {
    none: '',
    webcam: 'Hold your hands up in front of the camera. Calibrate (below) so distances are right.',
    xr: 'Drawing in the headset. Put the controllers down: hands are tracked.',
    mouse: 'For trying things out: left-drag draws on a plane through the center of the view.',
  }[next];
  savePrefs();
}

$('useWebcam').addEventListener('click', async () => {
  setSource('webcam');
  try {
    await webcam.start($<HTMLSelectElement>('cameraSelect').value || undefined);
  } catch (e) {
    say(errorText(e), 'error');
  }
});
$<HTMLSelectElement>('cameraSelect').addEventListener('change', (e) => {
  webcam.start((e.target as HTMLSelectElement).value).catch((err) => say(errorText(err), 'error'));
});
$('useMouse').addEventListener('click', () => {
  setSource('mouse');
  say('Mouse input: left-drag to draw, right-drag to orbit.', 'ok');
});

async function enterXR(xrMode: 'immersive-vr' | 'immersive-ar') {
  try {
    const previous = source;
    const { session } = await startXR(view.renderer, xrMode, (hands) => {
      if (source === 'xr') onHands(hands);
    });
    setSource('xr');
    view.setEnvironment('xr');
    view.scene.background = xrMode === 'immersive-ar' ? null : new THREE.Color(0xffffff);
    if (!history.state.lines.length && !history.state.strokes.length) gestures.setNav(IDENTITY_NAVIGATION, true);
    else frameDrawing();
    session.addEventListener('end', () => {
      view.setEnvironment('desktop');
      view.scene.background = new THREE.Color(0xffffff);
      setSource(previous === 'xr' ? 'none' : previous);
      say('Left XR', 'info');
    });
    say('In XR. Pinch to draw; turn your other palm toward you for the menu.', 'ok');
  } catch (e) {
    say(`Couldn't start XR with hand tracking: ${errorText(e)}`, 'error');
  }
}
$('useXR').addEventListener('click', () => enterXR('immersive-vr'));
$('useAR').addEventListener('click', () => enterXR('immersive-ar'));
xrSupported().then(({ vr, ar }) => {
  $<HTMLButtonElement>('useXR').disabled = !vr && !ar;
  if (!vr && !ar) $('useXR').title = 'No WebXR headset available. Open this page in a headset browser (over HTTPS).';
  if (!vr && ar) $('useXR').hidden = true;
  $('useAR').hidden = !ar;
});

const canvas = view.renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (source !== 'mouse' || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  mouse.pen = view.mouseToPhysical(e);
  mouse.down = true;
  onMouse();
});
canvas.addEventListener('pointermove', (e) => {
  if (source !== 'mouse') return;
  mouse.pen = view.mouseToPhysical(e);
  onMouse();
});
canvas.addEventListener('pointerup', (e) => {
  if (source !== 'mouse' || e.button !== 0) return;
  mouse.down = false;
  onMouse();
});
canvas.addEventListener('pointerleave', () => {
  if (source !== 'mouse' || mouse.down) return;
  mouse.pen = null;
  onMouse();
});

// ---------- commands ----------
function setMode(next: Mode) {
  mode = next;
  $('modeScaffold').setAttribute('aria-pressed', String(mode === 'scaffold'));
  $('modeShape').setAttribute('aria-pressed', String(mode === 'shape'));
  say(mode === 'scaffold' ? 'Scaffold mode: draw straight construction lines.' : 'Shape mode: draw curves through scaffold keypoints.', 'info');
}

function setAutocorrect(on: boolean) {
  settings.autocorrect = on;
  $<HTMLInputElement>('autocorrect').checked = on;
  say(on ? 'Auto-correct on' : 'Auto-correct off: strokes stay as drawn', 'info');
  savePrefs();
}

/** Zoom by `factor` about a point in front of the user. */
function zoom(factor: number) {
  const nav = gestures.nav;
  const k = Math.min(MAX_SCALE / nav.scale, Math.max(MIN_SCALE / nav.scale, factor));
  const pivot = comfortablePoint();
  gestures.setNav(
    {
      ...nav,
      scale: nav.scale * k,
      position: [pivot[0] + k * (nav.position[0] - pivot[0]), pivot[1] + k * (nav.position[1] - pivot[1]), pivot[2] + k * (nav.position[2] - pivot[2])],
    },
    true,
  );
}

/** Where drawing is comfortable: the orbit target on a desktop, in front of the chest in XR. */
function comfortablePoint(): Vec3 {
  if (source === 'xr') return [0, -0.3, -0.45];
  const t = view.controls.target;
  return [t.x, t.y, t.z];
}

/** Put the drawing's center at the comfortable point, at 1×. */
function frameDrawing() {
  const s = history.state;
  const points = [...s.lines.flatMap((l) => [l.a, l.b]), ...s.strokes.flatMap((st) => st.points)];
  const target = comfortablePoint();
  if (!points.length) {
    gestures.setNav(IDENTITY_NAVIGATION, true);
    return;
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) {
    lo[i] = Math.min(lo[i], p[i]);
    hi[i] = Math.max(hi[i], p[i]);
  }
  const center = lo.map((v, i) => (v + hi[i]) / 2);
  gestures.setNav({ angle: 0, scale: 1, position: [target[0] - center[0], target[1] - center[1], target[2] - center[2]] }, true);
}

function updateButtons() {
  $<HTMLButtonElement>('undo').disabled = !history.canUndo;
  $<HTMLButtonElement>('redo').disabled = !history.canRedo;
}

function updateZoomLabel() {
  const s = gestures.nav.scale;
  $('zoomLabel').textContent = `${s >= 10 ? s.toFixed(0) : s.toFixed(s < 1 ? 2 : 1)}×`;
}

$('modeScaffold').addEventListener('click', () => setMode('scaffold'));
$('modeShape').addEventListener('click', () => setMode('shape'));
$('undo').addEventListener('click', () => history.undo());
$('redo').addEventListener('click', () => history.redo());
$('zoomIn').addEventListener('click', () => zoom(1.5));
$('zoomOut').addEventListener('click', () => zoom(1 / 1.5));
$('frame').addEventListener('click', () => frameDrawing());
$<HTMLInputElement>('autocorrect').addEventListener('change', (e) => setAutocorrect((e.target as HTMLInputElement).checked));
$<HTMLInputElement>('showRaw').addEventListener('change', (e) => {
  view.setShowRaw((e.target as HTMLInputElement).checked);
  savePrefs();
});
$<HTMLSelectElement>('dominant').addEventListener('change', (e) => {
  gestures.dominant = (e.target as HTMLSelectElement).value as Handedness;
  savePrefs();
});
$('menuButton').addEventListener('click', () => {
  const panel = $('panel');
  panel.classList.toggle('closed');
  $('menuButton').setAttribute('aria-expanded', String(!panel.classList.contains('closed')));
});

$('save').addEventListener('click', () => {
  const withHistory = $<HTMLInputElement>('saveHistory').checked;
  download(`scaffoldsketch-${timestamp()}.json`, serialize(history.state, withHistory ? history.timeline() : undefined), 'application/json');
});
$<HTMLInputElement>('open').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    history.reset(deserialize(await file.text()));
    frameDrawing();
    say(`Opened ${file.name}`, 'ok');
  } catch (err) {
    say(`Couldn't open ${file.name}: ${errorText(err)}`, 'error');
  }
  (e.target as HTMLInputElement).value = '';
});
$('exportOBJ').addEventListener('click', () => download(`scaffoldsketch-${timestamp()}.obj`, toOBJ(history.state), 'text/plain'));
$('exportGLB').addEventListener('click', () => {
  const content = view.drawingContent.clone();
  content.scale.setScalar(1);
  new GLTFExporter().parse(
    content,
    (glb) => download(`scaffoldsketch-${timestamp()}.glb`, glb as ArrayBuffer, 'model/gltf-binary'),
    (err) => say(`Export failed: ${errorText(err)}`, 'error'),
    { binary: true },
  );
});
$('clear').addEventListener('click', () => {
  if (!history.state.lines.length && !history.state.strokes.length && !history.state.ticks.length) return;
  history.push(EMPTY);
  say('Cleared (Undo brings it back)', 'info');
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, select, textarea')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) history.redo();
    else history.undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    history.redo();
  } else if (mod) return;
  else if (e.key === 'Tab') {
    e.preventDefault();
    setMode(mode === 'scaffold' ? 'shape' : 'scaffold');
  } else if (e.key === 's') setMode('scaffold');
  else if (e.key === 'd') setMode('shape');
  else if (e.key === '+' || e.key === '=') zoom(1.5);
  else if (e.key === '-' || e.key === '_') zoom(1 / 1.5);
  else if (e.key === 'f') frameDrawing();
  else if (e.key === 'a') setAutocorrect(!settings.autocorrect);
  else if (e.key === 'r') {
    const box = $<HTMLInputElement>('showRaw');
    box.checked = !box.checked;
    view.setShowRaw(box.checked);
  }
});

// ---------- status ----------
function say(text: string, kind: StatusKind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// ---------- persistence (per browser; best effort) ----------
function loadAutosave(): DrawingState {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (text) return deserialize(text);
  } catch {}
  return EMPTY;
}

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, serialize(history.state));
    } catch {}
  }, 300);
}

interface Prefs {
  dominant?: Handedness;
  autocorrect?: boolean;
  showRaw?: boolean;
  nav?: Navigation;
}
function savePrefs() {
  const prefs: Prefs = {
    dominant: gestures.dominant,
    autocorrect: settings.autocorrect,
    showRaw: view.showRaw,
    nav: gestures.nav,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
function loadPrefs() {
  let prefs: Prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Prefs;
  } catch {}
  if (prefs.dominant) {
    gestures.dominant = prefs.dominant;
    $<HTMLSelectElement>('dominant').value = prefs.dominant;
  }
  if (prefs.autocorrect === false) {
    settings.autocorrect = false;
    $<HTMLInputElement>('autocorrect').checked = false;
  }
  if (prefs.showRaw) {
    $<HTMLInputElement>('showRaw').checked = true;
    view.setShowRaw(true);
  }
  if (prefs.nav) gestures.setNav(prefs.nav, false);
}

// ---------- start ----------
loadPrefs();
setMode('scaffold');
renderDrawing();
updateButtons();
updateZoomLabel();
say(
  history.state.lines.length ? 'Restored your last drawing. Choose an input in Setup.' : 'Choose an input in Setup: webcam hands, a VR headset, or the mouse.',
  'info',
);
// For automated checks and debugging from the console.
Object.assign(window, { scaffoldsketch: { history, settings, gestures, view, setMode, finishStroke } });
