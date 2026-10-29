# Platform feedback (Nebius Token Factory, Nebius AI Cloud, NVIDIA models)

Written as we go. Each entry: what we tried, exact steps, what happened, what would have helped. Pasted into the Devpost form at submission.

## Token Factory

- 2026-10-22 to 25, what worked well: Nemotron 3 Super's native tool calling through the OpenAI-compatible API needed no adapter code. The same `openai` client talks to Token Factory and to our vLLM endpoint, so the router is two base URLs. 29.8M prompt tokens of teacher traces cost $10.17.
- 2026-10-25, fine-tuning: Token Factory's LoRA fine-tuning lists Qwen, Llama, gpt-oss, DeepSeek and Gemma, but no Nemotron models. Distilling into Nemotron Nano therefore needed an AI Cloud Job, a merge Job and a self-managed vLLM endpoint. Nemotron as a fine-tuning base, with serverless LoRA serving, would remove three steps.

## AI Cloud: account, quotas and CLI

- 2026-10-22, CLI setup: `nebius profile create` accepts the tenant display name (`hackathon-jv8`) at the "Set Tenant ID" prompt, then fails with "'hackathon-jv8' is invalid for parentId" and still saves the name as `tenant-id`. Suggest: list tenants to pick from, or validate the `tenant-` prefix at the prompt.
- 2026-10-22, onboarding: the hackathon tenant comes with GPU quota but the project is `SUSPENDED` until billing is configured, and the CLI does not say so until you inspect the project. A banner in `nebius iam whoami` or on first use would save time.
- 2026-10-22, Serverless quota: a CPU-only Serverless Job fails with `compute.instance.non-gpu.vcpu (limit 0)` while the tenant shows `msp.cloudapps.cpu` 272 and 8 H100s. A GPU job works right away. It was not obvious which quota Serverless CPU uses, and a hackathon tenant that can run H100s but not a 4-vCPU API server is surprising. Suggest a small default CPU quota for Serverless, or naming the quota in the Serverless docs.
- 2026-10-25, quotas: `compute.instance.count` is 2 for the tenant, which means one training Job plus one Endpoint is the maximum. The error only appears at create time. A hackathon tenant with 8 H100s of quota but 2 instances is a surprising combination; showing the instance cap on the quotas page next to GPU counts would help.

## AI Cloud: Serverless Endpoints

- 2026-10-25, Serverless Endpoint cold start: serving merged Nano 9B v2 weights (18 GB) from a mounted bucket took 25 min 17 s from create to the first answer on `/v1/models` (vLLM 0.11, H100). The base model, downloaded from Hugging Face to local disk, was much faster. Reading large weights through the bucket mount looks like the bottleneck. A documented fast path for model weights (local NVMe cache, or a note on expected mount throughput) would help anyone serving their own fine-tune.
- 2026-10-25, Serverless Endpoint public URL: during a 256-request eval at 4 to 8 concurrent requests, a share of requests through the `*.tunnel.applications.eu-north1.nebius.cloud` URL hung until the 30 s client timeout or failed with connection errors, while vLLM's own log showed no queue and no errors, and `/v1/models` answered in 0.6 s a minute later. One run lost 17 of 256 requests, the next 205 of 256. We could not tell from the CLI whether the tunnel or the instance dropped them. Tunnel-side request logs or a status/latency metric for the public URL would make this debuggable.
- 2026-10-25, CLI output: `nebius ai endpoint create --async --format json` returned a document without `metadata.id` (our script, which parsed it on 2026-10-24, failed with KeyError), while the endpoint was created. A stable shape for `--async` create output, documented, would keep scripts working.
- 2026-10-28, Serverless Endpoint restart: `nebius ai endpoint start` on the stopped merged-LoRA endpoint took 17 min 35 s until `/v1/models` answered (states seen: IMAGE_PULLING, then RUNNING several minutes before vLLM was ready). A RUNNING state that does not mean "serving" confused our scripts; a readiness probe setting, or a READY state tied to the container port, would fix it.
- 2026-10-28, regions: the hackathon tenant has non-GPU vCPU quota only in eu-south1 (200) and none in eu-north1, where the GPUs and our bucket are. A CPU API server next to its GPU model therefore has to live in another region. Defaulting a small CPU quota into every GPU region would keep simple architectures in one place.

## AI Cloud: Serverless Jobs

- 2026-10-22, Serverless volumes: `--volume s3://bucket:/data:rw` fails with `spec.volumes[0].s3_config.endpoint: value is required` and the help text does not say where the endpoint comes from (it reads the local AWS profile). The `storagebucket-<id>:/data:rw` form works with no credentials and is the better default to document first.
- 2026-10-22, bucket mount semantics: on a mounted bucket, rename, chmod and append all fail with EPERM. This breaks `huggingface_hub.snapshot_download`, `shutil.copy` and log files opened with "a". A short "what the mount supports" list in the Serverless docs would have saved three job runs.
- 2026-10-25, Serverless logs: `nebius ai job logs` returns only recent output, so a training job's early loss lines were unrecoverable once a progress bar had written enough. A "download full log" option, or keeping the complete stdout in the job's history, would help debugging.
- 2026-10-29, cold start for a per-request job: an upload's vista3d-full job spent 4 min 39 s between create and start (provisioning and pulling the 3 GB PyTorch image), then 65 s running, of which VISTA-3D inference was 4.2 s. For interactive jobs, a warm pool or an image cache per project would turn a 6-minute wait into about a minute. Nothing in the docs says how long provisioning usually takes, so we could not set user expectations ahead of time.
- 2026-10-29, starting jobs from an app: launching a Serverless Job from our backend needs a service account key, and the only group we could use (editors) gives that key far more than "create jobs in one project". A narrow built-in role such as "ai.jobs.creator" would let an app start jobs without holding editor rights.

## NVIDIA models (Nemotron 3 Super, Nemotron Nano 9B v2, VISTA-3D)

- 2026-10-25, Nemotron Nano 9B v2 on vLLM 0.11: `--enable-lora` fails at startup on the NemotronH architecture (`assert isinstance(module, BaseLayerWithLoRA)`), so we merged the adapter into the weights. The tool-call parser ships as a plugin file in the model repo, which means the base repo must be downloaded even when serving merged weights. A note on LoRA support status in the model card would save a failed launch.
- 2026-10-22, VISTA-3D: liver Dice 0.959 to 0.980 on 8 MSD scans at about 5 s per scan on one H100, with class prompts. Lesions under about 1 mL come back labelled as liver.

## What worked well

- 2026-10-22, what worked well: the first GPU Job (`nvidia-smi` on H100) needed no subnet, no registry setup and no YAML; one CLI command, done in about 2 minutes.
- 2026-10-28, what worked well: a CPU Serverless Endpoint from the public `python:3.11-slim` image, with our bootstrap script passed by `--inject-file` and keys from SecretStash by `--env-secret`, was serving in about 4 minutes. No registry, no Dockerfile build.
