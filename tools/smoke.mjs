// Headless end-to-end check: the page loads without errors, the mouse draws
// scaffold lines and shape curves that get auto-corrected, undo works, and the
// webcam input starts with a fake camera. Needs Google Chrome and a running
// dev server (`npm run dev`). Usage: npm run smoke [-- http://localhost:5173] [screenshot.png]
import { chromium } from 'playwright-core';
import { syntheticHand } from './syntheticHand.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const shot = process.argv[3];
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const errors = [];
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
await page.goto(base + '/index.html');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(500);

await page.click('#useMouse');
await page.click('#menuButton'); // close the panel so it doesn't cover the canvas
const state = () => page.evaluate(() => {
  const s = window.scaffoldsketch.history.state;
  return { lines: s.lines, ticks: s.ticks.length, strokes: s.strokes.map((x) => x.kind) };
});
const drag = async (points) => {
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    await page.mouse.move(...p, { steps: 3 });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(50);
  await page.mouse.up();
  await page.waitForTimeout(100);
};

// A rough square: corners in screen pixels around the centre.
const c = [600, 400];
const r = 150;
const corners = [[c[0] - r, c[1] - r], [c[0] + r + 6, c[1] - r + 4], [c[0] + r - 3, c[1] + r + 5], [c[0] - r + 4, c[1] + r - 2]];
for (let i = 0; i < 4; i++) {
  const a = corners[i];
  const b = corners[(i + 1) % 4];
  await drag([[a[0] + 4, a[1] - 3], [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], [b[0] - 3, b[1] + 4]]);
}
let s = await state();
check(s.lines.length === 4, `four scaffold lines (got ${s.lines.length})`);
const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
if (s.lines.length === 4) {
  const gaps = s.lines.map((l, i) => d(l.b, s.lines[(i + 1) % 4].a));
  check(gaps.every((g) => g < 1e-5), `square corners meet (gaps ${gaps.map((g) => g.toExponential(1)).join(', ')} m)`);
  if (process.env.VERBOSE) for (const l of s.lines) console.log(JSON.stringify({ a: l.a, b: l.b, raw: l.raw, c: l.constraints }));
}

// Shape: a circle through the edge midpoints.
await page.keyboard.press('d');
const circle = [];
for (let k = 0; k <= 40; k++) {
  const t = (2 * Math.PI * k) / 40 - Math.PI / 2;
  circle.push([c[0] + r * Math.cos(t) + 3 * Math.sin(5 * t), c[1] + r * Math.sin(t)]);
}
await drag(circle);
s = await state();
check(s.strokes.length === 1 && s.strokes[0] === 'curve', `shape stroke auto-corrected to a curve (got ${JSON.stringify(s.strokes)})`);
if (shot) await page.screenshot({ path: shot });

await page.keyboard.press('Control+z');
s = await state();
check(s.strokes.length === 0, 'undo removes the stroke');
await page.keyboard.press('Control+Shift+z');
s = await state();
check(s.strokes.length === 1, 'redo restores it');

// Shift draws too (the pen follows the pointer, no button); Tab switches back to scaffold mode.
await page.keyboard.press('Tab');
const mode = await page.getAttribute('#modeScaffold', 'aria-pressed');
check(mode === 'true', 'Tab switches to scaffold mode');
await page.mouse.move(c[0] - 60, c[1] + 220);
await page.keyboard.down('Shift');
await page.mouse.move(c[0] + 60, c[1] + 225, { steps: 5 });
await page.keyboard.up('Shift');
await page.waitForTimeout(100);
s = await state();
check(s.lines.length === 5, `holding Shift draws a scaffold line (got ${s.lines.length} lines)`);

// Synthetic hands: left fingertips together draws with the right index fingertip; feedback shows it.
await page.click('#menuButton');
await page.click('#gestureDetails summary');
const linesBefore = (await state()).lines.length;
const frame = (left, right, dx = 0) =>
  page.evaluate(([l, r, dx]) => {
    r.joints = r.joints.map((v, i) => (i % 3 === 0 ? v + dx : v));
    window.scaffoldsketch.onHands([l, r]);
  }, [syntheticHand(left, 'Left'), syntheticHand(right, 'Right'), dx]);
await frame('open', 'open');
await frame('bunched', 'open');
const drawingNow = await page.evaluate(() => window.scaffoldsketch.gestures.isDrawing);
check(drawingNow, 'left fingertips together starts drawing');
const active = await page.$$eval('.meter', (ms) => ms.map((m) => m.dataset.active));
check(active[0] === 'true' && active[1] === 'false', `spread meter lights up for the left hand (${active.join(',')})`);
for (let k = 1; k <= 5; k++) await frame('bunched', 'open', 0.04 * k);
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-gestures.png') });
await frame('open', 'open', 0.2);
s = await state();
check(s.lines.length === linesBefore + 1, `releasing the left fingertips finishes the stroke (${s.lines.length - linesBefore} new)`);
await frame('fist', 'fist');
const fistActive = await page.$$eval('.meter', (ms) => ms.map((m) => m.dataset.active));
check(fistActive[1] === 'true' && fistActive[3] === 'true' && fistActive[0] === 'false', `fists detected, not fingertips together (${fistActive.join(',')})`);
await frame('open', 'open');
await page.click('#menuButton');

// Webcam with Chrome's fake camera: starts without errors (MediaPipe loads from a CDN).
await page.click('#menuButton');
await page.click('#useWebcam');
await page.waitForTimeout(6000);
const status = await page.textContent('#status');
check(!/blocked|error|fail/i.test(status), `webcam starts (status: "${status}")`);

// ?load=<url> opens a drawing (this app's format and the original's).
for (const file of ['examples/cylinder.json', 'examples/cylinder-paper.json']) {
  await page.goto(`${base}/index.html?load=${file}`);
  await page.waitForFunction((f) => /Opened|Couldn't/.test(document.getElementById('status').textContent) && document.getElementById('status').textContent.includes(f.split('/').pop()), file, { timeout: 15000 });
  const loaded = await state();
  check(loaded.lines.length === 12 && loaded.strokes.length === 3, `?load=${file} opens it (${loaded.lines.length} lines, ${loaded.strokes.length} strokes)`);
  if (shot && file.endsWith('cylinder.json')) await page.screenshot({ path: shot.replace(/\.png$/, '-load.png') });
}
const before = errors.length;
await page.goto(`${base}/index.html?load=examples/missing.json`);
await page.waitForFunction(() => /Couldn't load/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
check(true, '?load= of a missing file reports an error');
errors.splice(before); // the browser logs the expected 404

const unique = [...new Set(errors)];
check(unique.length === 0, `no page errors${unique.length ? ':\n  ' + unique.join('\n  ') : ''}`);
await browser.close();
process.exit(failures ? 1 : 0);
