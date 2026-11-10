// Run with MAKE_EXAMPLES=1 to regenerate public/examples (skipped otherwise).
import fs from 'node:fs';
import { it } from 'vitest';
import { DEFAULT_SETTINGS, History, addScaffoldStroke, addShapeStroke, serialize } from '../src/model/drawing';
import { toPaperFormat } from '../src/model/paperFormat';
import type { Vec3 } from '../src/geometry/vec';

it.skipIf(!process.env.MAKE_EXAMPLES)('writes example drawings', () => {
  const h = new History();
  const add = (r: ReturnType<typeof addScaffoldStroke>) => {
    if (r.type !== 'rejected') h.push(r.state);
  };
  // A cube-ish scaffold, 30 cm, drawn slightly roughly at standing height.
  const s = 0.3;
  const y0 = 1.0;
  const c = (x: number, y: number, z: number, j = 0): Vec3 => [x * s + j * 0.008, y0 + y * s - j * 0.006, -0.4 + z * s + j * 0.005];
  const edges: [number[], number[]][] = [
    [[0, 0, 0], [1, 0, 0]], [[1, 0, 0], [1, 0, 1]], [[1, 0, 1], [0, 0, 1]], [[0, 0, 1], [0, 0, 0]],
    [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[1, 0, 1], [1, 1, 1]], [[0, 0, 1], [0, 1, 1]],
    [[0, 1, 0], [1, 1, 0]], [[1, 1, 0], [1, 1, 1]], [[1, 1, 1], [0, 1, 1]], [[0, 1, 1], [0, 1, 0]],
  ];
  edges.forEach(([a, b], i) => add(addScaffoldStroke(h.state, c(a[0], a[1], a[2], (i % 3) - 1), c(b[0], b[1], b[2], ((i + 1) % 3) - 1), DEFAULT_SETTINGS, 1)));
  // Circles through the edge midpoints of the top and bottom faces, and a diagonal.
  for (const y of [0, 1]) {
    const raw: Vec3[] = [];
    for (let k = 0; k <= 60; k++) {
      const t = (2 * Math.PI * k) / 60 - Math.PI / 2;
      raw.push(c(0.5 + 0.5 * Math.cos(t) + 0.02 * Math.sin(5 * t), y, 0.5 + 0.5 * Math.sin(t)));
    }
    add(addShapeStroke(h.state, raw, DEFAULT_SETTINGS, 1));
  }
  const diagonal: Vec3[] = [];
  for (let k = 0; k <= 30; k++) diagonal.push(c(k / 30, k / 30 + 0.01 * Math.sin(k), 0));
  add(addShapeStroke(h.state, diagonal, DEFAULT_SETTINGS, 1));
  fs.writeFileSync('public/examples/cylinder.json', serialize(h.state, h.timeline()));
  fs.writeFileSync('public/examples/cylinder-paper.json', JSON.stringify(toPaperFormat(h.timeline(), { history: true, start: new Date(), undoCount: 0 })));
});
