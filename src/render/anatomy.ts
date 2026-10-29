/**
 * The anatomy view: lit, smooth surfaces for every segmented structure, the
 * real CT section on the cut face, and the resected piece lifting away when
 * the cut is locked.
 *
 * Geometry comes from pipeline/meshes.py in world millimetres; this group is
 * scaled into the renderer's object space, the same space the ray-marcher and
 * overlays use, so the cut plane, the numbers and the pixels agree.
 */

import * as THREE from 'three';

import { clamp, easeInOut, type Frame } from '../coords.ts';
import { planeBoxPolygon } from './overlays.ts';
import { state } from '../state.ts';
import type { CaseData, LabelDef, MeshEntry, Plane, Vec3 } from '../types.ts';

/** How far the resected piece travels along the plane normal, mm. */
const LIFT_MM = 38;
const LIFT_MS = 900;

/** Fresnel rim: translucent surfaces read as solid at their silhouettes. */
function withRim(mat: THREE.MeshPhysicalMaterial, base: number, power: number): THREE.MeshPhysicalMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
       float rimF = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), ${power.toFixed(2)});
       gl_FragColor.a *= mix(${base.toFixed(3)}, 1.0, rimF);`,
    );
  };
  mat.customProgramCacheKey = () => `rim-${base}-${power}`;
  return mat;
}

function materialFor(key: string, label: LabelDef | undefined, kind: string): THREE.MeshPhysicalMaterial {
  // In the aorta case the liver is context, not the subject: a faint ghost.
  const aortaCase = kind === 'aorta';
  const c = label ? new THREE.Color(...label.color) : new THREE.Color(0xffffff);
  switch (key) {
    case 'skin':
      return withRim(
        new THREE.MeshPhysicalMaterial({
          color: 0xd9b8a6, roughness: 0.6, transparent: true, opacity: 0.55,
          depthWrite: false, side: THREE.FrontSide,
        }),
        0.03, 3.0,
      );
    case 'bone':
      return new THREE.MeshPhysicalMaterial({ color: 0xe8dfcc, roughness: 0.62, clearcoat: 0.1 });
    case 'liver':
      return withRim(
        new THREE.MeshPhysicalMaterial({
          color: 0x9a3a2c, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25,
          transparent: true, opacity: aortaCase ? 0.16 : 0.7, depthWrite: false, side: THREE.FrontSide,
        }),
        0.32, 2.2,
      );
    default:
      break;
  }
  if (label?.role === 'tumor') {
    return new THREE.MeshPhysicalMaterial({
      color: 0xff6a3a, emissive: 0x5a1400, roughness: 0.4, clearcoat: 0.5,
    });
  }
  if (key === 'aorta') {
    // Translucent, so a stent and the flow inside it stay visible.
    return withRim(
      new THREE.MeshPhysicalMaterial({
        color: 0xd8414f, roughness: 0.28, clearcoat: 0.8, transparent: true, opacity: aortaCase ? 0.42 : 0.75, depthWrite: false,
      }),
      0.35, 2.0,
    );
  }
  if (key.startsWith('vista_')) {
    // Found by a VISTA-3D point prompt: the teal, lit a little from within.
    return new THREE.MeshPhysicalMaterial({ color: c, emissive: 0x13a89c, emissiveIntensity: 0.55, roughness: 0.35, clearcoat: 0.6 });
  }
  if (label?.role === 'vessel') {
    return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.15 });
  }
  return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.45, clearcoat: 0.3 });
}

/** The CT section on the cut face: real HU through the current window, tinted by structure. */
const CAP_VERT = /* glsl */ `
  out vec3 vObj;
  void main() {
    vObj = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const CAP_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  in vec3 vObj;
  out vec4 fragColor;
  uniform sampler3D uVolume;
  uniform sampler3D uLabels;
  uniform sampler2D uPalette;
  uniform vec3 uHalf;
  uniform vec4 uCurveU;
  uniform vec4 uCurveH;
  uniform float uWindow;
  uniform float uLevel;
  uniform vec3 uShift;     // object-space translation of this cap (lifted piece)
  uniform float uOrganOnly;
  uniform float uOrganIds[4];
  uniform float uTumorId;
  uniform float uOpacity;

  float toHU(float v) {
    if (v <= uCurveU.y) return mix(uCurveH.x, uCurveH.y, (v - uCurveU.x) / max(uCurveU.y - uCurveU.x, 1e-6));
    if (v <= uCurveU.z) return mix(uCurveH.y, uCurveH.z, (v - uCurveU.y) / max(uCurveU.z - uCurveU.y, 1e-6));
    return mix(uCurveH.z, uCurveH.w, (v - uCurveU.z) / max(uCurveU.w - uCurveU.z, 1e-6));
  }

  bool hitsTissue(vec3 uvw, vec3 dir) {
    for (int s = 1; s <= 6; s++) {
      vec3 q = uvw + dir * (0.03 * float(s));
      if (any(lessThan(q, vec3(0.0))) || any(greaterThan(q, vec3(1.0)))) return false;
      if (toHU(texture(uVolume, q).r) > -300.0) return true;
    }
    return false;
  }

  bool enclosed(vec3 uvw) {
    return hitsTissue(uvw, vec3(1.0, 0.0, 0.0)) && hitsTissue(uvw, vec3(-1.0, 0.0, 0.0)) &&
           hitsTissue(uvw, vec3(0.0, 1.0, 0.0)) && hitsTissue(uvw, vec3(0.0, -1.0, 0.0));
  }

  void main() {
    vec3 p = vObj - uShift;
    vec3 uvw = p / (2.0 * uHalf) + 0.5;
    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) discard;
    float hu = toHU(texture(uVolume, uvw).r);
    float id = floor(texture(uLabels, uvw).r * 255.0 + 0.5);

    bool organ = false;
    for (int i = 0; i < 4; i++) organ = organ || (uOrganIds[i] > 0.5 && abs(id - uOrganIds[i]) < 0.5);
    if (uOrganOnly > 0.5 && !organ) discard;
    // Air: the section is the body only. Gas INSIDE the body (bowel, lung)
    // stays as an opaque dark slice like on a CT, rather than a see-through
    // hole into the meshes behind; it counts as inside when tissue lies
    // within reach on all four axial sides.
    if (hu < -420.0 && id < 0.5 && !enclosed(uvw)) discard;

    float g = clamp((hu - (uLevel - uWindow * 0.5)) / uWindow, 0.0, 1.0);
    vec3 col = vec3(g);
    if (id > 0.5) {
      vec3 tint = texture(uPalette, vec2((id + 0.5) / 256.0, 0.5)).rgb;
      float k = abs(id - uTumorId) < 0.5 ? 0.75 : 0.35;
      col = mix(col, tint * (0.55 + 0.6 * g), k);
    }
    fragColor = vec4(col, uOpacity);
  }
