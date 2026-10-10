# Scrub+ demo script

Chrome, laptop webcam, fullscreen (`F`). Start on the liver case (`/`). If anything
goes wrong, `R` resets the scene instantly and every step has a key in brackets.

Say every command with the wake word: **"Scrub, …"**. The heard transcript appears at
the bottom of the screen for three seconds, so the audience sees recognition working.

## 0. Before you start (off stage)

- Allow camera and microphone when Chrome asks.
- Hold one open hand up for half a second: that calibrates the depth baseline.
- Press `V` if you want the webcam preview hidden; leave it on for judges.

The left-hand panel always shows the next step and the exact phrase to say, in the
same order as below, so a judge can follow it with no instructions.

## The 90-second copilot demo (primary)

The message: **surgeons shouldn't have to direct someone through a series of clicks to
see patient-specific anatomy during a sterile procedure. Scrub+ lets them ask for exactly
what they need and immediately see it.**

Liver case. Every step has a key in brackets.

| # | Do / say | What happens | Key |
|---|---|---|---|
| 1 | **Pinch** and drag; **open hand** over the liver | The touchless CT you already know: the body turns, the cut follows your palm, the CT shows on its face | drag / `X` |
| 2 | "Scrub, show me the tumor relative to the portal vein" | The camera flies in on the gap and the two structures glow while everything else ghosts. A line joins their closest points: "Tumour ↔ portal vein · 28.3 mm". Voice: "The tumour is 28 millimeters from the portal vein." | `J` |
| 3 | "Scrub, show me where the tumor is closest to a major vessel" | Every segmented vessel is searched at once. It flies to the closest, an intrahepatic vessel 4.8 mm away, and opens a CT section through the gap. The card ranks the other vessels | `N` |
| 4 | "Scrub, make a sagittal cut 12 millimeters from the tumor" | The plane glides in; margin about 12 mm, remnant about 59 % | (palm) |
| 5 | "Scrub, save this plan" | "Saved as the original plan." Saving again would ask for "Scrub, confirm" | `B` |
| 6 | Move the cut with your **open hand** (tilt or slide it) | The numbers change live | ↑ / ↓ |
| 7 | "Scrub, compare this to the original plan" | The original plane appears dashed next to the current one. The card shows margin, remnant, resected mL, vessels crossed and the plane change, side by side. Voice: "Compared with the saved plan, the current plane keeps … percentage points … liver, …" | `Y` |
| 8 | "Scrub, show me the original plan" | The saved plane and view come back exactly, with the same numbers | `U` |
| 9 | "Scrub, go back to the previous view" | Undoes the last navigation | `Backspace` |

At any point the camera is still yours: pinch-drag rotates around what the copilot framed,
two pinches zoom, and "Scrub, cancel" (`Esc`) clears the highlight.

## Extended demo

### 1. Liver: measure, cut, fix, check the evidence (45 s)

| Do / say | What happens | Fallback |
|---|---|---|
| "Scrub, measure the tumor" | A caliper spans the lesion. Voice: "Tumor 67 by 53 millimeters, 39 milliliters." A card shows the RECIST diameter and the resection goal | `M` |
| **Open hand** over the liver | The cut follows your palm and shows the real CT section on its face. The piece to be removed is a ghost with the tumour inside, and the numbers light up | `X` |
| Tilt and slide the palm close to the tumour | MARGIN goes amber and a coloured line on the cut face shows where it is tightest. A red ✕ names each vessel the cut divides | right-drag / shift-drag |
| "Scrub, optimize" | The plane re-seats itself over one second and the numbers tween. Voice: "Optimized. Moved 9 degrees to clear the hepatic vessel. Margin 10 millimeters, remnant 72 percent." | `O` |
| Make a **fist** | "Locked." The resected piece lifts away from the liver | `L` |
| "Scrub, what are the outcomes" | A card shows **published cohort rates** for the band this plan falls in: remnant above 26.6 % (severe liver dysfunction in 1 of 82 patients in Schindl 2005), margin ≥10 mm (Margonis 2018). It says plainly that these are not a prediction for this patient | `E` |

Optional: "Scrub, what do you suggest" (`A`) before optimizing lists what to change
(margin under target, vessel divided, remnant under minimum). Two index fingers give a
live caliper; "bone window" (`2`) changes the CT window.

### 2. Aorta: an infrarenal stent seal (35 s)

| Do / say | What happens | Fallback |
|---|---|---|
| "Scrub, load the aorta case" | The aorta case loads with the liver ghosted, the renal arteries marked and flow particles streaming | `C` |
| "Scrub, measure the aorta" | "Aorta 24 millimeters at its widest. Not aneurysmal." The card shows the aneurysm (30 mm) and repair (55 / 50 mm) thresholds | `M` |
| "Scrub, place the stent" | The graft's seal segment seats just below the lowest renal artery and sizes itself 15 % over the neck. Voice: "Placed. Neck 41 millimeters. Seals." Chord | `S` |
| **Pinch the stent** and drag it up | The stent and the right renal artery tag turn red. Voice: "Won't seal. Right renal artery covered." Low tone | `[` ×3 |
| "Scrub, optimize" | The stent slides back to the nearest sealing seat | `O` |
| "Scrub, what are the outcomes" | Published endoleak rates for necks in this band (Stather 2013, Bernardini 2022) | `E` |

### 3. "Scrub, show the patient" (10 s)

| Do / say | What happens | Fallback |
|---|---|---|
| "Scrub, show the patient" | Organ, tumour and device only, soft colours, camera pulls back, three callouts (Removed / Placed / Stays); two plain sentences spoken | `P` |
| "Scrub, write the plan" | `plan.md` (and `plane.json`) download, every number from state | `W` |
| "Scrub, back to surgeon view" | Everything restored | `P` |

Ask the anatomy directly, any time: "Scrub, sagittal cut 10 millimeters from the tumor"
places the plane; "Scrub, how far is the tumor from the portal vein" draws the gap
(28 mm here); "Scrub, what's the margin" or "which vessels does it cross" reads the
plan back. Two index fingers near a structure snap to its walls and name it.

Other measurements work the same way: "measure the liver", "the left kidney", "the
portal vein", "the vena cava", "the neck".

## If tracking fails on stage

Press `D`: a recorded landmark stream replays through the exact same gesture pipeline
(rotate, cut, tilt, lock, caliper, zoom). Press `D` again to stop. Re-record your own
with `Shift+D` (press again to stop and download `landmarks.json`, then copy it to
`public/demo/landmarks.json`).

## Recording the 2-minute video (OBS)

1. OBS: Display Capture of the Chrome window + a webcam source in a corner, mic on.
2. Run the three parts above in order, live, once; then `R` and do it again for a
   second take.
3. Keep the first take unless it has a recognition miss; if it does, re-shoot that
   moment using the keyboard fallback so the narration still lands.
