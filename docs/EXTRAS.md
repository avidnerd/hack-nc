# Extras, shortcuts and decisions

Everything here is either cut from the live demo or a conscious shortcut. Each item
points at the code comment (`// DECISION:` or `// TODO(ship):`) that carries it.

## Cut from the live demo

- **Trajectory planning** (ray from skin entry to target, structures crossed). Not
  built; the DDA would step the same label grid `vessels.ts` uses.
- **STL export of the resected region** (marching cubes on the planning grid). Not
  built; `plan.md` and `plane.json` cover the hand-off.
- **LLM rewrite of the plan note into prose.** The note stays a template so every
  number is verifiably from the state object.
- **Pre-rendered ElevenLabs phrases.** `src/voice/tts.ts` plays any clip listed in
  `public/audio/manifest.json`; no clips are shipped, so the browser voice (or live
  ElevenLabs with `VITE_ELEVENLABS_KEY`) speaks.

## Clinically motivated next steps (from docs/CLINICAL.md)

Not built. In order of clinical value per the review:

1. **Remnant adjusted for venous outflow.** Assign liver voxels to their nearest hepatic
   vein branch and subtract territories whose vein the cut divides ("remnant with outflow
   preserved"). Needs hepatic veins separated from portal veins; TotalSegmentator's
   `liver_vessels` gives one combined label.
2. **Couinaud segment labels** (TotalSegmentator `liver_segments`), so the plan reads
   "partial S6/S7" in the language tumour boards use.
3. **Standardized FLR and FLR ÷ body weight** with height and weight inputs, plus voice
   presets for liver quality (normal 20 %, post-chemotherapy 30 %, cirrhosis 40 %).
4. **Margin modes:** an R0 floor of 1 mm separate from the 10 mm target.
5. **Curved or multi-plane resection surfaces.**
6. **A real aneurysm case** (thin-slice CTA) for the EVAR moment, and an aortoiliac
   occlusive-disease case for the "stent opens a narrowing" flow story.

## Decisions (with where they live)

| Decision | Where |
|---|---|
| **Gestures redesigned after first user feedback.** The spec's OPEN (rotate) vs PALM (cut) split depended on a 35° palm tilt nobody could hold reliably. Now any open hand cuts, pinch-and-drag rotates, two pinches zoom, a fist locks. | `src/input/gestures.ts`, `handControl.ts` |
| A pinch only needs the other three fingers not all straight, not fully curled. A pinch must also reach (index tip ≥ 1.1 hand sizes from the wrist) to separate it from a fist. | `src/input/gestures.ts`, `tuning.ts` |
| 1€ filters run in camera pixels (landmarks) and degrees (plane normal): the scales the spec's β values are tuned for. | `src/input/hands.ts`, `handControl.ts` |
| The cut is placed absolutely: through the point under the hand on screen, at the organ's depth, with a ring cursor showing where that is. What you see is what you cut. A locked cut ignores the hand until it is unlocked. | `src/input/handControl.ts` |
| Resected side faces the camera, so the surgeon looks straight at the cut face. | `src/input/handControl.ts` |
| A fist toggles lock (lock, then unlock), so a gesture-only demo is never stuck locked. | `src/input/handControl.ts` |
| Stent rules are checked renal-first; the neck is measured distally from the proximal end; a dragged stent keeps its diameter (moving a chosen graft, not choosing a new one). | `src/devices/stent.ts`, `stentSession.ts` |
| Case A is MSD liver_36 (a single peripheral lesion of 39 mL, picked by triage over all 131 cases; 42 mm is its equivalent-sphere diameter, its RECIST longest axial diameter is 67 mm). Case B is MSD liver_8 (see the thin-slice row below). Its aorta has no stenosis, so the red stenosis colouring never triggers on real data. A stent no longer "widens" it either (see below), so FLOW RESISTANCE stays at about 100: honest for a healthy aorta. | `pipeline/run.py`, `src/devices/flow1d.ts` |
| **Infrarenal seating (after the clinical review).** A standard infrarenal graft seals *below* the lowest renal artery; the first version seated it above them, where it would have covered the visceral arteries. The rule is now "covered graft starts at or below the lowest renal", a fresh stent seats 2 mm below it, and the failure demo is dragging it *up*. | `src/devices/stent.ts` |
| **Thin-slice aorta case.** Case B moved from liver_0 (5 mm slices, ~30 mm infrarenal) to liver_8 (1 mm slices, ~130 mm infrarenal, 1.25 mm grid), chosen over liver_6 and liver_9 by a TotalSegmentator `--fast` screen of thin-slice MSD cases reaching the pelvis. The slab runs from 30 mm under the bifurcation to 40 mm over the kidneys. The device is an 80 mm main body; the iliac limbs are not drawn. | `pipeline/run.py`, `src/devices/stent.ts` |
| **Liver at native resolution.** Case A ships at liver_36's native 1.0 mm (455 × 391 × 111) instead of 1.77 mm; `--spacing` / `--max-dim` set it. Mesh smoothing is in millimetres so finer grids keep the same look. | `pipeline/run.py`, `pipeline/meshes.py` |
| Centerline: the EDT pads the crop faces (they are not vessel wall), and tapered skeleton spurs at the ends are trimmed (liver_8's top end read 3.8 mm against an 8.7 mm median and showed as a fake stenosis). | `pipeline/run.py` |
| Bone mesh keeps only threshold components that reach 650 HU: oral contrast in bowel crosses the 220 HU bone threshold but never has a dense cortex. | `pipeline/meshes.py` |
| A graft reopens only a true narrowing (r < 0.7 × median); it does not widen a natural taper, so a healthy tapering aorta keeps flow resistance at 100. | `src/devices/flow1d.ts` |
| Renal ostia sit at the level of each kidney's hilum (mean of its most medial 10 % of voxels), not at the centerline point nearest the kidney centroid, which landed 20–25 mm too caudal. `pipeline/ostia.py` rewrites a published case's ostia without the full pipeline. | `pipeline/run.py`, `pipeline/ostia.py` |
| Inside a stent the flow model uses `max(r_native, ø_device ÷ 2 ÷ 1.15)`: oversize is wall apposition, not a wider aorta. The first version used the oversized diameter itself, which made flow resistance drop to 42 on a healthy aorta. | `src/devices/flow1d.ts` |
| The cut face draws the margin (closest-approach segment, coloured against the threshold) and marks each divided vessel by name. The whole-label glow is kept only for named trunks: the intrahepatic tree is one label, so lighting it lit every branch. | `src/render/overlays.ts`, `src/main.ts` |
| Gas inside the body is drawn as an opaque dark section, like on a CT, instead of a see-through hole; air counts as inside when tissue lies within reach on all four axial sides. | `src/render/anatomy.ts` |
| **Stent is aorta-only.** "Place the stent" in the liver case says to load the aorta case instead of putting a graft in a liver resection. The aorta case starts with the hepatic vessels and portal vein hidden, the liver as a faint ghost and the aorta more see-through, with the renal artery origins marked and turning red when covered. | `src/devices/stentSession.ts`, `src/state.ts`, `src/render/renalMarkers.ts` |
| Measurements take the largest connected component (liver_36's tumour label has a 0.01 mL speck elsewhere that inflated the diameter to 69 mm). | `src/planning/anatomyMeasure.ts` |
| Outcomes quote only figures verified against an abstract or full text; unverified ones (Kishi per-group rates, AbuRahma neck-length rates, ISGLS grade mortality, Sadot medians) are left out until checked. | `src/ai/advice.ts` |
| **Smart measurement.** Caliper ends snap to walls (6 mm) or landmarks (4 mm, nearer wins); spoken sagittal / coronal / axial cuts through or N mm clear of a structure pick the side that keeps more liver; "how far is X from Y" reports the closest wall-to-wall gap. A cut in the aorta case is a viewing section: no liver numbers, vessel marks or glow. Parked: point-to-point "from here to there", curved-path distances, Couinaud landmarks (no segment labels). | `src/planning/smartMeasure.ts`, `src/main.ts` |
| Both cases default to the soft-tissue window, which reads best on the CT cut face. | `pipeline/run.py` |
| The planning grid is coarsened by a voxel budget (2 × 128³) rather than a fixed 128 per axis, so the thin liver slab keeps full resolution and matches numpy exactly. | `src/planning/volume.ts`, `pipeline/run.py` |
| Vessels crossed only counts components of at least 120 mm³ (a vessel of 5 mm or more), because with the full intrahepatic tree every cut divides a dozen twigs. The glow follows the largest crossed vessel instead of any vessel within 5 mm, which with the full tree was always on. | `src/planning/vessels.ts`, `pipeline/run.py` |
| The optimizer ranks on a coarse grid (about 8,000 organ voxels) using the exact plane-to-tumour distance as its margin, then re-scores the top 24 plus the surgeon's own plane on the full grid. | `src/planning/optimize.ts` |
| The tumour stays visible as a ghost beyond the cut, so the margin has something to point at. | `src/render/shaders/raymarch.frag.glsl` |
| The default view is lit surface meshes (pipeline/meshes.py), not the ray-marched CT: realistic, and cheap enough for 60 fps alongside hand tracking. The CT appears on the cut face; the ray-marcher is kept behind `K`. | `src/render/anatomy.ts` |
| Locking the cut lifts the resected piece (organ, tumour, intrahepatic vessels) 38 mm along the plane normal. Purely visual: the numbers are unchanged. | `src/render/anatomy.ts` |
| Pose reading fuses the rules with a small temporal MLP (idea from HoloTouch, our own implementation). It is trained on synthetic hands with simulated occlusion, because no real recordings exist yet. Shift+G records real labelled data for fine-tuning. | `src/input/gestureNet.ts`, `scripts/train-gestures.ts` |
| Default camera is a high anterior-oblique view, orbiting the patient's head-foot axis, with the patient's right on screen-left (radiological convention). | `src/coords.ts` |
| The tumour EDT runs once on the main thread at load (~170 ms on the liver case) instead of in a worker; the optimizer's 3751-plane search does run in a worker. | `src/planning/volume.ts`, `optimize.worker.ts` |
| Interface sounds are synthesised with WebAudio instead of shipped files. | `src/voice/tts.ts` |
| Head-coupled view uses BlazeFace's nose keypoint (230 KB model) rather than the full face mesh. Off unless `VITE_HEAD=1` or `?head=1`. | `src/input/head.ts` |
| Patient view hides the cut, skin and bone so the whole organ and tumour show; the callouts explain what is removed. | `src/render/anatomy.ts` |

## Ship TODOs

- `TODO(ship)`: record a Shift+G session on the demo laptop (ideally two or three people,
  gloved and bare) and retrain with `--real` before trusting the gesture network on stage.
- `TODO(ship)`: replace the synthetic `public/demo/landmarks.json` (built by
  `scripts/make-demo.ts`) with a real `Shift+D` recording from the demo laptop.