`;

interface Part {
  entry: MeshEntry;
  mesh: THREE.Mesh;
  /** The lifted copy, for structures that leave with the resected piece. */
  lifted: THREE.Mesh | null;
  baseEmissive: THREE.Color;
  /** The material's own look, restored when the copilot's focus clears. */
  base: { opacity: number; transparent: boolean; depthWrite: boolean };
  ghosted: boolean;
}

export class AnatomyView {
  readonly group = new THREE.Group();
  private readonly lift = new THREE.Group();
  private parts: Part[] = [];
  private keepPlane = new THREE.Plane();
  private liftPlane = new THREE.Plane();
  private cap: THREE.Mesh;
  private liftCap: THREE.Mesh;
  private capMat: THREE.ShaderMaterial;
  private liftCapMat: THREE.ShaderMaterial;
  private liftT = 0;
  private liftTarget = 0;
  private liftFrom = 0;
  private liftStart = 0;
  hasMeshes = false;
  /** False while the raw CT volume view is on. */
  enabled = true;

  constructor(rig: THREE.Group) {
    rig.add(this.group);
    this.group.add(this.lift);

    const uniforms = () => ({
      uVolume: { value: null as THREE.Data3DTexture | null },
      uLabels: { value: null as THREE.Data3DTexture | null },
      uPalette: { value: null as THREE.Texture | null },
      uHalf: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uCurveU: { value: new THREE.Vector4() },
      uCurveH: { value: new THREE.Vector4() },
      uWindow: { value: 400 },
      uLevel: { value: 40 },
      uShift: { value: new THREE.Vector3() },
      uOrganOnly: { value: 0 },
      uOrganIds: { value: [0, 0, 0, 0] },
      uTumorId: { value: 0 },
      uOpacity: { value: 1 },
    });
    this.capMat = new THREE.ShaderMaterial({
      vertexShader: CAP_VERT, fragmentShader: CAP_FRAG, uniforms: uniforms(), glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide, transparent: true,
    });
    this.liftCapMat = this.capMat.clone();
    this.liftCapMat.uniforms = uniforms();
    this.liftCapMat.uniforms.uOrganOnly.value = 1;
    this.cap = new THREE.Mesh(new THREE.BufferGeometry(), this.capMat);
    this.liftCap = new THREE.Mesh(new THREE.BufferGeometry(), this.liftCapMat);
    this.cap.renderOrder = 1;
    this.liftCap.renderOrder = 1;
    this.group.add(this.cap);
    this.group.add(this.liftCap);
  }

  /** Build every structure's mesh for a newly loaded case. */
  setCase(data: CaseData, f: Frame, tex: { volume: THREE.Data3DTexture; labels: THREE.Data3DTexture; palette: THREE.Texture; curveU: THREE.Vector4; curveH: THREE.Vector4 }): void {
    this.dispose();
    this.hasMeshes = !!data.meshes;
    if (!data.meshes) return;

    // World mm -> object space: the same transform worldToObject applies.
    const s = 1 / f.maxExtent;
    this.group.scale.setScalar(1);
    const byKey = new Map(data.meta.labels.map((l) => [l.key, l]));
    const tumorId = data.meta.labels.find((l) => l.role === 'tumor')?.id ?? 0;
    // Structures that leave with the resected piece: the organ and what is inside it.
    const inner = new Set(['liver', 'tumor', 'hepatic_vessels']);

    const { positions, indices } = data.meshes;
    for (const e of data.meshes.entries) {
      const pos = new Float32Array(e.vertexCount * 3);
      const src = positions.subarray(e.vertexOffset * 3, (e.vertexOffset + e.vertexCount) * 3);
      for (let i = 0; i < src.length; i += 3) {
        pos[i] = (src[i] - f.centerMm[0]) * s;
        pos[i + 1] = (src[i + 1] - f.centerMm[1]) * s;
        pos[i + 2] = (src[i + 2] - f.centerMm[2]) * s;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(new THREE.BufferAttribute(indices.slice(e.indexOffset, e.indexOffset + e.indexCount), 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();

      const label = byKey.get(e.key);
      const mat = materialFor(e.key, label, data.meta.kind);
      mat.clippingPlanes = [this.keepPlane];
      mat.clipShadows = false;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = e.key === 'skin' ? 5 : mat.transparent ? 3 : 0;
      this.group.add(mesh);

      let lifted: THREE.Mesh | null = null;
      if (data.meta.kind === 'liver' && inner.has(e.key)) {
        const lm = mat.clone();
        lm.clippingPlanes = [this.liftPlane];
        if (mat.onBeforeCompile) lm.onBeforeCompile = mat.onBeforeCompile;
        lm.customProgramCacheKey = mat.customProgramCacheKey;
        lifted = new THREE.Mesh(geo, lm);
        lifted.renderOrder = mesh.renderOrder;
        lifted.visible = false;
        this.lift.add(lifted);
      }
      this.parts.push({
        entry: e, mesh, lifted, baseEmissive: mat.emissive.clone(),
        base: { opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite },
        ghosted: false,
      });
    }

    // The lifted piece's face shows only what actually leaves: organ, tumour, its vessels.
    const organIds = ['liver', 'tumor', 'hepatic_vessels'].map((k) => byKey.get(k)?.id ?? 0).concat([0]);
    for (const m of [this.capMat, this.liftCapMat]) {
      const u = m.uniforms;
      u.uVolume.value = tex.volume;
      u.uLabels.value = tex.labels;
      u.uPalette.value = tex.palette;
      u.uHalf.value.set(...f.half);
      u.uCurveU.value.copy(tex.curveU);
      u.uCurveH.value.copy(tex.curveH);
      u.uTumorId.value = tumorId;
      u.uOrganIds.value = organIds;
    }
  }

  /**
   * Add one structure found after load (a VISTA-3D point prompt): its surface
   * in world mm, drawn like the pipeline's meshes and cut by the same plane.
   */
  addStructure(label: LabelDef, positionsMm: Float32Array, indices: Uint32Array, f: Frame, kind: string): void {
    const s = 1 / f.maxExtent;
    const pos = new Float32Array(positionsMm.length);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = (positionsMm[i] - f.centerMm[0]) * s;
      pos[i + 1] = (positionsMm[i + 1] - f.centerMm[1]) * s;
      pos[i + 2] = (positionsMm[i + 2] - f.centerMm[2]) * s;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mat = materialFor(label.key, label, kind);
    mat.clippingPlanes = [this.keepPlane];
    mat.clipShadows = false;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = mat.transparent ? 3 : 0;
    this.group.add(mesh);
    this.parts.push({
      entry: { key: label.key, label: label.id, vertexOffset: 0, vertexCount: pos.length / 3, indexOffset: 0, indexCount: indices.length },
      mesh, lifted: null, baseEmissive: mat.emissive.clone(),
      base: { opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite },
      ghosted: false,
    });
  }

  dispose(): void {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
      this.group.remove(p.mesh);
      if (p.lifted) {
        (p.lifted.material as THREE.Material).dispose();
        this.lift.remove(p.lifted);
      }
    }
    this.parts = [];
    this.liftT = this.liftTarget = 0;
  }

  /** Per frame: visibility, highlight pulse, clipping, cap, lift animation. */
  update(f: Frame, highlight: number, time: number): void {
    this.group.visible = this.hasMeshes && this.enabled;
    if (!this.group.visible) return;
    const patient = state.mode === 'patient';
    const preset = state.preset;
    const planeOn = state.plane.on && !patient;

    // Lift the resected piece while the cut is locked.
    const wantLift = planeOn && state.plane.locked && state.data?.meta.kind === 'liver' ? 1 : 0;
    if (wantLift !== this.liftTarget) {
      this.liftFrom = this.liftT;
      this.liftTarget = wantLift;
      this.liftStart = performance.now();
    }
    this.liftT = this.liftFrom + (this.liftTarget - this.liftFrom) *
      easeInOut(clamp((performance.now() - this.liftStart) / LIFT_MS, 0, 1));

    // Clip planes in object space: keep n.x - d <= 0, the piece keeps the rest.
    const n = new THREE.Vector3(...state.plane.n).normalize();
    const dObj = (state.plane.d - (n.x * f.centerMm[0] + n.y * f.centerMm[1] + n.z * f.centerMm[2])) / f.maxExtent;
    const shift = n.clone().multiplyScalar((this.liftT * LIFT_MM) / f.maxExtent);
    if (planeOn) {
      this.keepPlane.set(n.clone().negate(), dObj);
      this.liftPlane.set(n, -dObj - n.dot(shift));
    } else {
      // Plane off: a plane far outside the volume clips nothing.
      this.keepPlane.set(new THREE.Vector3(0, 0, 1), 1e6);
      this.liftPlane.set(new THREE.Vector3(0, 0, 1), -1e6);
    }
    this.lift.position.copy(shift);
    const lifting = this.liftT > 0.001;

    const pulse = 0.5 + 0.5 * Math.sin(time * 4.2);
    for (const p of this.parts) {
      const key = p.entry.key;
      let visible: boolean;
      if (key === 'skin') visible = !patient && preset !== 'bone' && state.visible.skin !== false;
      else if (key === 'bone') visible = !patient && state.visible.bone !== false;
      else visible = state.visible[key] !== false;
      p.mesh.visible = visible;
      // While cutting, the piece to be removed is a faint ghost with the tumour
      // solid inside it; once locked it lifts away and turns solid.
      if (p.lifted) p.lifted.visible = visible && planeOn && !state.viewSection;

      const mat = p.mesh.material as THREE.MeshPhysicalMaterial;
      // Copilot focus: the structures asked about glow in their own colours,
      // everything else fades to a ghost so they read through the liver.
      const focus = state.focus;
      const inFocus = focus.length > 0 && focus.includes(p.entry.label);
      const ghost = focus.length > 0 && !inFocus && !patient;
      if (ghost !== p.ghosted) {
        p.ghosted = ghost;
        mat.transparent = ghost || p.base.transparent;
        mat.depthWrite = ghost ? false : p.base.depthWrite;
        mat.needsUpdate = true;
      }
      const hl = (highlight > 0 && p.entry.label === highlight) || inFocus;
      mat.emissive.copy(p.baseEmissive);
      if (hl) mat.emissive.lerp(new THREE.Color(...(state.data?.meta.labels.find((l) => l.id === p.entry.label)?.color ?? [1, 1, 1])), 0.35 + 0.45 * pulse);
      mat.opacity = ghost ? (key === 'bone' ? 0.1 : 0.08) : p.base.opacity;
      if (key === 'skin') mat.opacity = patient || ghost ? 0 : 0.55;
      if (key === 'bone') mat.color.setHex(preset === 'bone' ? 0xfff6e2 : 0xe8dfcc);
      if (p.lifted) {
        const lm = p.lifted.material as THREE.MeshPhysicalMaterial;
        lm.emissive.copy(mat.emissive);
        if (key === 'liver') lm.opacity = 0.16 + (mat.opacity - 0.16) * this.liftT;
        if (key === 'hepatic_vessels') {
          lm.transparent = true;
          lm.opacity = 0.35 + 0.65 * this.liftT;
        }
      }
    }

    // The CT section on the cut face, and on the lifted piece's face.
    this.cap.visible = planeOn;
    this.liftCap.visible = lifting;
    if (planeOn) {
      const poly = planeBoxPolygon(f, state.plane as Plane);
      setPolygon(this.cap.geometry, poly, f, [0, 0, 0]);
      setPolygon(this.liftCap.geometry, poly, f, [shift.x, shift.y, shift.z]);
      for (const m of [this.capMat, this.liftCapMat]) {
        m.uniforms.uWindow.value = state.windowLevel.w;
        m.uniforms.uLevel.value = state.windowLevel.l;
      }
      this.liftCapMat.uniforms.uShift.value.copy(shift);
      // Nudge the caps a hair onto the kept/lifted side so they never z-fight the clip.
      this.cap.position.copy(n).multiplyScalar(-0.0004);
      this.liftCap.position.copy(n).multiplyScalar(0.0004);
    }
  }
}

function setPolygon(geo: THREE.BufferGeometry, poly: Vec3[], f: Frame, shiftObj: Vec3): void {
  if (poly.length < 3) {
    geo.setDrawRange(0, 0);
    return;
  }
  const pts: number[] = [];
  const o = (p: Vec3): number[] => [
    (p[0] - f.centerMm[0]) / f.maxExtent + shiftObj[0],
    (p[1] - f.centerMm[1]) / f.maxExtent + shiftObj[1],
    (p[2] - f.centerMm[2]) / f.maxExtent + shiftObj[2],
  ];
  // Triangle fan around the (convex) polygon.
  const a = o(poly[0]);
  for (let i = 1; i < poly.length - 1; i++) pts.push(...a, ...o(poly[i]), ...o(poly[i + 1]));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  geo.setDrawRange(0, pts.length / 3);
  geo.computeBoundingSphere();
}
