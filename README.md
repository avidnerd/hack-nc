# Scrub+

> put your hand through the patient.

![a palm-driven cut through a real liver CT, with the tumour in orange and the planning numbers on the right](docs/shots/live-cut.png)

our submission for HackNC 2026.

> sterile, touchless 3D surgical planning. one laptop webcam, no headset.

# problem

A surgeon's hands are **sterile**. The CT scan they planned from is on a screen they **can't touch**.

So what happens mid-operation when they want to look at the images again?

- they tell a non-sterile assistant what to click
  - slow! in one randomized trial, relaying instructions to a third person took 246 s. gesture control took 215 s (Wipfli et al., _PLOS ONE_ 2016)
- they use draped controls
- or they break scrub, which means re-gowning and re-gloving

Touchless OR systems have been tried for over a decade, but they mostly stay in the lab. One review found only **8 of 55** were ever tested in a real clinical environment (Mewes et al., _IJCARS_ 2017).

And the ones that exist are basically image viewers. You can flip through slices with your hand. You **can't plan** with them.

# inspiration

The closest thing to Scrub+ is a Kinect PACS viewer that surgeons used in six hepatobiliary operations. They used it to match intraoperative ultrasound against the preoperative CT, and said they looked at the images more because of it (Strickland et al., _Can J Surg_ 2013).

That was 2013, with a depth camera. We wanted to see how far you could get in 2026 with **just the webcam already on the laptop**, and whether you could go past viewing and actually make planning decisions with your hands.

# design goals

Scrub+ is designed to be...

- **touchless**: open hand cuts, pinch grabs, fist locks, two fingers measure. everything else is voice ("scrub, place the stent", "scrub, measure the kidney", "scrub, what are the outcomes")
- **honest**: every number on screen comes from a one-line formula over real segmentation masks, unit-tested against numpy. **no AI touches geometry**
- **real data**: open CT scans from the Medical Segmentation Decathlon, not synthetic phantoms
- **un-killable on stage**: every gesture and voice command has a mouse or keyboard fallback, and the whole thing runs with the LLM turned off

# the copilot

> surgeons shouldn't have to direct someone through a series of clicks to see patient-specific anatomy during a sterile procedure. scrub+ lets them ask for exactly what they need and immediately see it.

Say **"scrub, show me…"** and the app flies the camera to the anatomy, highlights it, and puts a verified measurement on it. Hands, mouse and keys still work the whole time: the camera just orbits whatever it framed, so you can adjust from there.

| say | what happens |
|---|---|
| "show me the tumor relative to the portal vein" | both structures found in the segmentation, closest wall-to-wall gap measured, camera turned to see the gap side-on, both highlighted (everything else ghosted), line + mm drawn on the anatomy |
| "show me where the tumor is closest to a major vessel" | every segmented vessel searched at once, the closest one shown the same way, plus a CT section through the gap |
| "focus on the left kidney" | fly to one structure and highlight it |
| "save this plan" / "show me the original plan" | a baseline plan (plane, camera, structures, measurement, thresholds); replacing it needs "confirm" |
| "compare this cut to the original plan" | both planes through the same planning engine: margin, remnant, resected mL, vessel components, plane angle and shift, side by side; the original plane drawn dashed |
| "go back to the previous view" / "cancel" | undo the last navigation / stop and clear |

Every number comes from the deterministic code (the same EDT and planning engine as everything else). The LLM, when on, only maps unusual phrasing to one of these typed commands, and it can't confirm an overwrite. If a structure isn't in the segmentation, it says so. Keys: `J` relation, `N` nearest vessel, `B` save (`Shift+B` confirms), `U` original, `Y` compare, `Backspace` previous view, `Esc` cancel.

**Benchmark** (`npm run bench`, [docs/BENCHMARK.md](docs/BENCHMARK.md)): each of the four tasks above takes one command and puts the correct answer on screen in 9–570 ms of machine time, checked against an independent recomputation. That's software latency, not a human study; the same in-app instrumentation is ready to time real users doing the tasks by hand vs. by voice.

# the gestures

The gloved hand in the corner is what the camera sees. Everything else is the real app reacting.

