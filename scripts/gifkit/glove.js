/**
 * In-page overlay for scripts/gesture-gifs.ts: a camera-feed inset showing a
 * real surgical-glove model posed from the same 21 landmarks the app is fed.
 *
 * The model ("Realistic Surgical Glove with Folds Texture" by Jingfu Chen,
 * CC BY 4.0, scripts/gifkit/glove-model) is a static mesh with no skeleton,
 * so it is rigged here:
 *
 *   1. REST holds the 21 joints of a MediaPipe hand fitted inside the mesh
 *      (fingers from vertex clusters and cross-section centres; webs and
 *      thumb read off a 2 cm grid render).
 *   2. One bone per landmark, parented along the hand's chains. Each vertex
 *      is skinned to the bones whose segments it lies nearest, falling off
 *      with distance, so knuckles and webs bend smoothly.
 *   3. Per frame, the wrist bone takes the palm's frame (wrist, index and
 *      pinky knuckles) and every other bone turns its segment toward the
 *      matching landmark segment. Only directions are copied, never lengths,
 *      so the glove keeps its own proportions.
 *
 * The model is a left glove. A hand of the other chirality is drawn by
 * mirroring the glove and solving in the mirrored space.
 *
 * Served by the capture script at /__gif/glove.js; three.js and its loaders
 * come from the app's node_modules at /__gif/three/. Rendering is explicit
 * (draw() renders synchronously) because the page's requestAnimationFrame is
 * under Playwright's fake clock.
 */

import * as THREE from '/__gif/three/build/three.module.js';
import { RoomEnvironment } from '/__gif/three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from '/__gif/three/examples/jsm/loaders/GLTFLoader.js';

const W = 300;
const H = 210;

/** Joint positions in the model's own space, MediaPipe order. */
const REST = [
  [-0.075, 0.0015, -0.0094],
  [-0.04, -0.008, 0.03], [-0.017, -0.02, 0.05], [-0.001, -0.034, 0.066], [0.012, -0.048, 0.081],
  [0.032, 0.0293, 0.0284], [0.0739, 0.0345, 0.0279], [0.0994, 0.0369, 0.0336], [0.1231, 0.0374, 0.0363],
  [0.035, 0.0293, 0.0009], [0.0846, 0.0371, -0.0039], [0.1148, 0.0369, -0.0021], [0.1429, 0.0372, -0.0004],
  [0.0335, 0.031, -0.0349], [0.0791, 0.0339, -0.0347], [0.1068, 0.0329, -0.0362], [0.1325, 0.033, -0.0351],
  [0.029, 0.0264, -0.0714], [0.065, 0.0266, -0.0674], [0.0869, 0.027, -0.0661], [0.1073, 0.0269, -0.0672],
].map((p) => new THREE.Vector3(...p));

/** Bone parent per landmark; -1 is the root (the wrist). */
const PARENT = [-1, 0, 1, 2, 3, 0, 5, 6, 7, 0, 9, 10, 11, 0, 13, 14, 15, 0, 17, 18, 19];
const CHILD = PARENT.map((_, i) => PARENT.indexOf(i));
/** In the rest pose the palm faces -y (the back of the glove faces +y). */
const REST_PALM = new THREE.Vector3(0, -1, 0);

/* ------------------------------------------------------------------ the card */

const card = document.createElement('div');
card.id = 'gifcard';
card.innerHTML = `
  <div class="bar"><span class="live"></span><span class="feed">INPUT</span><span class="side"></span></div>
  <div class="view"><canvas></canvas><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i></div>
  <div class="t"></div><div class="s"></div><div class="v"></div>`;
document.body.appendChild(card);

