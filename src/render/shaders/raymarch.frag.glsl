// Scrub+ volume ray-marcher — fragment stage.
//
// One ray per pixel, front-to-back emission/absorption integration over the CT
// volume, with the segmentation label volume sampled alongside it so individual
// structures can be tinted, hidden, or forced opaque independently of the CT
// transfer function. A cutting plane removes everything on its positive side
// and leaves a lit edge on the cut surface so the result reads as an incision
// rather than as missing data.

precision highp float;
precision highp sampler3D;

// GLSL ES 3.00: three.js does not provide the gl_FragColor compatibility
// define on its GLSL3 path, so declare the stage inputs and output explicitly.
in vec3 vObjPos;
in vec3 vCamObj;

layout(location = 0) out vec4 fragColor;

// --- volume data ----------------------------------------------------------
uniform sampler3D uVolume;   // windowed CT, R8
uniform sampler3D uLabels;   // packed label ids, R8, NEAREST
uniform sampler2D uTransfer; // 256x1 RGBA opacity/colour ramp
uniform sampler2D uPalette;  // 256x1 RGBA per-label tint; a = opacity scale

// Half-extent of the box in object space (proportional to real millimetres).
uniform vec3 uHalf;

// --- windowing ------------------------------------------------------------
// The uint8 samples follow a piecewise-linear HU curve rather than a flat ramp,
// so most of the byte range sits on soft tissue. uCurveU holds the four
// breakpoints in 0..1 texture units, uCurveH the matching HU values.
uniform vec4 uCurveU;
uniform vec4 uCurveH;
uniform float uWindow;   // window width in HU
uniform float uLevel;    // window centre in HU

// --- marching -------------------------------------------------------------
uniform int uSteps;
uniform float uDensity;  // global opacity scale
uniform float uJitter;   // 0..1, dithers ray starts to kill banding

// --- cutting plane --------------------------------------------------------
uniform vec3 uPlaneN;    // normal in object space (not normalised)
uniform float uPlaneD;
uniform bool uPlaneOn;

// --- highlighting ---------------------------------------------------------
uniform float uHighlight;  // label id to pulse, 0 = none
uniform float uTumorId;    // tumour label id, ghosted beyond the cut; 0 = none
uniform float uPulse;      // 0..1 animated
uniform float uTime;

// --- presentation ---------------------------------------------------------
uniform float uPatient;   // 0 = surgeon, 1 = patient mode (soft + simplified)
uniform float uLabelBoost; // extra opacity for labelled structures

const float REF_STEP = 1.0 / 256.0;  // step size the opacity ramp is tuned for

// Intersect a ray with the axis-aligned box [-uHalf, uHalf].
// Returns false when the ray misses entirely.
bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 inv = 1.0 / rd;
  vec3 a = (-uHalf - ro) * inv;
  vec3 b = (uHalf - ro) * inv;
  vec3 lo = min(a, b);
  vec3 hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z);
  t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}

vec3 toUVW(vec3 p) {
  return p / (2.0 * uHalf) + 0.5;
}

// Invert the piecewise encoding curve: stored byte -> Hounsfield units.
float toHU(float v) {
  if (v <= uCurveU.y) {
    return mix(uCurveH.x, uCurveH.y,
               (v - uCurveU.x) / max(uCurveU.y - uCurveU.x, 1e-6));
  }
  if (v <= uCurveU.z) {
    return mix(uCurveH.y, uCurveH.z,
               (v - uCurveU.y) / max(uCurveU.z - uCurveU.y, 1e-6));
  }
  return mix(uCurveH.z, uCurveH.w,
             (v - uCurveU.z) / max(uCurveU.w - uCurveU.z, 1e-6));
}

// Map a raw uint8 sample onto 0..1 across the current window/level.
float windowed(float raw) {
  float hu = toHU(raw);
  return clamp((hu - (uLevel - uWindow * 0.5)) / max(uWindow, 1.0), 0.0, 1.0);
}

float rawAt(vec3 uvw) {
  return texture(uVolume, uvw).r;
}

float labelAt(vec3 uvw) {
  // Label ids are stored as id/255 in an R8 texture sampled NEAREST.
  return floor(texture(uLabels, uvw).r * 255.0 + 0.5);
}

// Central-difference gradient of the windowed intensity, used as a surface
// normal for shading. Six extra fetches, so only called where a sample
// actually contributes.
vec3 gradient(vec3 uvw, float h) {
  vec3 dx = vec3(h, 0.0, 0.0);
  vec3 dy = vec3(0.0, h, 0.0);
  vec3 dz = vec3(0.0, 0.0, h);
  return vec3(
    windowed(rawAt(uvw + dx)) - windowed(rawAt(uvw - dx)),
    windowed(rawAt(uvw + dy)) - windowed(rawAt(uvw - dy)),
    windowed(rawAt(uvw + dz)) - windowed(rawAt(uvw - dz))
  );
}

