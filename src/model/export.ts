/** Exports of a drawing for other tools. */

import type { DrawingState } from './drawing';
import type { Vec3 } from '../geometry/vec';

/** Wavefront OBJ with polylines ('l' elements): scaffold lines in group "scaffold", shape strokes in group "shape". */
export function toOBJ(state: DrawingState): string {
  const out: string[] = ['# ScaffoldSketch (web) drawing; units: metres'];
  let next = 1;
  const emit = (points: Vec3[]) => {
    const first = next;
    for (const p of points) out.push(`v ${p[0]} ${p[1]} ${p[2]}`);
    next += points.length;
    out.push('l ' + points.map((_, i) => first + i).join(' '));
  };
  out.push('g scaffold');
  for (const l of state.lines) emit([l.a, l.b]);
  out.push('g shape');
  for (const s of state.strokes) emit(s.points);
  return out.join('\n') + '\n';
}

export function download(name: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
