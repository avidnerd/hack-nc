#!/usr/bin/env bash
# Reproduce public/data/ from the public sources.
#
#   bash pipeline/download.sh
#
# Needs Python 3.11 with nibabel, numpy, scipy, scikit-image and TotalSegmentator
# (pip install TotalSegmentator). Judges never need this: the processed cases are
# already in public/data/.
#
# Case A (liver): MSD Task03_Liver liver_36, one peripheral lesion (39 mL),
#   kept at its native 1.0 mm.
# Case B (aorta): MSD Task03_Liver liver_8, 1.0 mm slices and ~130 mm of
#   infrarenal aorta (picked over liver_6 / liver_9 by a TotalSegmentator
#   --fast screen; the old liver_0 had 5 mm slices and ~30 mm below the renals).
# Only these two cases are range-downloaded from the 29 GB MSD tar.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python}"

for CASE in liver_36 liver_8; do
  "$PY" fetch_msd.py "$CASE"
  TotalSegmentator -i "raw/imagesTr/$CASE.nii.gz" -o "raw/seg/$CASE" \
    --roi_subset liver inferior_vena_cava portal_vein_and_splenic_vein aorta kidney_left kidney_right
  TotalSegmentator -i "raw/imagesTr/$CASE.nii.gz" -o "raw/seg_vessels/$CASE" -ta liver_vessels
done

"$PY" run.py liver --ct raw/imagesTr/liver_36.nii.gz --labels raw/labelsTr/liver_36.nii.gz \
  --seg raw/seg/liver_36 raw/seg_vessels/liver_36 --name "Liver - MSD Task03 case 36" \
  --spacing 1.0 --max-dim 512
"$PY" run.py aorta --kind aorta --ct raw/imagesTr/liver_8.nii.gz \
  --seg raw/seg/liver_8 raw/seg_vessels/liver_8 --name "Aorta - MSD Task03 case 8" \
  --spacing 1.25 --max-dim 400
