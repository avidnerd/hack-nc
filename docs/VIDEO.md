# Video script (2:50, 1080p60, burned-in captions)

Record in Chrome at 1920x1080, fullscreen (`F`), on `https://scrubplus.vercel.app/app/` with the Nano and vista3d-point endpoints running (Under the hood should show `scrub`, not the Super model id; make one throwaway alt-click per case first, since the first prompt on a case takes about 5 s). Save every raw take to `video/raw/` and add a line to `video/raw/LOG.md`: file, what it shows, numbers on screen.

Captions follow the copy rules: short declarative sentences, no em dashes, no exclamation marks. Numbers in captions must match the take; the ones below are what the engine computes for these exact steps (Python engine, `metrics/` sources noted) and will match if the steps are repeated as written.

| Time | Shot | Caption |
|---|---|---|
| 0:00 to 0:10 | Gloved open palm slices the liver CT. | Surgeons can't touch the scan. |
| 0:10 to 0:25 | Three numbers on a dark card, sources in small type. | Severe liver failure after hepatectomy: about 13 %, with 21 % or more mortality. Manual liver segmentation: over 34 minutes per scan. Screen-viewing time: 96 % to 10 %. |
| 0:25 to 1:00 | Liver case. Palm places a cut; the proximity ticks speed up near a vessel. "Scrub, optimize." The plane re-seats. "Resect." The block floats out. | Every number comes from the CT, not the model. |
| 1:00 to 1:20 | Liver case, axial cut through the upper abdomen. Alt-click the unlabelled organ left of the liver on the cut face (voxel 170, 230, 60). It lights teal; toast `VISTA-3D · NEBIUS · 0.7 s`; reply: "Stomach, VISTA-3D: 106.2 milliliters." Then a 2 s shot of the Gallery card for case 39 (Dice 0.971). | Point at anything. VISTA-3D on a Nebius H100 segments it and names it. |
| 1:20 to 1:40 | Aorta case. Palette: `size a stent for a Gore Excluder`. Rule card with goremedical.com link; stent snaps; verdict: neck diameter 18.6 mm, below the device minimum of 19. Then `size a stent for a Gore Excluder Conformable`: seals. | Tavily finds the IFU. Nemotron extracts it. Code checks every number against the source. |
| 1:40 to 2:15 | Under the hood drawer (model `scrub`, about 0.5 s per round, grounded). Cut to docs/architecture.svg, docs/distillation.svg, the results table. Grounding counter in the top bar. | The engine verified 4,133 teacher traces. A 9B Nemotron trained on them matches the 120B teacher: 75.8 % vs 77.3 % success, 0.8 s vs 1.2 s, $0.72 vs $1.98 per 1,000 commands. |
| 2:15 to 2:35 | Upload CT: a `.nii.gz` with no labels opens in the browser; click **Segment on Nebius**; the stages tick UPLOADED, SEGMENTING, CENTERLINE, READY (cut the GPU wait); the planned case opens; `optimize`. | A new scan, segmented on Nebius and planned. VISTA-3D: 4.2 s. |
| 2:35 to 2:50 | Wordmark, URL. | Open weights on Nebius. Patient CT never touches a closed model. scrubplus.vercel.app |

## Changes from the original plan (product decisions to confirm)

- **1:00 to 1:20, "what's this?"** is alt-click, not the pointing gesture (not built). The take must show the cut face, so place an axial cut first.
- **1:20 to 1:40, "Seals."** The real Gore Excluder verdict on this aorta is a rejection (neck 18.6 mm, IFU minimum 19 mm, `data/device_rules/gore-excluder.json`). The script shows that honestly, then the Excluder Conformable (16 to 32 mm), which seals.
- **2:15 to 2:35, upload.** A real upload took 338 s, mostly waiting for a GPU (4 min 39 s). Edit the wait out and say so in a small caption ("GPU wait cut, 5 min"); do not imply it is instant.
- **0:10 to 0:25, numbers.** The manual segmentation figure is Gotra et al. (over 34 min, 41 scans), because the 10 to 20 min figure in the brief could not be sourced. The Reese 2025 and Hansen 2013 figures are as given in the brief and were not re-verified online.

## Shot-by-shot engine values (for checking captions)

- Liver, cut along +x through the organ centroid, then optimize with a 10 mm margin: FLR 45.0 % to 75.5 %, margin 35.8 to 10.2 mm, vessels crossed 3 to 0. Resect: 322.9 mL. A hand-placed cut starts elsewhere, so read the before numbers off the take.
- Aorta, Gore Excluder: neck diameter 18.6 mm fails [19, 32]; neck length 31.0 mm, oversize 15.0 %, angulation 15.6° pass.
- Aorta, Gore Excluder Conformable: all rules pass (neck 18.5 mm in [16, 32]).
