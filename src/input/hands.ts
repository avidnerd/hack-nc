/**
 * Webcam + MediaPipe HandLandmarker, producing smoothed `HandObs` per frame.
 *
 * Also owns the two harness features that make the demo un-killable:
 *   Shift+D  record the raw landmark stream to a JSON download
 *   D        replay public/demo/landmarks.json through the exact same path
 *
 * Everything runs on the client; no frame ever leaves the machine.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

import { palmCenter, type HandObs, type Pt, type Side } from './gestures.ts';
import { OneEuroVec } from './oneEuro.ts';
import { LM, TUNING } from './tuning.ts';

/** One frame of raw MediaPipe output, as recorded and replayed. */
export interface RawFrame {
  /** ms since the start of the recording. */
  t: number;
  /** 63 numbers per hand: x, y, z per landmark, MediaPipe-normalised, unmirrored. */
  hands: { side: Side; lm: number[] }[];
  /** The pose the user was asked to hold (Shift+G teaching mode only). */
  label?: string;
}

export interface Recording {
  aspect: number;
  frames: RawFrame[];
}

/** Filter in camera-pixel units: the scale the spec's 1€ beta is tuned for. */
const PX = 480;

const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export class HandInput {
  /** Camera width / height. Recordings carry their own. */
  aspect = 4 / 3;
  /** Fires once per new set of landmarks (camera or playback). */
  onFrame: (hands: HandObs[], tMs: number) => void = () => {};
  /** Fires when a playback finishes. */
  onPlaybackEnd: () => void = () => {};

  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;
  private filters: Record<Side, OneEuroVec> = {
    left: new OneEuroVec(63, TUNING.landmarkFilter),
    right: new OneEuroVec(63, TUNING.landmarkFilter),
  };
  private lastSeen: Record<Side, number> = { left: -1e9, right: -1e9 };

  private recording: RawFrame[] | null = null;
  /** Set while teaching mode prompts a pose; stamped onto recorded frames. */
  label: string | null = null;
  private recordStart = 0;

  private playback: { rec: Recording; start: number; i: number } | null = null;

  /** Measured detect() time, for the dev console. */
  detectMs = 0;

  constructor() {
    this.video = document.getElementById('cam') as HTMLVideoElement;
    this.overlay = document.getElementById('camoverlay') as HTMLCanvasElement;
  }

  /** The webcam element, shared with the head tracker. */
  get videoElement(): HTMLVideoElement {
    return this.video;
  }

  get cameraOn(): boolean {
    return this.landmarker !== null;
  }

  get playing(): boolean {
    return this.playback !== null;
  }

  get recordingNow(): boolean {
    return this.recording !== null;
  }

  /**
   * Ask for the camera and load the model. Resolves false (never throws) when
   * either fails, so the caller can fall back to mouse mode.
   */
  async start(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      this.video.srcObject = stream;
      await this.video.play();
      const s = stream.getVideoTracks()[0]?.getSettings();
      if (s?.width && s?.height) this.aspect = s.width / s.height;
    } catch (err) {
      console.warn('[hands] camera unavailable', err);
      return false;
    }

    try {
      const t0 = performance.now();
      const vision = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe/wasm`);
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      console.info(`[hands] HandLandmarker ready in ${(performance.now() - t0).toFixed(0)} ms`);
      return true;
    } catch (err) {
      console.warn('[hands] model failed to load', err);
      return false;
    }
  }

  /** Call once per animation frame. */
  tick(now: number): void {
    if (this.playback) {
      this.tickPlayback(now);
      return;
    }
    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(this.video, now);
    this.detectMs = this.detectMs * 0.9 + (performance.now() - t0) * 0.1;

    const hands: RawFrame['hands'] = [];
    for (let h = 0; h < res.landmarks.length; h++) {
      const lms = res.landmarks[h];
      const lm: number[] = [];
      for (const p of lms) lm.push(p.x, p.y, p.z);
      // MediaPipe labels handedness as if the image were mirrored; ours is
      // not, so its "Left" is the user's right.
      const label = res.handedness[h]?.[0]?.categoryName ?? 'Right';
      hands.push({ side: label === 'Left' ? 'right' : 'left', lm });
    }

    if (this.recording) {
      this.recording.push({ t: now - this.recordStart, hands, ...(this.label ? { label: this.label } : {}) });
    }
    this.ingest(hands, now);
  }

  /** Smooth raw landmarks, convert to image units, and emit. */
  private ingest(raw: RawFrame['hands'], now: number): void {
    const a = this.aspect;
    const out: HandObs[] = [];
    for (const h of raw) {
      // A hand that vanished and came back must not be smoothed toward where
      // it was a second ago.
      if (now - this.lastSeen[h.side] > TUNING.lostMs) this.filters[h.side].reset();
      this.lastSeen[h.side] = now;

      const px: number[] = new Array(63);
      for (let i = 0; i < 21; i++) {
        px[i * 3] = (1 - h.lm[i * 3]) * a * PX;
        px[i * 3 + 1] = h.lm[i * 3 + 1] * PX;
        px[i * 3 + 2] = h.lm[i * 3 + 2] * a * PX;
      }
      const f = this.filters[h.side].filter(px, now);
      const lm: Pt[] = [];
      for (let i = 0; i < 21; i++) lm.push([f[i * 3] / PX, f[i * 3 + 1] / PX, f[i * 3 + 2] / PX]);

      const toUv = (p: Pt): [number, number] => [p[0] / a, p[1]];
      const c = palmCenter(lm);
      const th = lm[LM.THUMB_TIP];
      const ix = lm[LM.INDEX_TIP];
      out.push({
        side: h.side,
        lm,
        uv: toUv(c),
        indexUv: toUv(ix),
        pinchUv: toUv([(th[0] + ix[0]) / 2, (th[1] + ix[1]) / 2, 0]),
      });
    }
    this.drawPreview(out);
    this.onFrame(out, now);
  }

  /* ---------------------------------------------------------------- preview */

  private drawPreview(hands: HandObs[]): void {
    const c = this.overlay;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    for (const hand of hands) {
      const pts = hand.lm.map((p) => [(p[0] / this.aspect) * w, p[1] * h] as const);
      g.strokeStyle = 'rgba(88, 229, 200, 0.7)';
      g.lineWidth = 1.5;
      g.beginPath();
      for (const [i, j] of BONES) {
        g.moveTo(pts[i][0], pts[i][1]);
        g.lineTo(pts[j][0], pts[j][1]);
      }
      g.stroke();
      g.fillStyle = '#e8fff9';
      for (const [x, y] of pts) {
        g.beginPath();
        g.arc(x, y, 2.2, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  /* ------------------------------------------------------- record / replay */

  /** Toggle the recorder; on stop, downloads landmarks.json. */
  toggleRecording(filename = 'landmarks.json'): boolean {
    if (!this.recording) {
      this.recording = [];
      this.recordStart = performance.now();
      return true;
    }
    const rec: Recording = { aspect: this.aspect, frames: this.recording };
    this.recording = null;
    const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return false;
  }

  async loadAndPlay(url = `${import.meta.env.BASE_URL}demo/landmarks.json`): Promise<boolean> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      this.play((await res.json()) as Recording);
      return true;
    } catch (err) {
      console.warn('[hands] no demo recording at', url, err);
      return false;
    }
  }

  play(rec: Recording): void {
    this.aspect = rec.aspect || this.aspect;
    this.filters.left.reset();
    this.filters.right.reset();
    this.playback = { rec, start: performance.now(), i: 0 };
  }

  stopPlayback(): void {
    if (!this.playback) return;
    this.playback = null;
    this.onPlaybackEnd();
  }

  private tickPlayback(now: number): void {
    const pb = this.playback;
    if (!pb) return;
    const elapsed = now - pb.start;
    const frames = pb.rec.frames;
    // Emit only the latest due frame: replay at wall-clock speed, never faster.
    let due: RawFrame | null = null;
    while (pb.i < frames.length && frames[pb.i].t <= elapsed) due = frames[pb.i++];
    if (due) this.ingest(due.hands, now);
    if (pb.i >= frames.length) this.stopPlayback();
  }
}
