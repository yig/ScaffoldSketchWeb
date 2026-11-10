/**
 * Where hands come from. All sources report webhands3d `Hand3D`s, which the
 * app turns into pens (input/hands.ts):
 *
 * - webcams: a webhands3d MultiViewHandTracker with this computer's camera
 *   (and any phones that join by QR code), plus the library's calibration UI;
 * - WebXR: the headset's hand tracking through webhands3d's WebXRHandTracker,
 *   sharing three.js's XR session.
 */

import {
  MonocularHandTracker,
  MultiViewHandTracker,
  WebXRHandTracker,
  createCalibrationPanel,
  createRemoteCameraJoin,
  openCamera,
  watchCameras,
  type CalibrationPanel,
  type CameraHandle,
  type Hand3D,
  type StatusKind,
} from '@ygingold/webhands3d';
import type * as THREE from 'three';

export type HandsListener = (hands: Hand3D[], time: number) => void;

export class WebcamSource {
  readonly tracker = new MultiViewHandTracker([]);
  private local: { source: MonocularHandTracker; camera: CameraHandle } | null = null;
  private panel: CalibrationPanel | null = null;
  private started = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly ui: { calibration: HTMLElement; join: HTMLElement; cameraSelect: HTMLSelectElement },
    private readonly say: (text: string, kind?: StatusKind) => void,
  ) {}

  onHands(listener: HandsListener) {
    return this.tracker.onFrame(listener);
  }

  /** Start (or switch) the local camera. */
  async start(deviceId?: string) {
    if (!this.started) {
      this.started = true;
      await this.tracker.start();
      this.panel = createCalibrationPanel(this.ui.calibration, {
        tracker: this.tracker,
        videoFor: (source) => (source === this.local?.source ? this.video : null),
        banner: false,
        onStatus: (text, kind) => this.say(text, kind),
      });
      watchCameras(
        (cameras) => {
          const current = this.local?.camera.cameraId;
          this.ui.cameraSelect.replaceChildren(
            ...cameras.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === current)),
          );
        },
        { onError: (e) => this.say(`Camera access is blocked (${e}). Allow the camera in the site settings, then reload.`, 'error') },
      );
      this.joinPhones();
    }
    if (this.local) {
      this.tracker.removeSource(this.local.source);
      this.local.source.stop();
      this.local.camera.stop();
      this.local = null;
    }
    this.say('Opening camera…', 'busy');
    const camera = await openCamera({ video: this.video, deviceId });
    const source = new MonocularHandTracker({ video: this.video });
    this.local = { source, camera };
    this.say('Loading hand tracking…', 'busy');
    await this.tracker.addSource(source);
    this.panel?.refresh();
    this.say(`${camera.label || 'Camera'} running. Calibrate below for accurate depth.`, 'ok');
  }

  /** QR code / link so phones can join as extra cameras (better depth by triangulation). */
  private async joinPhones() {
    let base = new URL('.', location.href).href;
    if (import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(location.hostname)) {
      try {
        const info = (await (await fetch('/lan-info')).json()) as { urls: string[] };
        if (info.urls[0]) base = `${info.urls[0]}/`;
      } catch {}
    }
    createRemoteCameraJoin(this.ui.join, {
      tracker: this.tracker,
      phonePageUrl: new URL('phone.html', base).href,
      onStatus: (text, kind) => this.say(text, kind),
      addCamera: async (camera) => {
        await this.tracker.addSource(camera);
        this.panel?.refresh();
      },
      removeCamera: (camera) => {
        this.tracker.removeSource(camera);
        this.panel?.refresh();
      },
    });
  }
}

export interface XRStart {
  session: XRSession;
  tracker: WebXRHandTracker;
}

/** Whether an immersive session is available (WebXR hand tracking is only known once it starts). */
export async function xrSupported(): Promise<{ vr: boolean; ar: boolean }> {
  const xr = navigator.xr;
  if (!xr) return { vr: false, ar: false };
  const [vr, ar] = await Promise.all([
    xr.isSessionSupported('immersive-vr').catch(() => false),
    xr.isSessionSupported('immersive-ar').catch(() => false),
  ]);
  return { vr, ar };
}

/** Enter VR (white room) or AR (passthrough) with hand tracking, rendering with `renderer`. */
export async function startXR(renderer: THREE.WebGLRenderer, mode: 'immersive-vr' | 'immersive-ar', listener: HandsListener): Promise<XRStart> {
  const xr = navigator.xr;
  if (!xr) throw new Error('WebXR is not available in this browser');
  const session = await xr.requestSession(mode, { requiredFeatures: ['hand-tracking'] });
  await renderer.xr.setSession(session);
  // Same reference space as the renderer ('local'), so joints line up with the scene.
  const tracker = new WebXRHandTracker({ session, referenceSpaceType: 'local' });
  tracker.onFrame(listener);
  await tracker.start();
  return { session, tracker };
}
