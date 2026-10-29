# Video script (2:50, 1080p60, burned-in captions)

Record in Chrome at 1920x1080, fullscreen (`F`), on `https://scrubplus.vercel.app/app/` with the Nano endpoint running (Under the hood should show `scrub`, not the Super model id). Save every raw take to `video/raw/` and add a line to `video/raw/LOG.md`: file, what it shows, numbers on screen.

Captions follow the copy rules: short declarative sentences, no em dashes, no exclamation marks. Numbers in captions must match the take; the ones below are what the engine computes for these exact steps (Python engine, `metrics/` sources noted) and will match if the steps are repeated as written.

| Time | Shot | Caption |
|---|---|---|
| 0:00 to 0:10 | Gloved open palm slices the liver CT. | Surgeons can't touch the scan. |
| 0:10 to 0:25 | Three numbers on a dark card, sources in small type. | Severe liver failure after hepatectomy: about 13 %, with 21 % or more mortality. Manual liver segmentation: over 34 minutes per scan. Screen-viewing time: 96 % to 10 %. |
| 0:25 to 1:00 | Liver case. Palm places a cut; the proximity ticks speed up near a vessel. "Scrub, optimize." The plane re-seats. "Resect." The block floats out. | Every number comes from the CT, not the model. |
| 1:00 to 1:20 | Gallery: open MSD case 39. The facts line reads Dice 0.971 and VISTA-3D 5.5 s. | VISTA-3D segmented this scan on a Nebius H100 in 5.5 s. Liver Dice 0.971. |
| 1:20 to 1:40 | Aorta case. Palette: `size a stent for a Gore Excluder`. Rule card with goremedical.com link; stent snaps; verdict: neck diameter 18.6 mm, below the device minimum of 19. Then `size a stent for a Gore Excluder Conformable`: seals. | Tavily finds the IFU. Nemotron extracts it. Code checks every number against the source. |
| 1:40 to 2:15 | Under the hood drawer (model `scrub`, about 0.5 s per round, grounded). Cut to docs/architecture.svg, docs/distillation.svg, the results table. Grounding counter in the top bar. | The engine verified 4,133 teacher traces. A 9B Nemotron trained on them matches the 120B teacher: 75.8 % vs 77.3 % success, 0.8 s vs 1.2 s, $0.72 vs $1.98 per 1,000 commands. |
| 2:15 to 2:35 | Upload CT: drop a `.nii.gz`; the scan opens for viewing and cutting. | Your own scan opens in the browser. Nothing is uploaded. |
| 2:35 to 2:50 | Wordmark, URL. | Open weights on Nebius. Patient CT never touches a closed model. scrubplus.vercel.app |

## Changes from the original plan (product decisions to confirm)

- **1:00 to 1:20, point-prompt "what's this?"** was cut (CLAUDE.md cut order). The shot shows the precomputed VISTA-3D gallery instead.
- **1:20 to 1:40, "Seals."** The real Gore Excluder verdict on this aorta is a rejection (neck 18.6 mm, IFU minimum 19 mm, `data/device_rules/gore-excluder.json`). The script shows that honestly, then the Excluder Conformable (16 to 32 mm), which seals.
- **2:15 to 2:35, upload with progress stages** used the VISTA-3D Job in the plan. The server-side upload Job was not built; the shot shows the in-browser upload. Alternative: skip it and give 1:40 to 2:15 more time.
- **0:10 to 0:25, numbers.** The manual segmentation figure is Gotra et al. (over 34 min, 41 scans), because the 10 to 20 min figure in the brief could not be sourced. The Reese 2025 and Hansen 2013 figures are as given in the brief and were not re-verified online.

## Shot-by-shot engine values (for checking captions)

- Liver, cut along +x through the organ centroid, then optimize with a 10 mm margin: FLR 45.0 % to 75.5 %, margin 35.8 to 10.2 mm, vessels crossed 3 to 0. Resect: 322.9 mL. A hand-placed cut starts elsewhere, so read the before numbers off the take.
- Aorta, Gore Excluder: neck diameter 18.6 mm fails [19, 32]; neck length 31.0 mm, oversize 15.0 %, angulation 15.6° pass.
- Aorta, Gore Excluder Conformable: all rules pass (neck 18.5 mm in [16, 32]).