<table>
<tr>
<td width="50%"><img src="docs/gifs/cut.gif" alt="an open hand moves and tilts; the cutting plane follows it through the liver and the remnant, margin and vessel numbers update live"><br><b>Open hand: cut.</b> The plane passes under your palm. Tilt it, the cut tilts.</td>
<td width="50%"><img src="docs/gifs/rotate.gif" alt="a pinching hand drags left and right; the CT body turns with it"><br><b>Pinch and drag: rotate.</b> Grab the body and turn it.</td>
</tr>
<tr>
<td><img src="docs/gifs/measure.gif" alt="two index fingers spread apart; a caliper line between them reads out in millimetres"><br><b>Two index fingers: measure.</b> A caliper, in millimetres.</td>
<td><img src="docs/gifs/lock.gif" alt="an open hand closes into a fist; the cut locks and the resected piece lifts away"><br><b>Fist: lock.</b> The cut freezes and the resected piece lifts away.</td>
</tr>
<tr>
<td><img src="docs/gifs/zoom.gif" alt="two pinching hands pull apart; the view zooms in"><br><b>Two pinches: zoom.</b> Pull apart to zoom in.</td>
<td><img src="docs/gifs/optimize.gif" alt="saying scrub optimize re-seats a cut that sat 6.3 mm from the tumour across two hepatic vessels; margin goes to 10.2 mm and vessels crossed to 0"><br><b>"scrub, optimize"</b> A cut 6.3 mm from the tumour, across two vessels, re-seats to 10.2 mm and 0 vessels.</td>
</tr>
<tr>
<td><img src="docs/gifs/stent.gif" alt="saying scrub place the stent seats a graft on the aorta that seals; moving it up three times covers the renal arteries and it turns red"><br><b>"scrub, place the stent"</b> It seals at a 41 mm neck. Move it up 15 mm and it covers the renal arteries.</td>
<td></td>
</tr>
</table>

These are rendered, not filmed. Each clip feeds a scripted hand-landmark stream through the app's normal replay path (the same filters and gesture state machine the webcam uses), and the glove (a CC BY 4.0 model by Jingfu Chen that we rigged ourselves) is posed from those same landmarks. Voice clips send the exact command the speech grammar produces. `node scripts/gesture-gifs.ts` rebuilds them (and the sharper WebM versions in `docs/video/`) with the dev server running.

# running it

Chrome on a laptop. From a fresh clone:

```sh
npm install
npm run dev
```

Then open the URL it prints and allow the camera and mic. No Python needed, the processed volumes are already in `public/data/`.

No webcam? Drag to rotate, shift+drag moves the plane, scroll zooms, click two points for a caliper. No mic? Every voice command has a key: `1`–`4` windows, `S` stent, `O` optimize, `L` lock, `M` measure, `A` suggestions, `E` outcomes, `P` patient view, `W` write plan, `R` reset, `C` switch case, plus the copilot keys above. `D` replays a recorded hand stream if tracking dies.

`npm test` runs the math tests, `npm run e2e` runs the Playwright smoke test. [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) has the 90-second demo, word for word.

To rebuild the data from the raw CTs: `pipeline/download.sh` then `pipeline/run.py` (Python 3.11, nibabel, numpy, scipy, scikit-image, TotalSegmentator).

# how we built it

**Data.** A Python pipeline takes an open CT (MSD Task03 Liver, case 36, picked out of all 131 cases for its single peripheral tumour: 39 mL, 67 mm across on its longest axial slice), resamples it, packs one byte per voxel, and adds TotalSegmentator labels for the vessels, kidneys and aorta. The aorta gets skeletonized into a centerline with a lumen radius every 2 mm.

**Rendering.** We wrote our own GLSL ray-marcher in three.js. Each pixel walks through the CT and the label volume together, so the tumour stays visible inside a see-through liver. The cutting plane throws away one side and lights up the cut face so it looks like an incision, not missing data.

**Hands.** MediaPipe gives us 21 landmarks per hand, on device. We smooth them with a 1€ filter (ours), run a pose state machine with a 150 ms dwell, and turn the palm's normal into the plane's normal. Depth comes from how big your hand looks compared to when you opened it.

**Planning.** Remnant, margin and vessels crossed are voxel counts and distance lookups. The tumour distance field is our own exact EDT. "Optimize" scores 3,751 nearby planes in a Web Worker and picks the best one that stays close to where you put yours. The stent is a parametric tube along the centerline, judged by four sealing rules. Flow is 1D continuity + Poiseuille.

**Smart measurement.** The caliper knows the anatomy: an end within 6 mm of a structure's wall lands exactly on it (or on a landmark like a renal artery origin), and the reading says what it spans, e.g. "Tumour · 41.2 mm" or "Tumour ↔ portal vein". You can also just ask: "sagittal cut 10 mm from the tumour" places the plane (on the side that keeps more liver), "how far is the tumour from the portal vein" draws the closest wall-to-wall gap, and "what's the margin" or "which vessels does it cross" reads the live plan back.

**Measure, suggest, outcomes.** "scrub, measure the <structure>" gives the measurement a radiologist would report for it (RECIST diameter for the tumour, pole-to-pole length for a kidney, inscribed diameter for the aorta and portal vein, AP × transverse for the IVC), next to its published normal range. "what do you suggest" checks the plan against your thresholds and says what to change. "what are the outcomes" shows **published cohort rates for the band your plan falls in** (e.g. remnant above or below 26.6 %, a hostile neck or not), with the study it came from. We researched all of it before building it; the sources and the list of things we refused to claim are in [docs/CLINICAL.md](docs/CLINICAL.md).

