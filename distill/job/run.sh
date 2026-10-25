#!/usr/bin/env bash
# Entry point of the distill-nano Serverless Job. The bucket is mounted at /data:
#   /data/code/distill/job/train.py     this repo's trainer
#   /data/distill/data/sft_*.jsonl      verified traces (export_sft.py)
#   /data/distill/runs/<run>/           adapter + train_log.json (written at the end)
set -euo pipefail
export PYTHONUNBUFFERED=1 HF_HOME=/root/hf
RUN=${1:?run name}; shift
t0=$(date +%s)
W=https://github.com
pip install -q --root-user-action=ignore "transformers==4.48.3" "peft==0.14.0" "accelerate==1.2.1" einops \
  "$W/state-spaces/mamba/releases/download/v2.2.2/mamba_ssm-2.2.2+cu122torch2.4cxx11abiFALSE-cp311-cp311-linux_x86_64.whl" \
  "$W/Dao-AILab/causal-conv1d/releases/download/v1.4.0/causal_conv1d-1.4.0+cu122torch2.4cxx11abiFALSE-cp311-cp311-linux_x86_64.whl"
echo "deps installed in $(( $(date +%s) - t0 )) s"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
python -c "import mamba_ssm, causal_conv1d; print('kernels ok', mamba_ssm.__version__)"
if [ "$RUN" = merge ]; then
  # Merge a trained adapter into the base weights: run.sh merge <run>
  SRC=${1:?run to merge}
  python /data/code/distill/job/merge.py --adapter "/data/distill/runs/$SRC/scrub-lora" --out /root/merged
  mkdir -p "/data/distill/runs/$SRC/merged"
  cp -r --no-preserve=all /root/merged/. "/data/distill/runs/$SRC/merged/"
  ls -la "/data/distill/runs/$SRC/merged/"
  exit 0
fi
if [ "$RUN" = diag ]; then
  # Divergence diagnostic (distill/job/diag.py): no training, no outputs.
  python /data/code/distill/job/diag.py --data /data/distill/data "$@"
  exit 0
fi
mkdir -p /root/out
python /data/code/distill/job/train.py --data /data/distill/data --out /root/out "$@" 2>&1 | tee /root/out/train_stdout.log
# Plain byte copies: the bucket mount refuses chmod/rename (docs/DECISIONS.md).
mkdir -p "/data/distill/runs/$RUN"
cp -r --no-preserve=all /root/out/scrub-lora /root/out/train_log.json /root/out/train_stdout.log "/data/distill/runs/$RUN/" || true
ls -la "/data/distill/runs/$RUN/"
echo "saved to /data/distill/runs/$RUN"
