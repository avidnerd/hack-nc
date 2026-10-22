#!/usr/bin/env bash
# Entry point of the vista3d-full Serverless Job. The bucket is mounted at /data:
#   /data/code   vista/ and pipeline/ from this repo (make vista-upload)
#   /data/raw    input CTs (and MSD truth labels for Dice)
#   /data/out    one folder per case: assets/, vista_run.json, status.json
set -euo pipefail
export PYTHONUNBUFFERED=1
t0=$(date +%s)
pip install -q --root-user-action=ignore "monai==1.4.0" "transformers==4.44.2" "nibabel==5.2.1" \
  "scikit-image==0.23.2" "einops==0.7.0" scipy huggingface_hub
echo "deps installed in $(( $(date +%s) - t0 )) s"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
python /data/code/vista/job/vista_job.py --out /data/out "$@"
