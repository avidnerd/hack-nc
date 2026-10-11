/**
 * Every hand-tracking threshold in one place, so the gesture layer can be
 * tuned against a real camera without hunting through logic.
 *
 * Landmark indices follow MediaPipe's hand model:
 *   0 wrist · 4 thumb tip · 5 index MCP · 8 index tip · 9 middle MCP
 *   12 middle tip · 13 ring MCP · 16 ring tip · 17 pinky MCP · 20 pinky tip
 */

export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_TIP: 20,
} as const;

/** The four non-thumb fingers, as [tip, mcp] pairs for the extension test. */
export const FINGERS: readonly [number, number][] = [
  [LM.INDEX_TIP, LM.INDEX_MCP],
  [LM.MIDDLE_TIP, LM.MIDDLE_MCP],
  [LM.RING_TIP, LM.RING_MCP],
  [LM.PINKY_TIP, LM.PINKY_MCP],
];

export const TUNING = {
  /**
   * MediaPipe confidences. Tracking sits below detection so a hand already
   * being followed survives gloves and motion blur instead of dropping back
   * to the slower full-frame palm search.
   */
  detection: { detect: 0.5, presence: 0.4, tracking: 0.3 },
  /** If camera frame callbacks stop for this long, detection runs from the render loop. */
  detectStallMs: 120,
  /** A hand missing for up to this long keeps its last reading (bridges detector dropouts). */
  coastMs: 120,
  /** How long a hand's last position is remembered for keeping left/right identities. */
  handMemoryMs: 400,
  /** A lone hand within this distance (image heights) of the other hand's last spot keeps that hand's label. */
  sideSwapMaxDist: 0.25,

  /** A finger counts as extended when tip-to-wrist exceeds this × MCP-to-wrist. */
  extendRatio: 1.6,

  /** pinchDist / handSize below this is a pinch. */
  pinchOn: 0.25,
  /** Hysteresis: a pinch only releases above this, so it does not flicker. */
  pinchOff: 0.34,
  /** pinchDist / handSize above this is required for OPEN. */
  openPinchMin: 0.5,
  /**
   * Index-tip-to-wrist over hand size must exceed this for a pinch. In a fist
   * the thumb and index tip also touch, but the index tip sits by the palm.
   */
  pinchReachMin: 1.1,

  /** A palm within this many degrees of the camera axis counts as facing it (feature only). */
  palmFacingDeg: 35,

  /** A pose must persist this long before it takes effect. */
  dwellMs: 150,
  /** ...or only this long when the gesture network's look-ahead predicted it. */
  dwellPredictedMs: 60,
  /** No hands for this long freezes the scene. */
  lostMs: 300,

  /** 1 euro filter on raw landmarks. */
  landmarkFilter: { minCutoff: 1.0, beta: 0.02, dCutoff: 1.0 },
  /** A slower filter on the derived plane normal; jitter here is very visible. */
  normalFilter: { minCutoff: 0.6, beta: 0.01, dCutoff: 1.0 },
  /** Depth proxy is noisy, so it gets the heaviest smoothing of all. */
  depthFilter: { minCutoff: 0.5, beta: 0.004, dCutoff: 1.0 },

  /** One screen width of palm travel equals this much rotation (at normal speed). */
  rotationPerScreen: Math.PI,
  /**
   * Velocity-driven rotation: this much motion (normalised units/frame) is
   * subtracted from every move as tremor, so a held hand does not drift the
   * volume. Soft, not a cut-off: motion just above it turns the body a
   * little rather than jumping in.
   */
  rotationDeadzone: 0.0016,
  /** Weight of the newest frame in the smoothed rotation velocity (0..1). */
  rotationSmoothing: 0.7,
  /**
   * Speed-dependent gain: slow moves turn at `rotationSlowGain` x for fine
   * positioning, rising to `rotationFastGain` x at `rotationFastSpeed`
   * (units/frame) so a quick sweep turns the body round without leaving the
   * camera's view.
   */
  rotationSlowGain: 0.6,
  rotationFastGain: 1.6,
  rotationFastSpeed: 0.03,
  /** A released grab keeps spinning only if it was moving faster than this (rad/frame). */
  flingMin: 0.012,
  /** Per-frame decay applied to rotation velocity when the hand stops. */
  rotationDamping: 0.86,

  /** Two-hand zoom: camera distance scales as (start gap / gap) ^ zoomGain. */
  zoomGain: 1.0,
  zoomMin: 0.9,
  zoomMax: 4.5,
  /** Share of the remaining zoom distance covered each frame (eases out jitter). */
  zoomEase: 0.45,

  /** Depth proxy: offset = clamp(k * log(hs / hs at hand-open), -0.5, 0.5) * extent. */
  depthGain: 0.8,
  depthClamp: 0.5,

  /** Palm travel across the full camera width moves the plane this many volume extents. */
  planeSpan: 1.0,
  /** Opening the hand eases the existing cut over to the palm's over this long, instead of snapping. */
  cutBlendMs: 260,
  /** Plane changes smaller than this (degrees / mm) are not applied: a still hand gives a still cut. */
  cutHoldDeg: 0.25,
  cutHoldMm: 0.3,

  /** Screen-space radius (px) within which a pinch grabs the stent. */
  stentGrabPx: 90,
} as const;

/** Rows for the `?` overlay. Kept beside the thresholds they describe. */
export const GESTURE_HELP: [string, string][] = [
  ['open hand', 'cut: the plane follows your palm, under your hand'],
  ['pinch + drag', 'rotate (or drag a placed stent)'],
  ['two pinches', 'zoom: pull apart / push together'],
  ['two index fingers', 'caliper: live distance in mm'],
  ['fist', 'lock the cut (the piece lifts away) / unlock'],
];