const css = document.createElement('style');
css.textContent = `
  #gifcard { position: fixed; left: 16px; top: 60px; width: ${W + 20}px; z-index: 99999;
    background: #0a1a2c; border: 1px solid #2b4b6e; border-radius: 6px;
    padding: 8px 10px 12px; color: #e6eef6; font-family: 'Inter Tight', system-ui, sans-serif; }
  #gifcard .bar { display: flex; align-items: center; gap: 7px; font: 500 10.5px 'IBM Plex Mono', monospace;
    letter-spacing: 0.1em; color: #8fb0cf; margin-bottom: 7px; }
  #gifcard .live { width: 6px; height: 6px; border-radius: 50%; background: #4fe3c1; }
  #gifcard .side { margin-left: auto; color: #e6eef6; }
  #gifcard .view { position: relative; width: ${W}px; height: ${H}px; border-radius: 3px; overflow: hidden;
    background: radial-gradient(ellipse at 50% 30%, #1b3a5c 0%, #0b1a2b 75%); }
  #gifcard canvas { display: block; width: ${W}px; height: ${H}px; }
  #gifcard .c { position: absolute; width: 12px; height: 12px; border: 0 solid #5f86ab; }
  #gifcard .tl { left: 6px; top: 6px; border-left-width: 1.5px; border-top-width: 1.5px; }
  #gifcard .tr { right: 6px; top: 6px; border-right-width: 1.5px; border-top-width: 1.5px; }
  #gifcard .bl { left: 6px; bottom: 6px; border-left-width: 1.5px; border-bottom-width: 1.5px; }
  #gifcard .br { right: 6px; bottom: 6px; border-right-width: 1.5px; border-bottom-width: 1.5px; }
  #gifcard .t { font-weight: 600; font-size: 17px; margin-top: 10px; letter-spacing: -0.01em; }
  #gifcard .s { font-size: 13px; color: #a9bfd4; margin-top: 3px; line-height: 1.35; }
  #gifcard .v { font: 500 13.5px 'IBM Plex Mono', monospace; margin-top: 9px; color: #4fe3c1; }
  #gifcard .v:empty { display: none; }
  #gifcard .v::before { content: '\\25B8  '; color: #8fb0cf; }
  #gifcard.voice .view { display: none; }
  #banner { display: none !important; }
  /* No camera in headless Chrome: the inset shows the hands instead. */
  #camwrap { display: none !important; }`;
document.head.appendChild(css);

// The replay harness announces itself; that toast is about the harness, not the app.
new MutationObserver(() => {
  for (const t of document.querySelectorAll('#toasts .toast')) if (/recorded demo/i.test(t.textContent)) t.remove();
}).observe(document.getElementById('toasts'), { childList: true });

/* ----------------------------------------------------------------- the scene */

const canvas = card.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// A soft studio environment for the nitrile's sheen.
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const camera = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, -2000, 2000);
camera.position.set(0, 0, 1000);