// Cheap integer hash for per-pixel jitter.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 ro = vCamObj;
  vec3 rd = normalize(vObjPos - vCamObj);

  float t0, t1;
  if (!boxHit(ro, rd, t0, t1)) discard;
  t0 = max(t0, 0.0);

  float span = t1 - t0;
  float dt = span / float(uSteps);

  // Offsetting each ray's start by a fraction of a step turns the
  // characteristic wood-grain banding into fine noise.
  float t = t0 + dt * hash(gl_FragCoord.xy + uTime) * uJitter;

  // Opacity has to be rescaled whenever the step size differs from the one the
  // ramp was authored against, or the volume gets denser as we lower quality.
  float stepScale = dt / REF_STEP;

  vec3 light = normalize(vec3(0.35, 0.55, 1.0)); // headlight, slightly above
  float texelH = 1.0 / 256.0;

  vec4 acc = vec4(0.0);
  float firstHit = -1.0;

  for (int i = 0; i < 1024; i++) {
    if (i >= uSteps || t > t1 || acc.a > 0.97) break;

    vec3 p = ro + rd * t;

    // --- cutting plane -----------------------------------------------------
    float sd = dot(uPlaneN, p) - uPlaneD;
    if (uPlaneOn && sd > 0.0) {
      // The resected side vanishes, except the tumour: it stays as a faint
      // ghost so the surgeon can see what the margin is measured to.
      if (uTumorId > 0.5 && abs(labelAt(toUVW(p)) - uTumorId) < 0.5) {
        float ga = 1.0 - pow(1.0 - 0.08, stepScale);
        acc.rgb += (1.0 - acc.a) * vec3(1.0, 0.42, 0.26) * ga;
        acc.a += (1.0 - acc.a) * ga;
      }
      t += dt;
      continue;
    }

    vec3 uvw = toUVW(p);
    float raw = rawAt(uvw);
    float id = labelAt(uvw);

    vec4 lab = texture(uPalette, vec2((id + 0.5) / 256.0, 0.5));
    bool labelled = id > 0.5;

    // A structure switched off in the HUD is skipped entirely, and so is the
    // raw CT inside it, so hiding skin really does reveal what is underneath.
    if (labelled && lab.a < 0.004) {
      t += dt;
      continue;
    }

    float inten = windowed(raw);
    vec4 tf = texture(uTransfer, vec2(inten, 0.5));

    vec3 col = tf.rgb;
    float alpha = tf.a;

    bool isTarget = uHighlight > 0.5 && abs(id - uHighlight) < 0.5;

    if (labelled) {
      // A labelled structure takes its colour and its per-step opacity from
      // the palette outright, rather than max()-ing against the CT ramp. The
      // palette is authored so that the organ stays translucent enough to see
      // a tumour through it, which is the whole point of the view; deriving
      // opacity from the CT instead would make the parenchyma opaque and bury
      // the lesion.
      col = mix(col, lab.rgb, 0.85);
      alpha = lab.a * uLabelBoost;

      if (isTarget) {
        // The pulse brightens rather than changing hue, so the structure stays
        // recognisable while it draws attention.
        col += lab.rgb * uPulse * 0.8;
        alpha = min(1.0, alpha * (2.4 + uPulse));
      }
    }

    // Asking to see one structure means seeing it, so everything else steps
    // back. Without this the liver simply hides the tumour inside it.
    if (uHighlight > 0.5 && !isTarget) alpha *= 0.3;

    // In patient mode unlabelled tissue becomes a faint translucent shell and
    // the named structures carry the whole picture.
    alpha *= mix(1.0, labelled ? 1.15 : 0.18, uPatient);

    // A CT is a slab, so the scan ends mid-torso and the volume's faces cut
    // through solid tissue. Left alone those faces integrate into flat grey
    // cards that read as a rendering bug. Fading tissue that lies flush
    // against a face dissolves them while leaving the interior untouched.
    vec3 q = abs(p) / uHalf;
    alpha *= 1.0 - smoothstep(0.88, 1.0, max(max(q.x, q.y), q.z));

    if (alpha > 0.002) {
      if (firstHit < 0.0) firstHit = t;

      // --- shading --------------------------------------------------------
      vec3 g = gradient(uvw, texelH);
      float gm = length(g);
      if (gm > 0.0008) {
        vec3 n = g / gm;
        float diff = abs(dot(n, light));          // two-sided: tissue has no
                                                  // meaningful inside/outside
        float rim = pow(1.0 - abs(dot(n, -rd)), 2.5);
        // Strong gradients are real surfaces and earn full shading; soft
        // gradients stay flat so homogeneous tissue does not look blotchy.
        float surf = smoothstep(0.002, 0.03, gm);
        float shade = mix(1.0, 0.34 + 0.9 * diff, surf);
        col *= shade;
        col += vec3(0.30, 0.52, 0.62) * rim * surf * 0.55 * (1.0 - uPatient * 0.5);
      }

      // --- cut-surface edge ----------------------------------------------
      // Everything within roughly one step of the plane glows, which draws the
      // bright line across the cut face that makes the slice read as an
      // incision.
      if (uPlaneOn) {
        // The edge is a fixed PHYSICAL thickness, not a fixed number of
        // steps: uPlaneN carries the mm scale, so sd is already in
        // millimetres. Tying it to the step count instead would make the
        // incision line fatten every time the adaptive renderer drops
        // quality. It still widens to one step when steps are coarse, or it
        // would alias away to nothing.
        float stepMm = dt * length(uPlaneN);
        float edgeMm = max(1.6, stepMm);
        float edge = 1.0 - smoothstep(0.0, edgeMm, abs(sd));
        if (edge > 0.0) {
          col = mix(col, vec3(0.70, 1.0, 0.95), edge * 0.8);
          alpha = max(alpha, edge * 0.5);
        }
      }

      float a = 1.0 - pow(max(1.0 - alpha * uDensity, 0.0), stepScale);
      acc.rgb += (1.0 - acc.a) * col * a;
      acc.a += (1.0 - acc.a) * a;
    }

    t += dt;
  }

  if (acc.a < 0.004) discard;

  // Mild filmic shoulder: keeps dense bone from clipping to flat white.
  acc.rgb = acc.rgb / (acc.rgb + 0.86) * 1.72;

  fragColor = vec4(acc.rgb, acc.a);
}
