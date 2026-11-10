/**
 * Gesture feedback: a small on-screen readout of what each hand is doing, and
 * (in the Setup panel) live meters of the two measurements behind the poses
 * with sliders for their thresholds.
 */

import type { Handedness } from '@ygingold/webhands3d';
import { DEFAULT_POSE, type PenHand, type PoseOptions } from '../input/hands';

interface Meter {
  root: HTMLElement;
  marker: HTMLElement;
  zone: HTMLElement;
  band: HTMLElement;
  value: HTMLElement;
}

/** Slider and meter ranges. */
const RANGES = {
  spread: { min: 0, max: 1.6 },
  extension: { min: 0.4, max: 2.2 },
};

const SLIDERS: { key: keyof PoseOptions; label: string; range: keyof typeof RANGES }[] = [
  { key: 'bunchClose', label: 'Fingertips together below', range: 'spread' },
  { key: 'bunchOpen', label: '…released above', range: 'spread' },
  { key: 'fistClose', label: 'Fist below', range: 'extension' },
  { key: 'fistOpen', label: '…released above', range: 'extension' },
];

export class GestureFeedback {
  private readonly meters = new Map<string, Meter>();
  private readonly hudHands = new Map<Handedness, HTMLElement>();
  private readonly hudState: HTMLElement;
  private readonly inputs = new Map<keyof PoseOptions, { input: HTMLInputElement; out: HTMLElement }>();

  constructor(
    private readonly hud: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly options: PoseOptions,
    private readonly onChange: () => void,
  ) {
    for (const side of ['Left', 'Right'] as Handedness[]) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      this.hud.append(chip);
      this.hudHands.set(side, chip);
    }
    this.hudState = document.createElement('span');
    this.hudState.className = 'chip state';
    this.hud.append(this.hudState);
    this.buildPanel();
  }

  private buildPanel() {
    const meters = document.createElement('div');
    meters.className = 'meters';
    for (const side of ['Left', 'Right'] as Handedness[]) {
      const h = document.createElement('div');
      h.className = 'meterHand';
      h.textContent = `${side} hand`;
      meters.append(h);
      for (const kind of ['spread', 'extension'] as const) {
        const root = document.createElement('div');
        root.className = 'meter';
        root.title =
          kind === 'spread'
            ? 'Largest distance between two fingertips, in palm widths. Low = fingertips together.'
            : 'How far the fingertips reach from the wrist compared to the knuckles. Low = fist.';
        const label = document.createElement('span');
        label.className = 'meterLabel';
        label.textContent = kind === 'spread' ? 'Fingertip spread' : 'Finger extension';
        const track = document.createElement('span');
        track.className = 'track';
        const zone = document.createElement('span');
        zone.className = 'zone';
        const band = document.createElement('span');
        band.className = 'band';
        const marker = document.createElement('span');
        marker.className = 'marker';
        track.append(zone, band, marker);
        const value = document.createElement('span');
        value.className = 'meterValue';
        root.append(label, track, value);
        meters.append(root);
        this.meters.set(`${side}:${kind}`, { root, marker, zone, band, value });
      }
    }

    const sliders = document.createElement('div');
    sliders.className = 'sliders';
    for (const s of SLIDERS) {
      const label = document.createElement('label');
      const text = document.createElement('span');
      text.textContent = s.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(RANGES[s.range].min);
      input.max = String(RANGES[s.range].max);
      input.step = '0.01';
      const out = document.createElement('output');
      input.addEventListener('input', () => {
        const v = Number(input.value);
        this.options[s.key] = v;
        // Keep release ≥ start (hysteresis).
        if (s.key === 'bunchClose' && this.options.bunchOpen < v) this.options.bunchOpen = v;
        if (s.key === 'bunchOpen' && this.options.bunchClose > v) this.options.bunchClose = v;
        if (s.key === 'fistClose' && this.options.fistOpen < v) this.options.fistOpen = v;
        if (s.key === 'fistOpen' && this.options.fistClose > v) this.options.fistClose = v;
        this.syncInputs();
        this.onChange();
      });
      label.append(text, input, out);
      sliders.append(label);
      this.inputs.set(s.key, { input, out });
    }
    const reset = document.createElement('button');
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      Object.assign(this.options, DEFAULT_POSE);
      this.syncInputs();
      this.onChange();
    });
    this.panel.append(meters, sliders, reset);
    this.syncInputs();
  }

  /** Reflect `options` in the sliders and meters (after loading or resetting). */
  syncInputs() {
    for (const [key, { input, out }] of this.inputs) {
      input.value = String(this.options[key]);
      out.textContent = this.options[key].toFixed(2);
    }
    for (const side of ['Left', 'Right']) {
      this.setZone(`${side}:spread`, 'spread', this.options.bunchClose, this.options.bunchOpen);
      this.setZone(`${side}:extension`, 'extension', this.options.fistClose, this.options.fistOpen);
    }
  }

  private setZone(id: string, range: keyof typeof RANGES, close: number, open: number) {
    const m = this.meters.get(id)!;
    m.zone.style.width = `${percent(range, close)}%`;
    m.band.style.left = `${percent(range, close)}%`;
    m.band.style.width = `${percent(range, open) - percent(range, close)}%`;
  }

  /** Per hand frame: what each hand is doing. */
  update(hands: PenHand[], dominant: Handedness, state: { drawing: boolean; navigating: boolean }) {
    for (const side of ['Left', 'Right'] as Handedness[]) {
      const hand = hands.find((h) => h.handedness === side && h.joints.length);
      const isDominant = side === dominant;
      const chip = this.hudHands.get(side)!;
      let text = 'not tracked';
      let kind = 'none';
      if (hand) {
        if (hand.fist) {
          text = 'fist';
          kind = 'fist';
        } else if (hand.bunched) {
          text = isDominant ? 'fingertips together → switch mode' : 'fingertips together → draw';
          kind = 'bunched';
        } else {
          text = isDominant ? 'pointing (pen)' : 'open';
          kind = 'open';
        }
      }
      chip.textContent = `${side}: ${text}`;
      chip.dataset.kind = kind;

      for (const k of ['spread', 'extension'] as const) {
        const m = this.meters.get(`${side}:${k}`)!;
        if (!hand) {
          m.root.dataset.active = 'none';
          m.value.textContent = '–';
          m.marker.style.display = 'none';
          continue;
        }
        const v = hand[k];
        m.marker.style.display = '';
        m.marker.style.left = `${percent(k, v)}%`;
        m.value.textContent = v.toFixed(2);
        m.root.dataset.active = String(k === 'spread' ? hand.bunched : hand.fist);
      }
    }
    this.hudState.textContent = state.navigating ? 'Moving the drawing' : state.drawing ? 'Drawing' : '';
    this.hudState.hidden = !state.navigating && !state.drawing;
  }

  set visible(on: boolean) {
    this.hud.hidden = !on;
  }
}

function percent(range: keyof typeof RANGES, v: number) {
  const { min, max } = RANGES[range];
  return Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
}
