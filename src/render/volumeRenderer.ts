/**
 * three.js scene plus the ray-marching material.
 *
 * Owns: the WebGL context, the two 3D textures, the transfer-function and
 * label-palette lookup textures, the camera orbit, and the adaptive step
 * count. Reads `state` for everything it draws; never writes to it except
 * `perf`.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import fragSrc from './shaders/raymarch.frag.glsl?raw';
import vertSrc from './shaders/raymarch.vert.glsl?raw';

import { CAMERA_UP, cameraDir, makeFrame, planeToObject, type Frame } from '../coords.ts';
import { state, patch } from '../state.ts';
import type { CaseData, PresetName, Vec3, WindowLevel } from '../types.ts';

/** Step counts for the three quality tiers, chosen by measured frame time. */
const STEPS_IDLE = 384;
const STEPS_NORMAL = 256;
const STEPS_MOVING = 128;
const STEPS_FLOOR = 96;

export class VolumeRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Everything that should orbit with the volume hangs off this. */
  readonly rig: THREE.Group;

  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private volumeTex: THREE.Data3DTexture | null = null;
  private labelTex: THREE.Data3DTexture | null = null;
  private transferTex: THREE.DataTexture;
  private paletteTex: THREE.DataTexture;

  frame: Frame | null = null;

  /** Rolling frame-time average and the hysteresis counters for quality. */
  private frameMsAvg = 16;
  private slowFrames = 0;
  private fastFrames = 0;
  private stepCap = STEPS_NORMAL;
  /**
   * A vessel the cut is about to clip (within 5 mm). Pulses like a voice
   * highlight, but only while nothing has been highlighted explicitly.
   */
  proximityLabel = 0;
  /** Set by the input layer; drops quality while the user is moving. */
  moving = false;
  /**
   * The ray-marched CT. Off by default: the anatomy meshes are the main view,
   * and the CT appears on the cut face. `K` toggles the raw volume back on.
   */
  volumeVisible = false;
  /**
   * Pins the step count, overriding the adaptive controller. Only the
   * screenshot harness uses this: software WebGL cannot afford the real count.
   */
  stepsOverride: number | null = null;

  private clock = new THREE.Clock();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true, // the anatomy meshes need it; the ray-marcher ignores it
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x06080c, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = backdrop();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 50);

    // Image-based light for the wet, glossy organ look, plus a key light that
    // rides with the camera so whatever the surgeon looks at is lit.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    const key = new THREE.DirectionalLight(0xfff4ea, 1.7);
    key.position.set(0.6, 0.8, 1);
    this.camera.add(key);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1a1210, 0.45));

    this.rig = new THREE.Group();
    this.scene.add(this.rig);

    this.transferTex = makeRampTexture();
    this.paletteTex = makeRampTexture();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* --------------------------------------------------------------- loading */

  setCase(data: CaseData): void {
    this.dispose();

    const f = makeFrame(data.meta);
    this.frame = f;
    const [nx, ny, nz] = data.meta.shape;

    this.volumeTex = make3DTexture(data.volume, nx, ny, nz, THREE.LinearFilter);
    // Labels must not be interpolated: averaging id 1 and id 3 would invent
    // structure 2.
    this.labelTex = make3DTexture(data.labels, nx, ny, nz, THREE.NearestFilter);

    this.buildTransfer(state.windowLevel, state.preset);
    this.buildPalette(data);

    this.material = new THREE.ShaderMaterial({
      vertexShader: vertSrc,
      fragmentShader: fragSrc,
      glslVersion: THREE.GLSL3,
      transparent: true,
      // The shader accumulates front-to-back with the colour already scaled by
      // coverage, so the output is premultiplied. Without this flag three.js
      // would blend with SRC_ALPHA and multiply by alpha a second time, which
      // darkens the whole volume and leaves a grey haze over the background
      // wherever a ray passed through almost-empty space.
      premultipliedAlpha: true,
      depthWrite: false,
      // We march from the camera toward the back faces, which is what keeps
      // the image correct once the camera is inside the volume.
      side: THREE.BackSide,
      uniforms: {
        uVolume: { value: this.volumeTex },
        uLabels: { value: this.labelTex },
        uTransfer: { value: this.transferTex },
        uPalette: { value: this.paletteTex },
        uHalf: { value: new THREE.Vector3(...f.half) },
        uCurveU: { value: curveU(data.meta.huCurve) },
        uCurveH: { value: curveH(data.meta.huCurve) },
        uWindow: { value: state.windowLevel.w },
        uLevel: { value: state.windowLevel.l },
        uSteps: { value: STEPS_NORMAL },
        uDensity: { value: 1.0 },
        uJitter: { value: 1.0 },
        uPlaneN: { value: new THREE.Vector3(1, 0, 0) },
        uPlaneD: { value: 0 },
        uPlaneOn: { value: false },
        uHighlight: { value: 0 },
        uTumorId: { value: data.meta.labels.find((l) => l.role === 'tumor')?.id ?? 0 },
        uPulse: { value: 0 },
        uTime: { value: 0 },
        uPatient: { value: 0 },
        uLabelBoost: { value: 1.0 },
      },
    });

    const geo = new THREE.BoxGeometry(f.half[0] * 2, f.half[1] * 2, f.half[2] * 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.rig.add(this.mesh);
  }

  dispose(): void {
    if (this.mesh) {
      this.rig.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.material?.dispose();
    this.material = null;
    this.volumeTex?.dispose();
    this.volumeTex = null;
    this.labelTex?.dispose();
    this.labelTex = null;
  }

  /* ----------------------------------------------------- transfer function */

  /**
   * Build the 256-entry colour/opacity ramp. Window and level stay as live
   * uniforms (so they can animate every frame for free); this texture only
   * carries the *shape* of the ramp, which is what differs between presets.
   */
  buildTransfer(_wl: WindowLevel, preset: PresetName): void {
    const data = this.transferTex.image.data as Uint8Array;
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let r: number, g: number, b: number, a: number;

      switch (preset) {
        case 'bone':
          // Hard, bright, high-contrast: nothing until mid-ramp, then a fast
          // climb to near-white so cortical bone pops.
          a = Math.pow(Math.max(0, (x - 0.42) / 0.58), 1.6);
          r = 0.92 + 0.08 * x;
          g = 0.93 + 0.07 * x;
          b = 0.9 + 0.1 * x;
          break;
        case 'lung':
          a = Math.pow(x, 2.3) * 0.55;
          r = 0.6 + 0.35 * x;
          g = 0.72 + 0.26 * x;
          b = 0.82 + 0.18 * x;
          break;
        case 'liver':
          // A narrow window saturates almost all soft tissue at the top of the
          // ramp, so a monotonically rising opacity would render the whole
          // abdomen as one white mass. Keeping the opacity low and flat across
          // the window instead lets the ray travel through parenchyma and
          // reach the labelled structures inside it.
          a = Math.pow(Math.max(0, (x - 0.12) / 0.88), 1.1) * 0.1;
          r = 0.86 + 0.12 * x;
          g = 0.6 + 0.3 * x;
          b = 0.5 + 0.34 * x;
          break;
        case 'soft':
        default:
          // The workhorse view: fat and muscle separate, bone reads bright,
          // and the body stays translucent enough to see organs inside it.
          a = Math.pow(Math.max(0, (x - 0.3) / 0.7), 2.1) * 0.5;
          r = 0.88 + 0.11 * x;
          g = 0.78 + 0.2 * x;
          b = 0.7 + 0.28 * x;
          break;
      }

      data[i * 4 + 0] = clamp255(r * 255);
      data[i * 4 + 1] = clamp255(g * 255);
      data[i * 4 + 2] = clamp255(b * 255);
      data[i * 4 + 3] = clamp255(a * 255);
    }
    this.transferTex.needsUpdate = true;
  }

  /**
   * Build the per-label tint texture, indexed by label id. Alpha doubles as
   * the visibility switch: the shader skips any sample whose palette alpha is
   * effectively zero, so hiding a structure also hides the CT inside it.
   */
  buildPalette(data: CaseData): void {
    const tex = this.paletteTex.image.data as Uint8Array;
    tex.fill(0);

    for (const label of data.meta.labels) {
      if (label.id < 1 || label.id > 255) continue;
      const shown = state.visible[label.key] !== false;
      // Per-STEP opacity, not total. A ray crosses ~80 steps of liver, so even
      // 0.02 accumulates to a solid-looking organ while still letting the
      // tumour behind it show through. These are the numbers that decide
      // whether the lesion is visible, so they are tuned, not arbitrary.
      const roleAlpha =
        label.role === 'tumor'
          ? 0.3 // dense and unmissable
          : label.role === 'vessel'
            ? 0.09 // clearly traced without hiding the organ
            : label.role === 'organ'
              ? 0.022 // translucent: you must be able to see inside it
              : 0.035; // context: present, never competing
      const o = label.id * 4;
      tex[o + 0] = clamp255(label.color[0] * 255);
      tex[o + 1] = clamp255(label.color[1] * 255);
      tex[o + 2] = clamp255(label.color[2] * 255);
      tex[o + 3] = shown ? clamp255(roleAlpha * 255) : 0;
    }
    this.paletteTex.needsUpdate = true;
  }

  /* --------------------------------------------------------------- drawing */

  /** Called once per animation frame from main.ts. */
  render(): void {
    const t0 = performance.now();
    const u = this.material?.uniforms;
    const f = this.frame;

    // --- camera orbit (both views) -----------------------------------------
    const c = state.camera;
    const dir = cameraDir(c.yaw + c.headYaw, c.pitch + c.headPitch);
    this.camera.up.set(...CAMERA_UP);
    this.camera.position.set(dir[0] * c.dist, dir[1] * c.dist, dir[2] * c.dist);
    this.camera.lookAt(0, 0, 0);

    if (this.mesh) this.mesh.visible = this.volumeVisible;
    if (u && f && this.volumeVisible) {
      // --- windowing ------------------------------------------------------
      u.uWindow.value = state.windowLevel.w;
      u.uLevel.value = state.windowLevel.l;

      // --- cutting plane --------------------------------------------------
      const op = planeToObject(f, state.plane);
      (u.uPlaneN.value as THREE.Vector3).set(op.n[0], op.n[1], op.n[2]);
      u.uPlaneD.value = op.d;
      // Patient view shows the whole organ with the tumour in it; the
      // callouts, not a missing slab, explain what comes out.
      u.uPlaneOn.value = state.plane.on && state.mode === 'surgeon';

      // --- highlight pulse ------------------------------------------------
      const time = this.clock.getElapsedTime();
      u.uTime.value = time;
      const hl = state.highlight || (state.plane.on ? this.proximityLabel : 0);
      u.uHighlight.value = hl;
      u.uPulse.value = hl > 0 ? 0.5 + 0.5 * Math.sin(time * 4.2) : 0;

      u.uPatient.value = state.mode === 'patient' ? 1 : 0;
      u.uSteps.value = this.pickSteps();
    }

    this.renderer.render(this.scene, this.camera);

    // Measure after the draw call is issued. This is CPU-side frame time, not
    // true GPU time, but it tracks it closely enough to drive quality.
    const dt = performance.now() - t0;
    this.frameMsAvg = this.frameMsAvg * 0.9 + dt * 0.1;
    patch('perf', { frameMs: Math.round(this.frameMsAvg * 10) / 10, steps: this.stepCap });
  }

  /**
   * Adaptive quality. Moving hands get fewer steps (motion hides the
   * difference); sustained slow frames halve the cap; sustained fast frames
   * earn it back. Hysteresis counters stop it oscillating.
   */
  private pickSteps(): number {
    if (this.stepsOverride !== null) return this.stepsOverride;

    if (this.frameMsAvg > 20) {
      this.slowFrames++;
      this.fastFrames = 0;
      if (this.slowFrames >= 10) {
        const next = Math.max(STEPS_FLOOR, Math.floor(this.stepCap / 2));
        if (next !== this.stepCap) {
          console.warn(
            `[render] ${this.frameMsAvg.toFixed(1)} ms/frame — dropping steps ${this.stepCap} to ${next}`,
          );
          this.stepCap = next;
        }
        this.slowFrames = 0;
      }
    } else if (this.frameMsAvg < 11) {
      this.fastFrames++;
      this.slowFrames = 0;
      if (this.fastFrames >= 120 && this.stepCap < STEPS_NORMAL) {
        this.stepCap = Math.min(STEPS_NORMAL, this.stepCap * 2);
        console.info(`[render] headroom available — raising steps to ${this.stepCap}`);
        this.fastFrames = 0;
      }
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }

    if (this.moving) return Math.min(this.stepCap, STEPS_MOVING);
    return Math.min(this.stepCap === STEPS_NORMAL ? STEPS_IDLE : this.stepCap, STEPS_IDLE);
  }

  /** Shared GPU resources the anatomy view samples for its CT cut face. */
  textures(): {
    volume: THREE.Data3DTexture;
    labels: THREE.Data3DTexture;
    palette: THREE.Texture;
    curveU: THREE.Vector4;
    curveH: THREE.Vector4;
  } | null {
    const u = this.material?.uniforms;
    if (!u || !this.volumeTex || !this.labelTex) return null;
    return {
      volume: this.volumeTex,
      labels: this.labelTex,
      palette: this.paletteTex,
      curveU: u.uCurveU.value as THREE.Vector4,
      curveH: u.uCurveH.value as THREE.Vector4,
    };
  }

  /** Screen-space projection of a world-mm point, for overlay labels. */
  worldToScreen(p: Vec3): { x: number; y: number; behind: boolean } | null {
    const f = this.frame;
    if (!f) return null;
    const v = new THREE.Vector3(
      (p[0] - f.centerMm[0]) / f.maxExtent,
      (p[1] - f.centerMm[1]) / f.maxExtent,
      (p[2] - f.centerMm[2]) / f.maxExtent,
    );
    this.rig.localToWorld(v);
    v.project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
      behind: v.z > 1,
    };
  }
}

