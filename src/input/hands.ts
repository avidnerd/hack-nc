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
  /** Last emitted observation per hand, re-emitted across a brief dropout. */
  private lastObs: Record<Side, HandObs | null> = { left: null, right: null };
  /** Last wrist position per hand (mirrored image units), to keep identities. */
  private lastWrist: Record<Side, [number, number] | null> = { left: null, right: null };
  /** When detection last ran; the rAF path takes over if frame callbacks stall. */
  private lastDetect = -1e9;
  /** Last timestamp given to MediaPipe, which rejects any that do not increase. */
  private lastTs = 0;

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
    // The model downloads and compiles while the camera permission prompt is
    // up, instead of after it: hands are live a second or two sooner.
    const t0 = performance.now();
    const model = this.loadModel();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: 'user' },
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

    const landmarker = await model;
    if (!landmarker) return false;
    // The first GPU inference compiles shaders (a few hundred ms). Pay for it
    // here, not on the first frame a hand is up.
    try {
      landmarker.detectForVideo(this.video, this.stamp());
    } catch (err) {
      console.warn('[hands] warm-up failed', err);
    }
    this.landmarker = landmarker;
    console.info(`[hands] HandLandmarker ready in ${(performance.now() - t0).toFixed(0)} ms`);
    this.followFrames();
    return true;
  }

  private async loadModel(): Promise<HandLandmarker | null> {
    try {
      const vision = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe/wasm`);
      return await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: TUNING.detection.detect,
        minHandPresenceConfidence: TUNING.detection.presence,
        minTrackingConfidence: TUNING.detection.tracking,
      });
    } catch (err) {
      console.warn('[hands] model failed to load', err);
      return null;
    }
  }

  /**
   * Detect as each camera frame arrives rather than on the next animation
   * frame: up to one display frame less latency, and no camera frame is
   * skipped or waited on because the two clocks drift.
   */
  private followFrames(): void {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    const onVideoFrame = (): void => {
      try {
        if (!this.playback) this.detect();
      } catch (err) {
        console.error('[hands] detect failed', err);
      }
      v.requestVideoFrameCallback(onVideoFrame);
    };
    v.requestVideoFrameCallback(onVideoFrame);
  }

  /** Call once per animation frame. */
  tick(now: number): void {
    if (this.playback) {
      this.tickPlayback(now);
      return;
    }
    // Frame callbacks are the normal path; this covers browsers without them
    // and any stall (a hidden video can stop delivering them).
    if (now - this.lastDetect > TUNING.detectStallMs) this.detect();
  }

  /**
   * One clock for every detection, whichever path calls it: rAF's frame
   * timestamp can be earlier than a frame callback's performance.now() in the
   * same frame, and MediaPipe fails the whole graph on a step backwards.
   */
  private stamp(): number {
    this.lastTs = Math.max(performance.now(), this.lastTs + 0.001);
    return this.lastTs;
  }

  private detect(): void {
    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const now = this.stamp();
    this.lastDetect = now;
    const res = this.landmarker.detectForVideo(this.video, now);
    this.detectMs = this.detectMs * 0.9 + (performance.now() - now) * 0.1;

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

  /**
   * MediaPipe's handedness label is a per-frame guess and flips now and then,
   * most often with gloves or a hand seen edge-on. A flip would reset that
   * hand's smoothing and pose, so identity follows position instead: a lone
   * hand nearer where the other label's hand just was takes that label, and
   * two tracked hands keep whichever pairing moves them least.
   */
  private stabiliseSides(raw: RawFrame['hands'], now: number): RawFrame['hands'] {
    const a = this.aspect;
    const wrist = (h: RawFrame['hands'][number]): [number, number] => [(1 - h.lm[0]) * a, h.lm[1]];
    const recent = (s: Side): boolean => now - this.lastSeen[s] < TUNING.handMemoryMs;
    const gap = (p: [number, number], s: Side): number => {
      const q = this.lastWrist[s];
      return q && recent(s) ? Math.hypot(p[0] - q[0], p[1] - q[1]) : Infinity;
    };

    if (raw.length === 1) {
      const h = raw[0];
      const other: Side = h.side === 'left' ? 'right' : 'left';
      const w = wrist(h);
      const g = gap(w, other);
      return g < TUNING.sideSwapMaxDist && g < gap(w, h.side) ? [{ ...h, side: other }] : raw;
    }
    if (raw.length === 2) {
      const [h0, h1] = raw;
      const w0 = wrist(h0);
      const w1 = wrist(h1);
      let leftFirst: boolean;
      if (recent('left') && recent('right')) {
        leftFirst = gap(w0, 'left') + gap(w1, 'right') <= gap(w0, 'right') + gap(w1, 'left');
      } else if (h0.side === h1.side) {
        // Both labelled the same with nothing to go on: in the mirrored view
        // the user's left hand is the one on the left.
        leftFirst = w0[0] < w1[0];
      } else {
        return raw;
      }
      return [
        { ...h0, side: leftFirst ? 'left' : 'right' },
        { ...h1, side: leftFirst ? 'right' : 'left' },
      ];
    }
    return raw;
  }

  /** Smooth raw landmarks, convert to image units, and emit. */
  private ingest(detected: RawFrame['hands'], now: number): void {
    const a = this.aspect;
    const raw = this.stabiliseSides(detected, now);
    const out: HandObs[] = [];
    for (const h of raw) {
      // A hand that vanished and came back must not be smoothed toward where
      // it was a second ago.
      if (now - this.lastSeen[h.side] > TUNING.lostMs) this.filters[h.side].reset();
      this.lastSeen[h.side] = now;
      this.lastWrist[h.side] = [(1 - h.lm[0]) * a, h.lm[1]];

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
      const obs: HandObs = {
        side: h.side,
        lm,
        uv: toUv(c),
        indexUv: toUv(ix),
        pinchUv: toUv([(th[0] + ix[0]) / 2, (th[1] + ix[1]) / 2, 0]),
      };
      this.lastObs[h.side] = obs;
      out.push(obs);
    }
    // The detector drops a hand for a frame or two in fast moves and motion
    // blur. Holding its last reading over the gap keeps the gesture (and the
    // cut's depth reference) alive instead of re-dwelling from scratch.
    for (const s of ['left', 'right'] as Side[]) {
      const last = this.lastObs[s];
      if (!last || out.some((o) => o.side === s)) continue;
      if (now - this.lastSeen[s] <= TUNING.coastMs) out.push(last);
      else this.lastObs[s] = null;
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
    this.lastObs = { left: null, right: null };
    this.lastWrist = { left: null, right: null };
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
