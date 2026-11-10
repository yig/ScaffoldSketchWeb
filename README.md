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

- **Pinch** with your drawing hand to draw.
- **Quick pinch** with the other hand: switch Scaffold ↔ Shape.
- **Pinch and move** the other hand to move the drawing; pinch with **both** to zoom and turn.
- A **very short** scaffold stroke across a line adds a keypoint.
- In VR, turn your other palm toward you for a menu.

With a webcam, calibrate in the Setup panel for accurate distances.

## Develop

```sh
npm test             # unit tests
npm run smoke        # headless Chrome end-to-end (with `npm run dev` running)
npm run typecheck
npm run build        # static site in dist/
```

Design and architecture: [docs/DESIGN.md](docs/DESIGN.md).