**Voice.** Web Speech API with a wake word ("scrub"). A regex grammar maps the rest to a fixed command. Only if the regex misses does an LLM get to pick from the same closed list, with a 1.5 s timeout.

# the math

Every number on screen, and where it comes from. A plane is `n·x = d` in world mm, and the resected side is `n·x − d > 0`. The CT is shown at full resolution (liver: 455 × 391 × 111 voxels of 1.0 mm, the scan's native spacing; aorta: 347 × 246 × 189 of 1.25 mm, from 1 mm slices). The planning grid is coarsened 2× by majority vote (liver: 2.0 mm), and numpy computes its ground truth on that same grid, so the browser and numpy agree exactly; against numpy at the full 1.0 mm the liver test plane is within 0.2 % remnant and 0.2 mm margin.

| On screen | Formula | Code |
|---|---|---|
| **REMNANT %** | liver voxels with `n·x − d ≤ 0` ÷ all liver voxels × 100 (tumour counts as liver) | [remnant.ts](src/planning/remnant.ts) |
| resected mL | resected liver voxels × voxel volume ÷ 1000 | remnant.ts |
| **MARGIN mm** | min of `distTumor` over kept-side liver voxels with `−diag < n·x − d ≤ 0` (the cut surface). 0 with "tumour not fully resected" if any tumour voxel is kept. `distTumor` is our own separable Felzenszwalb–Huttenlocher EDT in mm | [margin.ts](src/planning/margin.ts), [edt.ts](src/planning/edt.ts) |
| **VESSELS** | 6-connected components of vessel voxels with `\|n·x − d\| < voxel diag`, inside the liver bounding box, of at least 120 mm³; named after the largest | [vessels.ts](src/planning/vessels.ts) |
| margin line | segment from the cut-surface voxel that sets MARGIN to its nearest tumour voxel; its length is the MARGIN number | margin.ts |
| caliper mm | `\|A − B\|`, fingertip rays intersected with the cut plane (or the volume's front face) | [caliper.ts](src/planning/caliper.ts) |
| caliper snapping | each end moves to the nearest label boundary along the caliper line within 6 mm (0.5 mm search step), or to a landmark within 4 mm if nearer; the label names the structure spanned, or the two structures the ends rest against | [smartMeasure.ts](src/planning/smartMeasure.ts) |
| structure gap | EDT from the smaller structure over its bounding box + 60 mm; min over the other structure's voxels, minus one voxel (centre-to-centre → wall-to-wall); closest points drawn | smartMeasure.ts |
| named cut | normal ±x / ±y / ±z (sagittal / coronal / axial); through the structure's centroid, or `offset` mm beyond its extreme voxel face; of the two sides, the one with the larger remnant | smartMeasure.ts |
| tumour size | RECIST 1.1: longest axial diameter (max pairwise distance per axial slice, largest connected lesion, + 1 voxel edge to edge), perpendicular short axis, volume | [anatomyMeasure.ts](src/planning/anatomyMeasure.ts) |
| kidney length | extent along the mask's principal axis (covariance power iteration), + 1 voxel; flagged if the scan cuts the kidney off | anatomyMeasure.ts |
| aorta / portal vein ø | largest inscribed diameter, `2 × max EDT − 1 voxel` (lumen-like; outer wall reads 3–6 mm larger). Portal vein: trunk within 20 mm of the liver | anatomyMeasure.ts |
| IVC | AP and transverse extent on the axial slice at the lowest renal ostium | anatomyMeasure.ts |
| outcome rows | the plan's band against a published cutpoint (remnant 26.6 %, margin 0 / <10 / ≥10 mm, hostile neck, angulation 60°) → that study's reported rates for both bands | [advice.ts](src/ai/advice.ts) |
| **NECK mm** | from the stent's proximal end, the length over which lumen diameter stays within ±10 % of the mean over the first 15 mm | [stent.ts](src/devices/stent.ts) |
| stent ø | `1.15 ×` mean lumen diameter over the proximal 15 mm | stent.ts |
| oversize % | `(ø_device ÷ ø_neck − 1) × 100`, must be 10–20 % | stent.ts |
| angulation | angle between centerline tangents 15 mm apart, must be < 60° | stent.ts |
| renal check | graft starts at or below the lowest renal ostium (`s0 ≥ max sᵣ`), no ostium inside `[s0, s0 + 80 mm]` | stent.ts |
| flow speed | `v(s) = Q ÷ πr(s)²`, relative to the native median radius | [flow1d.ts](src/devices/flow1d.ts) |
| pressure drop | `Σ 8μ·ds ÷ πr⁴` along the centerline, native vessel = 100. inside a stent `r = max(r_native, ø_device ÷ 2 ÷ 1.15)` | flow1d.ts |
| optimizer score | `remnant − 1000·[margin < min] − 1000·[remnant < min] − 200·vessels − 0.3·Δangle − 0.3·Δd` over 121 normals (±20° cap) × 31 offsets (±15 mm) | [optimize.ts](src/planning/optimize.ts) |

What is AI and what isn't:

| Part | AI? |
|---|---|
| Hand landmarks | MediaPipe model, on device |
| Segmentations | TotalSegmentator, offline in the pipeline |
| Pose reading | rules + a small MLP of ours (~40k weights); rules win whenever it's unsure |
| Plane, depth, rotation | **no**, geometry |
| Every number on screen | **no**, the formulas above |
| Optimizer | **no**, exhaustive scored search |
| Stent sizing, verdict, flow | **no**, rules + 1D physics |
| Command parsing | regex first, **LLM only on a miss** (closed schema, 1.5 s timeout) |
| Copilot navigation, measurements, plan comparison | **no**: framing geometry, EDT distances and the planning engine; the LLM can only pick a typed command |
| Patient narration | template, **LLM may reword**; the rewrite is thrown out if any number changes |
| Plan note | **no**, template from app state |
| Suggestions, outcomes | **no**, rules over your thresholds + published cohort rates, each with its source |

# challenges we ran into

**The palm-tilt rule didn't survive real hands.** The original design split "open hand = rotate" from "flat palm facing the camera = cut", with a 35° tilt threshold. Nobody could hold that reliably. So now **any open hand cuts**, and rotation moved to pinch-and-drag, which is the pose MediaPipe reads most reliably.

**Occlusion.** When fingers overlap, MediaPipe's landmarks get messy and the rules misread the pose. We added a small MLP that looks at the last few hundred ms of landmarks and also predicts the pose 150 ms ahead, so a gesture can commit sooner. On synthetic hands with heavy occlusion it goes from 49.6 % (rules alone) to 88.3 % (rules + network) frame accuracy. It has **only seen synthetic hands** so far.

**No depth camera.** We fake depth from apparent hand size. It works because you correct the cut by eye, but it's a relative control, not a measurement.

**Optimize had to feel instant.** 3,751 candidates is a lot to score on a full grid. We rank them on a coarse grid (~8,000 organ voxels) and only re-score the best 24 on the real grid, so every number it reports is still exact. The Moment 3 search takes about 480 ms in Node.

**CT scans end mid-torso.** The volume's faces slice through solid tissue, and the ray-marcher rendered them as flat grey cards that looked like a bug. The shader fades tissue that sits flush against a face.

# accomplishments that we're proud of

The math is **actually checked**. numpy computes remnant, margin and vessels independently for fixed test planes, and the TypeScript has to agree within ±1 % remnant and ±1 mm margin. The EDT is tested against brute force. The stent rules are tested on the real aorta: it seals just below the lowest renal, and dragging it 12 mm higher covers a renal.

Optimize really does fix bad cuts. From the Moment 3 wedge (6.3 mm margin, crossing two hepatic vessel branches), it moves the plane 8.5° and comes back with **10.2 mm margin, 0 vessels crossed**, while the remnant barely moves (73.8 → 72.5 %).

And it all runs **with the LLM switched off**. The model is a convenience, not a dependency.

# what we learned

Hand tracking is good enough now that the hard part isn't the tracking. It's choosing gestures people can actually hold, and being honest about what each number means.

We also learned to say what this **isn't**:

- cuts are planar. real liver resections follow Couinaud segments
- flow is 1D continuity + Poiseuille, **not CFD**. real aortic flow is pulsatile
- the aorta case has a normal aorta, not an aneurysm. the stent shows sealing-zone logic, not device selection
- outcomes are **published cohort rates**, never a risk prediction for this patient. a CT has no labs, so MELD, ALBI or ICG clearance are out of reach
- renal ostia are estimated from the kidney hilum level, since TotalSegmentator doesn't segment renal arteries
- research datasets and automatic segmentations. **not a medical device**

# data and licenses

- CT and liver/tumour labels: Medical Segmentation Decathlon, Task03_Liver (CC BY-SA 4.0). processed volumes in `public/data/` are shared under the same licence
- vessel, kidney and aorta labels: TotalSegmentator (CC BY 4.0 models)
- built with MediaPipe Tasks, three.js, Vite, Web Speech API, and optionally Gemini Flash / Claude and ElevenLabs
- the full evidence review is in [docs/CLINICAL.md](docs/CLINICAL.md)
