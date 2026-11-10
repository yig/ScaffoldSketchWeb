# ScaffoldSketch (web) — design and architecture

Living document. Update it whenever the design, module layout, conventions,
parameters or open questions change.

## Goal

A browser implementation of ScaffoldSketch (Yu, DiVerdi, Sharma, Gingold,
UIST 2021; `scaffoldsketch.tex`): accurate 3D design drawing in two stages.
Users draw straight **scaffold** lines, which are auto-corrected against each
other, then **shape** strokes, which are auto-corrected against the scaffold.
The original ran a THREE.js/WebXR front end on an Oculus Quest with controllers
and a Python auto-correct server over a WebSocket. This version:

- runs entirely in the browser (TypeScript; auto-correct runs client-side, no server);
- uses **hands** instead of controllers, through
  [`@ygingold/webhands3d`](https://github.com/yig/webhands3d): one webcam,
  several cameras (phones join by QR code), or a WebXR headset's hand tracking;
- also accepts the mouse, for trying things out and for automated tests.

Licensing: `../code-new` (Adobe research license) was read for reference only;
no code was copied from it. The implementation follows the paper. `../code-old`
(MIT) contained only early 2D prototypes and was not needed.

## Running

```sh
npm install
npm run dev        # http://localhost:5173 — webcams work on localhost
npm run dev:lan    # HTTPS on the local network: for a headset (WebXR) or phones
npm test           # unit tests (algorithms, gestures)
npm run smoke      # headless Chrome end-to-end check; needs `npm run dev` running
npm run build      # static site in dist/ (index.html + phone.html)
```

## Module map

```
index.html               the app page: toolbar, status line, Setup panel
phone.html               phone camera page (webhands3d mountRemoteCamera)
src/
  main.ts                wiring: sources → hand poses → gestures → model → view; UI, keys, persistence
  geometry/vec.ts        Vec3 tuples, distances, resampling, PCA axis
  optimize/
    levenbergMarquardt.ts  small dense LM with forward-difference Jacobian (scaffold solves)
    bfgs.ts                BFGS with central-difference gradient + Armijo backtracking (MVC)
  scaffold/autocorrect.ts  candidate constraints + IRLS (paper §4.1)
  shape/autocorrect.ts     keypoint/tangent selection, Bézier MVC, straight detection (paper §4.2)
  model/
    drawing.ts           DrawingState (lines, ticks, strokes), keypoints, add* operations,
                         physical→drawing threshold scaling, History (undo/redo), JSON format
    export.ts            OBJ polylines, file download helpers
  input/
    hands.ts             Hand3D → world axes; HandPoseDetector (fist, fingertips together; hysteresis, dropout grace)
    gestures.ts          GestureController: draw (Shift / left fingertips) / mode toggle / two-fist move+turn+zoom;
                         Navigation (drawing ↔ physical transform)
    sources.ts           WebcamSource (MultiViewHandTracker + calibration panel + phone join);
                         startXR (WebXR session + WebXRHandTracker)
  render/
    view.ts              SketchView: three.js scene, paper-white grid room, tubes, keypoint dots,
                         hand skeletons, pen cursor, snap highlight, stroke preview, mouse picking
    menu.ts              PokeMenu: wrist menu of 3D buttons for XR, pressed by fingertip
  ui/gestureFeedback.ts  gesture HUD, live pose meters and threshold sliders
  ui/style.css
test/                    vitest: algorithms.test.ts, gestures.test.ts
tools/smoke.mjs          playwright-core + system Chrome; fake camera
```

Dependency direction: `geometry`, `optimize` ← `scaffold`, `shape` ← `model` ←
`main`. The algorithm and model layers have no DOM or three.js dependency, so
they run under vitest in Node. `input/gestures.ts` is also DOM-free.

## Coordinates and units

- **Physical space**: metres, three.js/WebXR axes (+y up, −z forward).
  - Webcams: webhands3d reports camera 0's frame (OpenCV: +y down, +z away from
    the camera); we use (x, −y, −z). The webcam is the origin; the user sits at
    about z = −0.6.
  - WebXR: the `'local'` reference space for both three.js and
    `WebXRHandTracker` (origin at the head at session start), converted the same way.
