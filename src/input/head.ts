/**
 * Head-coupled perspective (M8, behind VITE_HEAD=1): lean left and the view
 * swings as if you were looking around the body.
 *
 * Uses MediaPipe's BlazeFace short-range detector on the same webcam frames as
 * the hand tracker, every other frame, and only its nose-tip keypoint. Maps
 * the nose's offset from the frame centre to +-10 degrees of extra yaw/pitch.
 */

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

import { patch } from '../state.ts';
import { OneEuro } from './oneEuro.ts';

const MAX_RAD = (10 * Math.PI) / 180;
const NOSE = 2;

export class HeadTracker {
  private detector: FaceDetector | null = null;
  private lastVideoTime = -1;
  private frame = 0;
  private fx = new OneEuro({ minCutoff: 0.8, beta: 0.05, dCutoff: 1 });
  private fy = new OneEuro({ minCutoff: 0.8, beta: 0.05, dCutoff: 1 });

  static enabled(): boolean {
    return import.meta.env.VITE_HEAD === '1' || new URLSearchParams(location.search).get('head') === '1';
  }

  async start(): Promise<boolean> {
    try {
      const vision = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe/wasm`);
      this.detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `${import.meta.env.BASE_URL}models/blaze_face_short_range.tflite`,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
      });
      return true;
    } catch (err) {
      console.warn('[head] face detector unavailable', err);
      return false;
    }
  }

  tick(video: HTMLVideoElement, now: number): void {
    if (!this.detector || video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    // Every other frame: head motion is slow and the hands need the budget.
    if (this.frame++ % 2) return;
    const face = this.detector.detectForVideo(video, now).detections[0];
    const nose = face?.keypoints?.[NOSE];
    if (!nose) return;
    // Mirrored so leaning to your left swings the view to your left.
    const x = this.fx.filter(1 - nose.x - 0.5, now);
    const y = this.fy.filter(nose.y - 0.5, now);
    patch('camera', {
      headYaw: Math.max(-MAX_RAD, Math.min(MAX_RAD, -x * 2 * MAX_RAD)),
      headPitch: Math.max(-MAX_RAD, Math.min(MAX_RAD, y * 2 * MAX_RAD)),
    });
  }
}
