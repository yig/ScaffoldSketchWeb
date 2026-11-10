// Synthetic hands for tools/smoke.mjs (same shapes as test/gestures.test.ts), camera axes, metres.
/** A synthetic right hand (metres, camera axes as webhands3d reports): palm in the xy plane, fingers along −y. */
export function syntheticHand(pose, handedness = 'Right') {
  const mcps = [
    [0.035, -0.09, 0.5],
    [0.012, -0.095, 0.5],
    [-0.01, -0.09, 0.5],
    [-0.03, -0.08, 0.5],
  ];
  const wrist = [0, 0, 0.5];
  const palm = [0.0015, -0.071, 0.5];
  const j = new Array(21).fill(0).map(() => [0, 0, 0.5]);
  j[0] = wrist;
  j[1] = [0.03, -0.02, 0.5];
  j[2] = [0.05, -0.04, 0.5];
  j[3] = [0.06, -0.06, 0.5];
  const tipFor = (m) =>
    pose === 'open' ? [m[0], m[1] - 0.08, m[2]] : pose === 'fist' ? [m[0] * 0.8, palm[1] + 0.005, 0.47] : [0.005, -0.15, 0.45];
  mcps.forEach((m, f) => {
    const base = 5 + 4 * f;
    const tip = tipFor(m);
    j[base] = m;
    j[base + 1] = [m[0] + (tip[0] - m[0]) / 3, m[1] + (tip[1] - m[1]) / 3, m[2] + (tip[2] - m[2]) / 3];
    j[base + 2] = [m[0] + (2 * (tip[0] - m[0])) / 3, m[1] + (2 * (tip[1] - m[1])) / 3, m[2] + (2 * (tip[2] - m[2])) / 3];
    j[base + 3] = tip;
  });
  j[4] = pose === 'open' ? [0.07, -0.08, 0.5] : pose === 'fist' ? [0.0, -0.06, 0.465] : [0.01, -0.145, 0.45];
  // Mirror x for a left hand, and move it to the side.
  const side = handedness === 'Left' ? -1 : 1;
  const flat = j.flatMap(([x, y, z]) => [side * x + side * 0.15, y, z]);
  return { handedness, joints: Array.from(flat), confidence: 1, timestamp: 0 };
}