- **Drawing space**: where the drawing is stored. `Navigation`
  `{position, angle, scale}` maps drawing → physical:
  `physical = translate(position) · rotateY(angle) · scale(scale) · drawing`.
  Navigation only rotates about the vertical, so the drawing's +y stays the
  physical vertical (the paper's vertical-axis constraint stays meaningful).
- **Thresholds are physical** (paper: "based on physical measurements in user
  coordinates, so zooming can be used to adjust the results").
  `scaledSettings(settings, scale)` divides every length threshold by the zoom
  scale before auto-correct, which works in drawing units. Angles and ratios are
  scale-free. Line thickness on screen is also physical (tubes are rebuilt with
  radius / scale when a zoom ends).

## Scaffold auto-correct (`scaffold/autocorrect.ts`)

Input: the drawn segment l = (a, b) (draw start → end positions; the
"elastic line"). Context: keypoints (every line's endpoints and midpoint, and
tick marks), existing lines, directions (existing lines' + vertical), lengths.

**Candidates** (included if C < 1 at the drawn line, i.e. within threshold).
Each constraint is a residual vector r(a, b), normalised so ‖r‖² = 1 at the
threshold; C = ‖r‖².

| Kind | Residual | Threshold (paper) |
|---|---|---|
| point–point | (endpoint − p) / τ | 5 cm |
| point–line | ((k_a − k_b) × (k_a − endpoint)) / (‖k_a − k_b‖ τ) | 5 cm; endpoint must project onto the segment (± τ) |
| perpendicular | ((b − a) · d) / (L₀ sin τ) | 10° |
| parallel | ((b − a) × d) / (L₀ sin τ) | 10° |
| equal length | (‖b − a‖ / L − 1) / τ | 25% |

L₀ is the drawn length (a constant). Design decisions:

- Direction residuals use the line vector b − a, as in the paper's formulas,
  normalised by the *constant* drawn length — not the unit direction. With
  the unit direction, the residual can be shrunk by stretching the line
  (lengthening a slightly tilted line reduces its angle), and the solver did
  exactly that: lines grew by centimetres. Linear residuals make minimum-norm
  steps rotate instead.
- Parallel uses the cross product, so it needs no sign and is smooth.
- Point–point skips a keypoint that is closer to the other endpoint, so short
  lines cannot collapse with both ends on one keypoint.
- Point–line is restricted to lines the endpoint actually abuts (projection on
  the segment ± threshold), not the infinite line through a distant segment.

**IRLS.** Weights wᵢ = w⁰ᵢ / (ε + Cᵢ) evaluated at the *drawn* line for the first
solve (w⁰ = 100 for point–point, 1 otherwise, as in the paper), then
wᵢ = 1 / (ε + Cᵢ) after each solve, normalised to max 1; ε = 10⁻⁴ (C is
threshold-normalised). Each weighted least-squares problem is solved by
Levenberg–Marquardt from the previous solution. Computing the first weights
from the input (rather than uniform w⁰) breaks ties: with uniform weights, two
conflicting point–point candidates are first solved to their exact midpoint,
a symmetric fixed point IRLS never leaves. Up to 20 iterations; typically 2–6.

**Polish.** Constraints with C < 10⁻² are "satisfied"; one final unweighted
solve over just those makes them exact (accepted only if all reach C < 10⁻⁸).
The satisfied kinds are reported in the status line.

**LM details.** Marquardt damping λ·diag(JᵀJ) plus a small fixed isotropic term
(10⁻⁶ · max diag) so directions no residual sees (e.g. sliding along a
direction-only constraint) don't drift on finite-difference noise; stop when a
step improves the cost by a negligible fraction.

**Tick marks.** A scaffold stroke shorter than 3 cm (physical) is a tick: its
midpoint is projected onto the nearest scaffold segment within 5 cm and becomes
a keypoint (with that line's direction). Otherwise it is rejected with a
message.

## Shape auto-correct (`shape/autocorrect.ts`)

1. Resample the stroke every 1 cm (physical).
2. **Straight?** PCA line through the samples; straight if the max distance to
   it is < 8% of its length and its length is within 10% of the arc length. A
   straight stroke becomes the exact segment between the first and last
   selected keypoints (or the PCA segment if fewer than two).
3. **Keypoints Q.** For each sample, the nearest keypoint within 3 cm; drop
   consecutive repeats. Each entry remembers the samples that selected it.
4. **Tangents D.** Local input direction at each entry = normalised sum of the
   forward-difference tangents of its samples. If within 25° of a scaffold line
   through the keypoint (found geometrically: lines whose segment passes within
   10⁻⁵ of the keypoint — so T-junctions and ticks count), use that line's
   direction (oriented like the input). A closed stroke (first entry = last)
   uses one tangent from both ends' samples.
5. **MVC.** Cubic Bézier per consecutive pair with c₁ = qᵢ + x d_i,
   c₂ = qᵢ₊₁ − x' dᵢ₊₁. Unknowns: the 2(m−1) magnitudes, optimised as
   log(x / chord) (positivity; penalty outside [2%, 150%] of the chord),
   initialised at chord/3. Objective: discrete ∫(dκ/ds)² ds =
   Σ (κᵢ₊₁ − κᵢ)² / Δsᵢ with Menger curvature κ on ~120 samples (fixed parameter
   values per segment, proportional to chord), multiplied by length³ to be
   scale-free; wraps around for closed strokes. BFGS (central differences).
   The paper's Σ(cᵢ − cᵢ₊₁)² is the same up to the 1/Δs weighting, which makes it
   independent of the sampling density.
6. Fewer than two keypoints and not straight: a **freeform** stroke (lightly
   smoothed). The paper had no such case; it addresses participants' wish for
   detail strokes away from the scaffold.

## Drawing model (`model/drawing.ts`)

`DrawingState = { lines, ticks, strokes }`, each item with an integer id and its
raw input. States are immutable; `History` keeps past/future snapshots for
undo/redo (paper: undo/redo buttons) and the timeline for "export drawing
history". Auto-correct can be turned off (the paper's user-study baseline and a
limitation it mentions); strokes are then stored raw (`kind: 'raw'`).

Saved format (`.json`): `{ format: 'scaffoldsketch-web', version: 1, state, history? }`.
The current drawing is autosaved to `localStorage` (paper: "our system
auto-saves"); preferences (drawing hand, toggles, navigation) too. Exports:
OBJ polylines (groups `scaffold`, `shape`), GLB of the rendered tubes.

## Input

**Hand poses** (`input/hands.ts`). The pen is the drawing hand's **index
fingertip**. Two poses are classified per hand, in units of palm size (mean of
wrist–index knuckle, wrist–pinky knuckle, index–pinky knuckle, ≈ 8 cm), with
hysteresis:

- *fist*: finger extension = mean |fingertip − wrist| / mean |knuckle − wrist|
  over the four fingers below 1.1; released above 1.3. Straight fingers ≈ 1.7–2,
  *also when the fingertips are bunched* (the fingers stay extended); a fist
  curls the tips back toward the wrist, < 1.
- *fingertips together* ("bunched"): fingertip spread = largest distance
  between any two of the five fingertips, in palm sizes, below 0.5; released
  above 0.6; and not a fist (a fist also brings the tips fairly close, ≈ 0.6–0.8).

The first fist measure (fingertips' distance from the palm centre, in palm
sizes) also fell when the fingertips bunched in front of the palm, so
"fingertips together" was read as a fist and could never trigger drawing.
Extension relative to the wrist separates the two poses.

**Feedback** (`ui/gestureFeedback.ts`): an on-screen readout per hand (not
tracked / open or pointing / fingertips together → draw or switch mode / fist)
plus "Drawing" or "Moving the drawing"; hand skeletons turn green for
fingertips together and orange for a fist (the feedback in a headset). Setup →
*Gesture thresholds* (a disclosure) shows live meters of spread and extension
per hand, with the trigger zone and hysteresis band, and sliders for the four
thresholds (release kept ≥ trigger), saved with the preferences
(`poseVersion` discards thresholds saved for an older measure).

A hand lost for < 150 ms keeps its last pose, so tracking dropouts don't cut strokes.

**Gestures** (`input/gestures.ts`), replacing the paper's controller buttons
(roles for the default right drawing hand; Setup can swap them):

| Input | Action |
|---|---|
| right index fingertip | the pen (cursor) |
| hold Shift, or left five fingertips together | draw: scaffold = elastic line from start to end; shape = the path |
| Tab, or right five fingertips together (on forming the pose) | toggle scaffold ↔ shape (not while drawing) |
| both hands fists, moving | move (midpoint), turn about vertical (bearing between fists), zoom (distance between fists), tracking the palm centres |
| XR: open left palm toward the face | wrist menu: Scaffold, Shape, Undo, Redo, Auto-correct, Center |

Drawing with the left hand as the trigger keeps the right fingertip still at
stroke start and end (unlike a pinch, which moves the fingertips). A stroke
can't start while the right hand is bunched. Both-fist navigation keeps the
drawing points under the fists under them (exactly horizontally; the vertical
follows the midpoint); making fists while drawing cancels the stroke. The
wrist menu is hidden while the left hand is bunched or a fist, so it can't
block drawing.

Desktop alternatives: toolbar buttons and keys (Shift draw, Tab/S/D mode,
Ctrl/⌘-Z undo, Ctrl/⌘-Shift-Z or Ctrl-Y redo, +/− zoom, F center, A
auto-correct, R raw). Shift is read on key down/up (and reset on window blur)
and combined with the hands on every hand frame.

**Sources** (`input/sources.ts`):

- *Webcam*: a webhands3d `MultiViewHandTracker` with the local camera as
  camera 0 (a `MonocularHandTracker`), the library's `createCalibrationPanel`
  (lens, hand size, bone lengths; camera positions when there are several
  cameras), and `createRemoteCameraJoin` so phones can join (`phone.html`).
  One camera gives usable but noisy depth; a second camera triangulates.
- *WebXR*: `immersive-vr` (white room, as in the paper) or `immersive-ar`
  (passthrough) with `hand-tracking` required; `WebXRHandTracker` shares
  three.js's session and reference space.
- *Mouse*: the pointer is the fingertip; the left button (or Shift) draws. The
  pen lies on the plane through the orbit target facing the camera. Mouse events drive the gestures directly (not per
  frame) so the stroke start isn't sampled late.

## View (`render/view.ts`)

White background with light grid lines on a floor and three walls ("white like
paper with light grid lines visible on the walls"). Scaffold lines: thin gray
tubes (0.8 mm physical radius). Shape strokes: thick black tubes (2.2 mm).
Keypoints: small dark dots. Raw input (toggle): thin orange polylines.
Cursor: sphere at the fingertip, blue in scaffold mode, black in shape mode,
larger while drawing. Hand skeletons darken while making a fist or bunching. The keypoint the pen would snap to is highlighted.

Desktop: the default camera sits where the user's eyes are (behind the hands,
looking toward the webcam/screen), so hand motion maps naturally; OrbitControls
to inspect depth; a dashed drop line from the cursor to the floor as a depth cue.

## Testing

- `test/algorithms.test.ts`: optimisers; scaffold (unconstrained, vertical
  snap, closing a square with perpendicular/equal sides, conflicting
  point–point, point–line, zoom-scaled thresholds, ticks); shape (Menger
  curvature, circle through midpoints within 2%, straight diagonal, freeform,
  MVC not worse than initialisation); history and serialization.
- `test/gestures.test.ts`: navigation inverse; drawing with Shift and with the
  left fingertips; mode toggle (once per gesture, not while drawing); two-fist
  move/turn/zoom; fists cancel a stroke; pose classification on synthetic
  open, fist and bunched hands.
- `tools/smoke.mjs` (+ `tools/syntheticHand.mjs`): real page in headless Chrome:
  synthetic hands injected through `scaffoldsketch.onHands` draw with the left
  fingertips together and light the right meters, fists are not read as
  fingertips together; mouse-drawn square closes,
  circle becomes a curve, undo/redo, webcam starts with a fake camera, no
  page errors.

Not automatically tested: real hand tracking quality, WebXR (needs a headset).

## Open questions / future work

- **Webcam depth.** Monocular depth is the weakest axis; drawing in depth
  with one webcam is hard. Calibration helps; a phone as a second camera helps
  more. Possible: show a live side view, or constrain depth with scaffold
  context (e.g. snap stroke depth to the plane of nearby scaffold).
- **Pose thresholds** were set from typical hand proportions and synthetic
  hands; tune them with the live meters. Webcam tracking of curled fingers in a
  fist is less reliable than of extended ones.
- **Threshold personalisation** (paper's future work) — thresholds are in
  `Settings`, not yet exposed in the UI.
- **Constraint visualisation** — the satisfied constraint kinds are listed in
  the status line; could be drawn in 3D.
- The paper's IRLS initial-weight description is ambiguous; see *IRLS* above for
  the choice made.
- Performance: auto-correct runs on the main thread (≈10 ms per stroke for
  small drawings). A Web Worker would keep frames smooth for large drawings.
