# ScaffoldSketch (web)

Accurate 3D design drawing in the browser, after
[ScaffoldSketch: Accurate Industrial Design Drawing in VR](https://doi.org/10.1145/3472749.3474756)
(UIST 2021). Draw straight **scaffold** lines, which auto-correct to meet,
align, and match lengths; then draw **shape** curves, which auto-correct into
smooth curves through the scaffold's keypoints.

Draw with your hands, tracked by
[webhands3d](https://github.com/yig/webhands3d): a webcam (plus phones as extra
cameras) or a WebXR headset with hand tracking (e.g. Meta Quest). A mouse works
too.

## Run

```sh
npm install
npm run dev          # http://localhost:5173
npm run dev:lan      # HTTPS on your network, for a headset or phones
```

Open Setup and pick **Webcam hands**, **Enter VR**, or **Mouse**.

- Your **right index fingertip** is the pen. It draws while you hold **Shift**
  or bring the **left hand's five fingertips together**.
- **Tab**, or the **right hand's five fingertips together**: switch Scaffold ↔ Shape.
- **Both hands in fists**: move them to move, turn and zoom the drawing.
- A **very short** scaffold stroke across a line adds a keypoint.
- In VR, turn your open left palm toward you for a menu.

(The drawing hand can be switched to the left in Setup; the roles swap.)

With a webcam, calibrate in the Setup panel for accurate distances.

## Develop

```sh
npm test             # unit tests
npm run smoke        # headless Chrome end-to-end (with `npm run dev` running)
npm run typecheck
npm run build        # static site in dist/
```

Design and architecture: [docs/DESIGN.md](docs/DESIGN.md).