/* ------------------------------------------------------------------ helpers */

/** A soft radial backdrop: depth behind the anatomy without a flat black void. */
function backdrop(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(256, 220, 20, 256, 256, 380);
  grad.addColorStop(0, '#16202c');
  grad.addColorStop(0.55, '#0b1017');
  grad.addColorStop(1, '#05070a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function make3DTexture(
  data: Uint8Array,
  nx: number,
  ny: number,
  nz: number,
  filter: THREE.MagnificationTextureFilter,
): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(data, nx, ny, nz);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = filter as THREE.MinificationTextureFilter;
  tex.magFilter = filter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

function makeRampTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Split the HU curve's four breakpoints into the two vec4 uniforms the shader
 * wants: byte positions in 0..1 texture units, and the matching HU values.
 */
function curveU(curve: [number, number][]): THREE.Vector4 {
  const u = padCurve(curve).map((p) => p[0] / 255);
  return new THREE.Vector4(u[0], u[1], u[2], u[3]);
}

function curveH(curve: [number, number][]): THREE.Vector4 {
  const h = padCurve(curve).map((p) => p[1]);
  return new THREE.Vector4(h[0], h[1], h[2], h[3]);
}

/** The shader is hard-wired to three segments, so insist on four points. */
function padCurve(curve: [number, number][]): [number, number][] {
  if (curve && curve.length === 4) return curve;
  console.warn('[render] huCurve should have 4 breakpoints; falling back to a linear ramp');
  return [
    [0, -1000],
    [85, -333],
    [170, 333],
    [255, 1000],
  ];
}
