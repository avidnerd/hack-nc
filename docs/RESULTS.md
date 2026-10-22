# Results

Every number here comes from a file in `metrics/`. Unmeasured cells show `—`.

## VISTA-3D on Nebius (full-scan Serverless Job)

Source: `metrics/vista_runs.jsonl`. One NVIDIA H100 80GB HBM3 on Nebius AI Cloud (eu-north1). Model `nvidia/NV-Segment-CT` (VISTA-3D), class prompts for the 8 structures the app plans on. Dice = 2|A∩B| / (|A|+|B|): the overlap between VISTA-3D's mask and the MSD Task03 reference mask, from 0 (none) to 1 (identical). Liver Dice counts tumour as liver on both sides.

| MSD case | CT grid | Liver Dice | Tumour Dice | Reference tumour (lesions) | VISTA-3D | Scan to app assets | GPU peak |
|---|---|---|---|---|---|---|---|
| 24 | 512×512×276 @ 1.5 mm | 0.962 | 0.000 | 1.0 mL (1) | 6.2 s | 35.5 s | 5.68 GB |
| 30 | 512×512×200 @ 1.0 mm | 0.980 | 0.635 | 14.3 mL (1) | 4.6 s | 26.4 s | 4.6 GB |
| 39 | 512×512×260 @ 1.0 mm | 0.971 | 0.841 | 349.0 mL (1) | 5.5 s | 31.4 s | 5.65 GB |
| 47 | 512×512×225 @ 1.0 mm | 0.967 | — | 0.0 mL (0) | 5.0 s | 23.7 s | 5.01 GB |
| 56 | 512×512×239 @ 2.0 mm | 0.963 | 0.818 | 345.8 mL (2) | 5.7 s | 33.5 s | 5.55 GB |
| 59 | 512×512×216 @ 2.0 mm | 0.969 | 0.000 | 0.7 mL (1) | 4.7 s | 25.0 s | 4.84 GB |
| 62 | 512×512×188 @ 2.0 mm | 0.968 | 0.549 | 2.7 mL (2) | 3.7 s | 24.9 s | 4.28 GB |
| 70 | 512×512×333 @ 1.25 mm | 0.959 | 0.609 | 53.9 mL (3) | 5.8 s | 34.7 s | 6.38 GB |

- Liver Dice: median 0.967, range 0.959 to 0.980 over 8 scans.
- Tumour Dice follows lesion size. Lesions under about 1 mL are labelled as liver (Dice 0). A case with no reference tumour shows `—`.
- VISTA-3D inference: median 5.2 s per scan. Scan to app assets (segmentation, masks, crop, resample, centerline, meshes): median 28.9 s per scan. The model loads once per job (24.26 s). Job start (provisioning and image pull) is not included: 4 min 41 s from create to running in both measured smoke runs, which is why the gallery is precomputed.
- Caveat: VISTA-3D's training data includes MSD Task03, so these scans may have been seen in training and the Dice scores may be optimistic.

