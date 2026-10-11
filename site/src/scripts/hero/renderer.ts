/**
 * The hero: the app's own ray-marcher on the real liver CT.
 *
 * The shaders are imported straight from the app (../src/render/shaders), and
 * the volume is the app's case downsampled at build time. This file only owns
 * what the site needs on top: a lean three.js scene, a scroll-friendly camera,
 * the site palette (tumour in --danger, hepatic vessels in --accent), and a
 * frame-time governor.
 */

import * as THREE from 'three';

import fragSrc from '@app/render/shaders/raymarch.frag.glsl?raw';
import vertSrc from '@app/render/shaders/raymarch.vert.glsl?raw';
import { CAMERA_UP, cameraBasis, cameraDir, makeFrame, objectToWorld, planeToObject, type Frame } from '@app/coords.ts';
import type { CaseMeta, Vec3 } from '@app/types.ts';

export interface HeroMeta {
  shape: Vec3;
  spacing: Vec3;
  origin: Vec3;
  huCurve: [number, number][];
  labels: { id: number; key: string; role: string; color: Vec3 }[];
  stats: Record<'liver' | 'tumor' | 'hepatic_vessels', { centroid: Vec3 }>;
}

export interface HeroData {
  meta: HeroMeta;
  volume: Uint8Array;
  labels: Uint8Array;
}

/** Site colours as linear-ish 0..1 RGB, matching tokens.css. */
const DANGER: Vec3 = [1.0, 0.353, 0.31];
const ACCENT: Vec3 = [0.31, 0.89, 0.757];

const STEPS_MIN = 96;

/**
 * Fetch one resolution level (meta.json, volume.u8.gz, labels.u8.gz) with
 * byte progress. The volumes are gzipped at build time and inflated here,
 * unless the host already decoded them (then the gzip magic is absent).
 */
export async function loadHero(base: string, onProgress: (f: number) => void = () => {}): Promise<HeroData> {
  const meta = (await (await fetch(`${base}meta.json`)).json()) as HeroMeta & { bytes?: { volume: number; labels: number } };
  const n = meta.shape[0] * meta.shape[1] * meta.shape[2];
  const total = meta.bytes ? meta.bytes.volume + meta.bytes.labels : 2 * n;
  const got = [0, 0];

  async function pull(name: string, slot: number): Promise<Uint8Array> {
    const res = await fetch(`${base}${name}`);
    if (!res.ok || !res.body) throw new Error(`${name}: ${res.status}`);
    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got[slot] += value.length;
      onProgress(Math.min(1, (got[0] + got[1]) / total));
    }
    let bytes = new Blob(chunks as BlobPart[]);
    const head = new Uint8Array(await bytes.slice(0, 2).arrayBuffer());
    if (head[0] === 0x1f && head[1] === 0x8b) {
      bytes = await new Response(bytes.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
    }
    const out = new Uint8Array(await bytes.arrayBuffer());
    if (out.length !== n) throw new Error(`${name}: ${out.length} bytes, expected ${n}`);
    return out;
  }

  const [volume, labels] = await Promise.all([pull('volume.u8.gz', 0), pull('labels.u8.gz', 1)]);
  return { meta, volume, labels };
}