scene.add(new THREE.HemisphereLight(0xdcecff, 0x1a2a3c, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(-0.5, 0.9, 1);
scene.add(key);
// A cool rim from behind, like the edge light off a surgical lamp.
const rim = new THREE.DirectionalLight(0x8fe8ff, 1.8);
rim.position.set(0.6, 0.2, -1);
scene.add(rim);

/* ---------------------------------------------------------------- the rig */

function segmentDistance(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(p, a).dot(ab) / ab.lengthSq(), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/**
 * Skin weights: each bone owns the segment from its joint to its child joint;
 * fingertip bones own a short stub around the tip; the wrist owns rays toward
 * each knuckle, a bar across the palm, and the whole cuff. A vertex takes up
 * to four bones, weighted by a falloff on distance beyond its nearest one.
 */
function skin(geometry) {
  const segs = [];
  for (let i = 1; i < 21; i++) {
    const c = CHILD[i];
    if (c >= 0) segs.push({ bone: i, a: REST[i], b: REST[c] });
  }
  for (const tip of [4, 8, 12, 16, 20]) {
    const dir = REST[tip].clone().sub(REST[PARENT[tip]]);
    segs.push({ bone: tip, a: REST[tip].clone().addScaledVector(dir, -0.15), b: REST[tip].clone().addScaledVector(dir, 0.4) });
  }
  for (const k of [1, 5, 9, 13, 17]) segs.push({ bone: 0, a: REST[0], b: REST[k].clone().lerp(REST[0], 0.25) });
  segs.push({ bone: 0, a: REST[5].clone().lerp(REST[0], 0.3), b: REST[17].clone().lerp(REST[0], 0.3) });

  const pos = geometry.attributes.position;
  const n = pos.count;
  const idx = new Uint16Array(n * 4);
  const wts = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  const FALLOFF = 0.009; // metres: how far past the nearest bone a neighbour still pulls
  for (let v = 0; v < n; v++) {
    p.fromBufferAttribute(pos, v);
    if (p.x < REST[0].x) {
      idx[v * 4] = 0;
      wts[v * 4] = 1;
      continue;
    }
    const best = new Map();
    for (const s of segs) {
      const d = segmentDistance(p, s.a, s.b);
      if (!best.has(s.bone) || d < best.get(s.bone)) best.set(s.bone, d);
    }
    const ranked = [...best.entries()].sort((x, y) => x[1] - y[1]).slice(0, 4);
    const d0 = ranked[0][1];
    let sum = 0;
    const w = ranked.map(([, d]) => {
      const e = Math.exp(-(((d - d0) / FALLOFF) ** 2));
      sum += e;
      return e;
    });
    ranked.forEach(([bone], k) => {
      idx[v * 4 + k] = bone;
      wts[v * 4 + k] = w[k] / sum;
    });
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
}

const gltf = await new GLTFLoader().loadAsync('/__gif/model/scene.gltf');
gltf.scene.updateMatrixWorld(true);
let source;
gltf.scene.traverse((o) => {
  if (o.isMesh) source = o;
});
// Bake the Sketchfab/Collada node transforms into the vertices, so the rig
// works in the same space REST was measured in.
const baseGeometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
skin(baseGeometry);
const material = source.material;
material.side = THREE.DoubleSide; // the cuff's inside shows when the wrist turns
// The texture set marks parts of the glove metallic, which renders them near
// black under plain lights. Nitrile is not a metal: keep the roughness and
// fold maps, drop metalness.
material.metalness = 0;
material.metalnessMap = null;
// Light nitrile blue. The model's own texture is violet; keep only its light
// and shade (normalised luminance, compressed toward white) and let the
// material colour carry the hue.
material.map = shadeOnly(material.map);
material.color.set(0x8ec4f0);
// Soften the moulded folds: at inset size full-strength normals read as
// lumps rather than wrinkles.
material.normalScale.set(0.3, 0.3);
material.roughness = 0.62;
material.needsUpdate = true;

function shadeOnly(tex) {
  const img = tex.image;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  let lo = 255;
  let hi = 0;
  const lum = new Float32Array(px.length / 4);
  for (let i = 0; i < lum.length; i++) {
    const l = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    lum[i] = l;
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  for (let i = 0; i < lum.length; i++) {
    const v = Math.round(255 * (0.76 + 0.24 * ((lum[i] - lo) / Math.max(hi - lo, 1))));
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
  }
  g.putImageData(d, 0, 0);
  const out = new THREE.CanvasTexture(c);
  out.flipY = tex.flipY;
  out.colorSpace = THREE.SRGBColorSpace;
  out.anisotropy = 4;
  return out;
}

// A slight view from above and to the side: dead-on, curled fingers read as
// flat stubs; at an angle they show their depth.
const stage = new THREE.Group();
stage.rotation.set(0.32, -0.22, 0);
scene.add(stage);

function makeGlove() {
  const bones = REST.map(() => new THREE.Bone());
  bones.forEach((b, i) => {
    const parent = PARENT[i];
    if (parent < 0) b.position.copy(REST[i]);
    else {
      b.position.subVectors(REST[i], REST[parent]);
      bones[parent].add(b);
    }
  });
  const mesh = new THREE.SkinnedMesh(baseGeometry, material);
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh);
  group.visible = false;
  stage.add(group);
  return { group, bones };
}
const gloves = [makeGlove(), makeGlove()];

/* ------------------------------------------------------------- the solve */

/** Raw MediaPipe landmarks (unmirrored, normalised) to inset pixels, mirrored. */
/**
 * Per-clip framing in raw landmark units: the box every landmark of the clip
 * stays inside, so the hands fill the inset without travel ever leaving it.
 */
const framing = { cx: 0.5, cy: 0.5, zoom: 1.75 };

function toScene(lm, i) {
  const { cx, cy, zoom } = framing;
  return new THREE.Vector3((cx - lm[i * 3]) * zoom * W, -(lm[i * 3 + 1] - cy) * zoom * W * 0.75, -lm[i * 3 + 2] * zoom * W);
}

/** Orthonormal palm frame from the wrist and the index and pinky knuckles. */
function palmFrame(P) {
  const up = new THREE.Vector3().subVectors(P[9], P[0]).normalize();
  const n = new THREE.Vector3().subVectors(P[5], P[0]).cross(new THREE.Vector3().subVectors(P[17], P[0])).normalize();
  const side = new THREE.Vector3().crossVectors(n, up).normalize();
  n.crossVectors(up, side);
  return new THREE.Matrix4().makeBasis(up, side, n);
}

const REST_FRAME_INV = palmFrame(REST).invert();
// Which way the knuckle-cross normal points relative to the palm, at rest.
const REST_PALMWARD = Math.sign(
  new THREE.Vector3().subVectors(REST[5], REST[0]).cross(new THREE.Vector3().subVectors(REST[17], REST[0])).dot(REST_PALM),
);
const REST_HS = REST[0].distanceTo(REST[9]);

function poseGlove(glove, lm) {
  const T = Array.from({ length: 21 }, (_, i) => toScene(lm, i));
  const s = T[0].distanceTo(T[9]) / REST_HS;

  // Chirality. The app's gestures are made palm-toward-camera, so the palm
  // side of a target hand is +z. If its knuckle-cross normal points the other
  // way from the glove's at rest, the hand is mirrored relative to the glove.
  const nT = new THREE.Vector3().subVectors(T[5], T[0]).cross(new THREE.Vector3().subVectors(T[17], T[0]));
  const mirror = Math.sign(nT.z) !== REST_PALMWARD;
  const S = new THREE.Vector3(s, s, mirror ? -s : s);

  // Solve in the glove's local space: L_i = REST_0 + S^-1 (T_i - T_0).
  const L = T.map((t) => new THREE.Vector3().subVectors(t, T[0]).divide(S).add(REST[0]));
  glove.group.scale.copy(S);
  glove.group.position.copy(T[0]).sub(REST[0].clone().multiply(S));

  const rootQ = new THREE.Quaternion().setFromRotationMatrix(palmFrame(L).multiply(REST_FRAME_INV));
  const world = new Array(21);
  world[0] = rootQ;
  glove.bones[0].quaternion.copy(rootQ);

  for (let i = 1; i < 21; i++) {
    const parentQ = world[PARENT[i]];
    const c = CHILD[i];
    let q = parentQ.clone();
    if (c >= 0) {
      const restDir = new THREE.Vector3().subVectors(REST[c], REST[i]).normalize().applyQuaternion(parentQ);
      const targetDir = new THREE.Vector3().subVectors(L[c], L[i]).normalize();
      q = new THREE.Quaternion().setFromUnitVectors(restDir, targetDir).multiply(parentQ);
    }
    world[i] = q;
    glove.bones[i].quaternion.copy(parentQ.clone().invert().multiply(q));
  }
  glove.group.visible = true;
}

window.__gifcard = {
  text(title, sub) {
    card.querySelector('.t').textContent = title;
    card.querySelector('.s').textContent = sub;
  },
  say(v) {
    card.querySelector('.v').textContent = v || '';
  },
  /** Fit the inset to a clip: bounds of every raw landmark it contains. */
  frame(minX, maxX, minY, maxY) {
    // The cuff hangs below the wrist landmark: leave room for it.
    const hand = maxY - minY;
    maxY += 0.35 * hand;
    framing.cx = (minX + maxX) / 2;
    framing.cy = (minY + maxY) / 2;
    // Fill 72 % of the width or 74 % of the height, whichever binds first; a
    // still hand is not blown up past life-size-ish.
    framing.zoom = Math.min((0.72 * W) / ((maxX - minX) * W), (0.74 * H) / ((maxY - minY) * W * 0.75), 1.9);
  },
  voiceOnly() {
    card.classList.add('voice');
  },
  draw(hands) {
    gloves.forEach((g) => (g.group.visible = false));
    hands.slice(0, 2).forEach((h, i) => poseGlove(gloves[i], h.lm));
    const sides = hands.map((h) => h.side);
    card.querySelector('.side').textContent =
      sides.length === 2 ? 'BOTH HANDS' : sides.length === 1 ? `${sides[0].toUpperCase()} HAND` : 'NO HANDS';
    renderer.render(scene, camera);
  },
};
