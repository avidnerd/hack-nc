/** Shared vocabulary for the whole app. Nothing in here imports anything. */

export type Vec3 = [number, number, number];

/** A structure present in the packed label volume. `id` is the voxel byte value. */
export interface LabelDef {
  id: number;
  /** Stable machine key used by voice commands and visibility toggles. */
  key: string;
  /** Human name spoken by the narrator and shown in the HUD. */
  name: string;
  /** Base RGB in 0..1, used for label tints in the ray-marcher. */
  color: Vec3;
  /**
   * How the planning engine treats this structure.
   *   organ   - the resection target; drives remnant %
   *   tumor   - drives margin; always rendered opaque
   *   vessel  - counted by "vessels crossed"; drives proximity glow
   *   context - drawn but never measured (bone, kidney, skin)
   */
  role: 'organ' | 'tumor' | 'vessel' | 'context';
}

export interface WindowLevel {
  /** Window width in HU. */
  w: number;
  /** Window centre in HU. */
  l: number;
}

export type PresetName = 'soft' | 'bone' | 'lung' | 'liver';

/** Ground-truth numbers emitted by the Python pipeline, used by vitest. */
export interface CaseTruth {
  organVolumeMl: number;
  tumorVolumeMl: number;
  tumorCentroidMm: Vec3;
  /** A fixed plane and the numbers numpy computes for it. */
  testPlane: { n: Vec3; d: number };
  testRemnantPct: number;
  testMarginMm: number;
  testVesselsCrossed: number;
}

export interface CaseMeta {
  /** Directory name under public/data. */
  id: string;
  name: string;
  /** Which demo moments this case serves. */
  kind: 'liver' | 'aorta' | 'scan';
  /** Grid dimensions [nx, ny, nz] of volume.u8 and labels.u8. */
  shape: Vec3;
  /** Millimetres per voxel along each axis. */
  spacing: Vec3;
  /** World-space mm position of voxel (0,0,0) centre. */
  origin: Vec3;
  /** The HU interval the uint8 ramp spans, [min, max]. */
  huRange: [number, number];
  /**
   * Piecewise-linear uint8 -> HU curve, as four [u8, HU] breakpoints.
   *
   * A linear ramp over [-1000, 2000] HU would leave the liver window (W150)
   * only about 13 distinct byte values, which bands visibly. This curve spends
   * most of the byte range on soft tissue and compresses air and bone, where
   * coarse steps are indistinguishable. The shader inverts the same curve.
   */
  huCurve: [number, number][];
  labels: LabelDef[];
  /** Label ids the planning engine counts as vessels to avoid. */
  vesselIds: number[];
  windowPresets: Record<PresetName, WindowLevel>;
  defaultPreset: PresetName;
  /** Present only when the pipeline computed ground truth for this case. */
  truth?: CaseTruth;
  /** Which centerline (if any) devices snap to. */
  centerline?: string;
}

/** One resampled sample along a vessel centerline, in world mm. */
export interface CenterlinePoint {
  p: Vec3;
  /** Lumen radius in mm at this point (distance transform of the mask). */
  r: number;
  /** Unit tangent. */
  t: Vec3;
}

export interface CenterlineData {
  /** Keyed by vessel name, e.g. "aorta". */
  vessels: Record<string, CenterlinePoint[]>;
  /**
   * Approximated renal artery origins: the centerline point nearest each
   * kidney hilum. See README "Limitations".
   */
  renalOstia: { p: Vec3; side: 'left' | 'right' }[];
}

/** Everything the renderer needs, decoded and ready for GPU upload. */
export interface CaseData {
  meta: CaseMeta;
  /** Length = shape.x*shape.y*shape.z, windowed CT intensity. */
  volume: Uint8Array;
  /** Same length, one label id per voxel (0 = background). */
  labels: Uint8Array;
  centerlines: CenterlineData | null;
  /** Surface meshes for the anatomy view; null falls back to volume rendering. */
  meshes: MeshSet | null;
}

/** One structure's surface inside meshes.bin, as written by pipeline/meshes.py. */
export interface MeshEntry {
  /** Label key, or "skin" / "bone" for the CT-derived context surfaces. */
  key: string;
  /** Label id, 0 for skin and bone. */
  label: number;
  vertexOffset: number;
  vertexCount: number;
  indexOffset: number;
  indexCount: number;
}

export interface MeshSet {
  entries: MeshEntry[];
  /** xyz in world mm, all structures back to back. */
  positions: Float32Array;
  indices: Uint32Array;
}

/** App-level pose. OPEN cuts, PINCH rotates (two hands: zoom), FIST locks. */
export type Pose = 'IDLE' | 'OPEN' | 'PINCH' | 'CALIPER' | 'FIST' | 'LOST';

/** A plane in world mm: points x with dot(n,x) - d > 0 are resected. */
export interface Plane {
  n: Vec3;
  d: number;
}

/** Output of the deterministic planning engine. Every field is shown somewhere. */
export interface PlanMetrics {
  /** Kept organ voxels / total organ voxels * 100. */
  remnantPct: number;
  /** Resected-side organ volume in mL. */
  resectedMl: number;
  /** Kept organ volume minus any kept tumor, in mL. */
  healthyRemnantMl: number;
  /** Min distance from the cut surface to tumor, in mm. 0 if tumor is kept. */
  marginMm: number;
  /** True when any tumor voxel sits on the kept side. */
  tumorIncomplete: boolean;
  /** Cut-surface point and nearest tumour point of that margin, world mm. */
  marginPath?: [Vec3, Vec3] | null;
  /** Connected components of vessel voxels straddling the plane. */
  vesselsCrossed: number;
  /** Where the cut divides each counted vessel (world mm, label id). */
  vesselCuts?: { p: Vec3; id: number }[];
  /** Name of the largest-radius crossed vessel, or null. */
  vesselName: string | null;
  /** Its label id (0 when none); that structure glows while it is crossed. */
  vesselId: number;
  /** Distance to the nearest vessel from the cut surface, mm. */
  nearestVesselMm: number;
  /** Label id of that vessel; it glows when closer than 5 mm. */
  nearestVesselId: number;
}

export interface StentState {
  /** Arc-length position of the proximal end along the centerline, mm. */
  s0: number;
  lengthMm: number;
  diameterMm: number;
  /** Proximal neck length in mm; must be >= 10 to seal. */
  neckMm: number;
  /** Percent oversize vs. native lumen; must be 10..20. */
  oversizePct: number;
  /** Neck angulation in degrees; must be < 60. */
  angulationDeg: number;
  seals: boolean;
  /** "Seals." or "Won't seal: <reason>". */
  verdict: string;
  /** Plain-words reason for the first failed rule, for the voice line. */
  failReason: string | null;
}

export interface Thresholds {
  marginMin: number;
  remnantMin: number;
  vesselPenalty: 'hard' | 'soft';
}