export class HeroRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly frame: Frame;
  private scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
  private material: THREE.ShaderMaterial;
  private paletteTex: THREE.DataTexture;
  private clock = new THREE.Clock();
  private vesselId: number;

  /** Orbit, in radians. */
  yaw = 0;
  pitch = 0;
  dist = 1.95;
  /** Fraction of the width the render centre sits right of the page centre. */
  shift = 0.27;

  private frameMs = 12;
  private steps = 192;
  /** Step ceiling: roughly one sample per voxel along the longest axis. */
  private stepsMax = 224;
  private last = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly data: HeroData,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const { meta } = data;
    // makeFrame reads only shape, spacing and origin, which the site meta carries.
    this.frame = makeFrame(meta as unknown as CaseMeta);
    const [nx, ny, nz] = meta.shape;
    const f = this.frame;

    this.paletteTex = rampTexture();
    this.vesselId = meta.labels.find((l) => l.key === 'hepatic_vessels')?.id ?? 0;
    this.setVesselGlow(0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: vertSrc,
      fragmentShader: fragSrc,
      glslVersion: THREE.GLSL3,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uVolume: { value: tex3D(data.volume, nx, ny, nz, THREE.LinearFilter) },
        uLabels: { value: tex3D(data.labels, nx, ny, nz, THREE.NearestFilter) },
        uTransfer: { value: softTransfer() },
        uPalette: { value: this.paletteTex },
        uHalf: { value: new THREE.Vector3(...f.half) },
        uCurveU: { value: new THREE.Vector4(...meta.huCurve.map((p) => p[0] / 255)) },
        uCurveH: { value: new THREE.Vector4(...meta.huCurve.map((p) => p[1])) },
        uWindow: { value: 400 },
        uLevel: { value: 40 },
        uSteps: { value: this.steps },
        uDensity: { value: 1.0 },
        uJitter: { value: 1.0 },
        uPlaneN: { value: new THREE.Vector3(1, 0, 0) },
        uPlaneD: { value: 0 },
        uPlaneOn: { value: false },
        uHighlight: { value: 0 },
        uTumorId: { value: meta.labels.find((l) => l.role === 'tumor')?.id ?? 0 },
        uPulse: { value: 0 },
        uTime: { value: 0 },
        uPatient: { value: 0 },
        uLabelBoost: { value: 1.0 },
      },
    });

    const box = new THREE.Mesh(new THREE.BoxGeometry(f.half[0] * 2, f.half[1] * 2, f.half[2] * 2), this.material);
    this.scene.add(box);
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the torso the same apparent width on tall and wide screens.
    this.camera.fov = w / h < 1.2 ? 44 : 32;
    // Asymmetric layout: the torso sits over columns 6 to 12, clear of the
    // headline, without moving the camera (which would change the view).
    this.camera.setViewOffset(w, h, -w * this.shift, 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Swap in a finer level of the same scan. Only the textures change: the box
   * keeps the first level's physical frame (the two differ by under 0.5 % from
   * whole-voxel rounding), so planes already in world mm stay where they are.
   */
  upgrade(data: HeroData): void {
    const u = this.material.uniforms;
    const [nx, ny, nz] = data.meta.shape;
    (u.uVolume.value as THREE.Data3DTexture).dispose();
    (u.uLabels.value as THREE.Data3DTexture).dispose();
    u.uVolume.value = tex3D(data.volume, nx, ny, nz, THREE.LinearFilter);
    u.uLabels.value = tex3D(data.labels, nx, ny, nz, THREE.NearestFilter);
    this.stepsMax = Math.max(this.stepsMax, Math.min(448, Math.round(Math.max(nx, ny, nz) * 1.6)));
  }

  /** The plane last set, in world mm; what the live numbers are computed for. */
  plane: { on: boolean; n: Vec3; d: number } = { on: false, n: [1, 0, 0], d: 0 };

  /** World-mm plane n·x = d; the positive side is cut away. */
  setPlane(on: boolean, n: Vec3 = [1, 0, 0], d = 0): void {
    this.plane = { on, n, d };
    const u = this.material.uniforms;
    u.uPlaneOn.value = on;
    const op = planeToObject(this.frame, { n, d });
    (u.uPlaneN.value as THREE.Vector3).set(...op.n);
    u.uPlaneD.value = op.d;
  }

  /**
   * 0..1. Hepatic vessels sit faint and blue-grey until the cut approaches,
   * then brighten to the accent. Rewriting a 256x1 texture per frame is free.
   */
  setVesselGlow(g: number): void {
    const data = this.paletteTex.image.data as Uint8Array;
    data.fill(0);
    for (const l of this.data.meta.labels) {
      const o = l.id * 4;
      let rgb = l.color;
      // Per-step opacities follow the app's palette: organ translucent,
      // tumour dense, vessels traced, context faint.
      let a = l.role === 'tumor' ? 0.3 : l.role === 'vessel' ? 0.06 : l.role === 'organ' ? 0.022 : 0.03;
      if (l.role === 'tumor') rgb = DANGER;
      // Red belongs to the tumour alone on this page; other vessels go neutral.
      else if (l.role === 'vessel') rgb = [0.6, 0.65, 0.7];
      if (l.id === this.vesselId) {
        rgb = mix3([0.42, 0.55, 0.62], ACCENT, g);
        a = 0.06 + 0.2 * g;
      }
      data[o] = Math.round(rgb[0] * 255);
      data[o + 1] = Math.round(rgb[1] * 255);
      data[o + 2] = Math.round(rgb[2] * 255);
      data[o + 3] = Math.round(a * 255);
    }
    this.paletteTex.needsUpdate = true;
  }

  /** Camera ray through a CSS pixel of the canvas, in world mm. */
  ray(xPx: number, yPx: number): { o: Vec3; d: Vec3 } {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector3(((xPx - r.left) / r.width) * 2 - 1, -((yPx - r.top) / r.height) * 2 + 1, 0.5);
    ndc.unproject(this.camera);
    const o = this.camera.position;
    const d = ndc.sub(o).normalize();
    return { o: objectToWorld(this.frame, [o.x, o.y, o.z]), d: [d.x, d.y, d.z] };
  }

  basis(): ReturnType<typeof cameraBasis> {
    return cameraBasis(this.yaw, this.pitch);
  }

  render(): void {
    const now = performance.now();
    if (this.last) this.frameMs = this.frameMs * 0.92 + (now - this.last) * 0.08;
    this.last = now;
    // Frame governor: wall-clock frame time is what the visitor feels. Back
    // off steps when we miss 60 fps, and creep back when there is room.
    if (this.frameMs > 19 && this.steps > STEPS_MIN) this.steps = Math.max(STEPS_MIN, this.steps - 4);
    else if (this.frameMs < 15 && this.steps < this.stepsMax) this.steps += 1;

    const dir = cameraDir(this.yaw, this.pitch);
    this.camera.up.set(...CAMERA_UP);
    this.camera.position.set(dir[0] * this.dist, dir[1] * this.dist, dir[2] * this.dist);
    this.camera.lookAt(0, 0, 0);

    const u = this.material.uniforms;
    u.uTime.value = this.clock.getElapsedTime();
    u.uSteps.value = this.steps;
    this.renderer.render(this.scene, this.camera);
  }

  get stats(): { frameMs: number; steps: number } {
    return { frameMs: Math.round(this.frameMs * 10) / 10, steps: this.steps };
  }
}

/* ------------------------------------------------------------------ helpers */

function mix3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function tex3D(data: Uint8Array, nx: number, ny: number, nz: number, filter: THREE.MagnificationTextureFilter) {
  const t = new THREE.Data3DTexture(data, nx, ny, nz);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = filter as THREE.MinificationTextureFilter;
  t.magFilter = filter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

function rampTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * The app's "soft" ramp (VolumeRenderer.buildTransfer), slightly thinned so
 * the body reads as a translucent shell around the organ on a black page.
 */
function softTransfer(): THREE.DataTexture {
  const t = rampTexture();
  const d = t.image.data as Uint8Array;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const a = Math.pow(Math.max(0, (x - 0.3) / 0.7), 2.1) * 0.42;
    d[i * 4] = Math.round((0.88 + 0.11 * x) * 255);
    d[i * 4 + 1] = Math.round((0.78 + 0.2 * x) * 255);
    d[i * 4 + 2] = Math.round((0.7 + 0.28 * x) * 255);
    d[i * 4 + 3] = Math.round(a * 255);
  }
  t.needsUpdate = true;
  return t;
}
