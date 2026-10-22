# Platform notes (Nebius x NVIDIA hackathon)

Researched 2026-10-19 from public docs. We have no API keys yet, so every row is `docs` (read in public docs, not tested with our account) until someone runs it and flips it to `verified`. If the docs say nothing, the row says "not found in docs". Some rows come from aggregators (`3p`). Treat those as hints only.

Deadline: 2026-10-30.

---

## 1. Nebius Token Factory (formerly Nebius AI Studio)

| Fact | Value | Source | Status |
|---|---|---|---|
| Base URL (OpenAI-compatible) | `https://api.tokenfactory.nebius.com/v1/` | https://docs.tokenfactory.nebius.com/ | docs |
| Auth header | `Authorization: Bearer $NEBIUS_API_KEY` | https://docs.tokenfactory.nebius.com/ | docs |
| List models | `GET /v1/models`. Optional query params: `verbose` (bool, default false; with it on, `RichModel` adds `pricing`, `context_length`, `supported_features`, `regions`), `ai_project_id` | https://docs.tokenfactory.nebius.com/api-reference/models/list-models.md | docs |
| Other endpoints | `/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/rerank`, `/v1/fine_tuning/jobs`, `/v0/dedicated_endpoints` | https://api.tokenfactory.nebius.com/openapi.json | docs |
| Tool calling | Supported. `tools` is a list of `{"type":"function","function":{name,description,parameters}}`. `tool_choice` accepts `none`, `auto`, `required` or a named function. The docs do not list which models support it; their only example model is `meta-llama/Meta-Llama-3.1-8B-Instruct-fast` | https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling.md , openapi.json | docs |
| Structured output | Guide shows `response_format: {"type":"json_schema", "json_schema": ...}` and `{"type":"json_object"}`. Models that support it carry a "JSON mode" tag on their model card. The OpenAPI field description says "Only {'type': 'json_object'} or {'type': 'text'} is supported", but the schema also defines `JsonSchemaResponseFormat`. The two sources disagree, so test it | https://docs.tokenfactory.nebius.com/ai-models-inference/json.md | docs |
| `guided_json` / `guided_regex` / `guided_choice` (vLLM style) | not found in docs (the request schema has an `extra_body` field) | openapi.json | docs |
| `reasoning_effort` param | Present in the ChatCompletionRequest schema | openapi.json | docs |
| Rate limits | Example baseline is 60 RPM and 400k TPM. Your real limits are in the dashboard. Limits adjust automatically every 15 min, up to 20x the base | https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md | docs |
| Zero data retention | Per organization, turned on from the profile page. With ZDR on, prompts and outputs "are not stored on our systems after each request is processed". Without ZDR, inputs and outputs may be kept (stored in Finland) for Speculative Decoding, which is on by default. Customer content is never used for training | https://docs.tokenfactory.nebius.com/legal/legal-quick-guide.md | docs |
| Region | Public serverless endpoints show Region "Global", and the processing location can change. For a fixed region, use a Dedicated Endpoint | https://docs.tokenfactory.nebius.com/public-serverless.md | docs |
| Fine-tuning (LoRA) base models | Only Qwen, Llama, gpt-oss, DeepSeek and Gemma. **No Nemotron models are listed.** LoRA models are deployed via Dedicated endpoints | https://docs.tokenfactory.nebius.com/post-training/models.md | docs |

### NVIDIA models on Token Factory (as far as public docs show)

| Model ID | Status in docs | Price per 1M in/out | Source | Status |
|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` (Nemotron 3 Super, 120B total / 12B active, hybrid MoE, up to 1M ctx) | Live since 2026-03-11. Recommended replacement for Llama-3.1-Nemotron-Ultra | $0.30 / $0.90 (3p only) | https://nebius.com/blog/posts/nemotron3-super-now-available , https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice.md , https://custom.typingmind.com/tools/estimate-llm-usage-costs/nebius/nemotron-3-super-120b-a12b | docs (ID inferred from the blog link URL) |
| `nvidia/Nemotron-3_5-Lightning` (30B A3B) | Recommended replacement for Llama-3.3-70B, Hermes-4-70B, Qwen3-32B and Nemotron-3-Nano-Omni | $0.06 / $0.24 (3p only) | August 2026 deprecation notice; https://custom.typingmind.com/tools/estimate-llm-usage-costs/nebius/nemotron-3-5-lightning | docs |
| `nvidia/Nemotron-3-Nano-Omni` | Removed from Serverless 2026-08-31 | n/a | August 2026 deprecation notice | docs |
| `nvidia/Llama-3_1-Nemotron-Ultra-253B-v1` | Removed from Serverless 2026-08-31 | n/a | August 2026 deprecation notice | docs |
| Nemotron 3 Ultra 550B A55B | Only aggregators mention it | $1.00 / $3.00 (3p) | https://custom.typingmind.com/tools/estimate-llm-usage-costs/nebius/nemotron-3-ultra-550b-a55b | 3p |
| Nemotron Nano V2 12B (VL) | Only aggregators mention it. The Nebius blog post on Nano 2 VL is dated 2025-10-28 | $0.07 / $0.20 (3p) | https://custom.typingmind.com/tools/estimate-llm-usage-costs/nebius/nemotron-nano-v2-12b | 3p |
| `nvidia/NVIDIA-Nemotron-Nano-9B-v2` | not found in docs | not found in docs | (search found no Nebius listing) | docs |

Official per-token prices: not found in docs. The page `https://nebius.com/token-factory/prices` redirects to `https://tokenfactory.nebius.com/organization/prices`, which only renders after login. The prices above come from aggregators and must be checked once we can log in.

### Model IDs from GET /v1/models (to be filled when key arrives)

```bash
curl -s https://api.tokenfactory.nebius.com/v1/models?verbose=true \
  -H "Authorization: Bearer $NEBIUS_API_KEY" | jq '.data[] | {id, context_length, pricing, supported_features}'
```

Verified 2026-10-22 with our key (28 models listed; NVIDIA rows below).

| Model ID | context_length | price in / out per 1M | supported_features | Notes |
|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | 262,144 | $0.30 / $0.90 (cache read $0.06) | tools, reasoning | **verified**: `tools` request returned a valid `measure{"what":"flr"}` call in 1.08 s (392 in / 50 out tokens, 24 reasoning) |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 262,144 | $0.06 / $0.24 | tools, reasoning | Nano-family candidate for the few-shot baseline (not tested yet) |
| `nvidia/Nemotron-3_5-Lightning` | 1,048,576 | $0.06 / $0.24 | tools, reasoning | listed |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | 1,048,576 | $1.00 / $3.00 | tools, reasoning | listed |
| `nvidia/Nemotron-3.5-Super-VL` | 1,048,576 | $0.30 / $0.90 | tools, reasoning | listed |

`nvidia/NVIDIA-Nemotron-Nano-9B-v2` is not served on Token Factory (verified: absent from the list).

## 2. Token Factory Nemotron Nano with tool calling

- No model named exactly "Nemotron Nano" can be confirmed as live on Token Factory Serverless today. `nvidia/Nemotron-3-Nano-Omni` was removed on 2026-08-31 (deprecation notice above). Status: docs.
- The small Nemotron that Nebius points to is `nvidia/Nemotron-3_5-Lightning` (30B total, 3B active). Third-party listings say Nebius exposes it with "reasoning, tool calling, structured output" (https://www.getmaxim.ai/bifrost/model-library/compare/nebius/nemotron-3_5-lightning.md, https://opper.ai/nvidia/nemotron-3-5-lightning). Nebius docs do not list per-model tool support. Status: 3p.
- Nemotron 3 Super is described as "designed for long-horizon planning, tool calling and high-accuracy instruction following" (blog). The post does not explicitly confirm `tools` support through the API. Status: docs.
- Plan: once the key arrives, check `supported_features` in `GET /v1/models?verbose=true`, then send one `tools` request to each candidate model.

## 3. Nebius AI Cloud Serverless AI (Endpoints, Jobs, Devlabs)

### CLI install and auth (macOS)

| Step | Command | Source | Status |
|---|---|---|---|
| Install | `curl -sSL https://artifacts.nebius.cloud/cli/install.sh \| bash` then `exec -l $SHELL` | https://docs.nebius.com/cli/install | docs |
| Check | `nebius version` | same | docs |
| Profile (opens a browser for login) | `nebius profile create --profile $PROFILE_NAME --endpoint api.nebius.cloud --federation-endpoint auth.nebius.com --parent-id $PROJECT_ID` (or run `nebius profile create` with no flags for interactive mode) | same | docs |
| Set project | `nebius config set parent-id <project_id>`. Check with `cat ~/.nebius/config.yaml` | https://docs.nebius.com/container-registry/quickstart | docs |
| Service account (CI) | see https://docs.nebius.com/cli/configure | | docs |
| Token for REST | `nebius iam get-access-token` | https://docs.nebius.com/container-registry/authentication | docs |

### Endpoints vs Jobs

| | Endpoint | Job |
|---|---|---|
| Purpose | Long-running server with a public URL | Runs to completion, no public URL |
| Stop/start | Yes: `nebius ai endpoint stop --id <id>` / `start --id <id>` | No (can only be deleted) |
| Timeout | n/a | `--timeout`, min `1h`, max `168h`, default `24h` |
| Restart | n/a | `--restart-policy on-failure\|never` |
| REST | `https://api.nebius.cloud/ai/v1/endpoints` | `https://api.nebius.cloud/ai/v1/jobs` |
| Source | https://docs.nebius.com/serverless/endpoints/manage | https://docs.nebius.com/serverless/jobs/manage |

Status for this table and the next: docs. Endpoint creation takes "approximately five minutes".

### Endpoint create (reference example from docs)

```bash
nebius ai endpoint create \
  --name my-chatbot \
  --image vllm/vllm-openai:latest \
  --container-command "python3 -m vllm.entrypoints.openai.api_server" \
  --container-port 8000 \
  --args "--model $MODEL_ID --host 0.0.0.0 --port 8000" \
  --env KEY=value,KEY2=value2 \
  --env-secret HF_TOKEN=<secretstash-secret> \
  --auth token --token "$(openssl rand -hex 32)" \
  --volume "s3://bucket:/models:ro:default" \
  --subnet-id vpcsubnet-e*** \
  --platform gpu-h100-sxm --preset 1gpu-16vcpu-200gb \
  --disk-size 250Gi --shm-size 16Gi \
  --public
```

Job create: `nebius ai job create --name ... --image ... --container-command bash --args "-c ..." --platform gpu-l40s-a --preset 1gpu-8vcpu-32gb --timeout 1h --volume ... --env ... --working-dir ...`. Logs: `nebius ai job logs $JOB_ID`. Status: `nebius ai job get $JOB_ID` (state reaches `COMPLETED`). Interactive wizard: `nebius ai create`.

### Container contract

| Item | What docs say | Source | Status |
|---|---|---|---|
| Image | `registry/path:tag` or `@digest`. Any public registry, a private one (`--registry-username/--registry-password` or `--registry-secret`), or Nebius Container Registry in the same project (no credentials needed) | endpoints/manage | docs |
| Ports | `--container-port N`, more than one allowed. Each HTTP port is served at the managed HTTPS URL. gRPC goes through the HTTPS URL. TCP uses `tls://<host>:443` | endpoints/manage | docs |
| Bind address | The vLLM tutorial uses `--host 0.0.0.0 --port 8000` | https://docs.nebius.com/serverless/tutorials/deploy-model | docs |
| Health check / readiness probe | not found in docs (the tutorial just waits for status `RUNNING`) | | docs |
| Statuses | PROVISIONING, STARTING, IMAGE_PULLING, RUNNING, STOPPING, STOPPED, ERROR, DELETING | https://docs.nebius.com/serverless/lifecycle | docs |
| Env vars | `--env k=v,k2=v2` | endpoints/manage | docs |
| Secrets | SecretStash (formerly MysteryBox): `--env-secret KEY=<secret name or ID>`, where the key must match the secret's payload key. `--token-secret` reads the payload key `AUTH_TOKEN` | endpoints/manage, https://docs.nebius.com/mysterybox/overview | docs |
| Files | `--inject-file local:/container/path`, read-only, max 64 KiB each | endpoints/manage | docs |
| Disk | Default 250Gi. At least 50 GiB for GPU workloads. Container disk is wiped on stop/delete | endpoints/manage, overview | docs |
| `/dev/shm` | Default 16Gi | endpoints/manage | docs |
| Public URL format | Managed `https://...`, read from `.status.public_endpoints[]`: `nebius ai endpoint get <id> --format json \| jq -r '.status.public_endpoints[] \| select(startswith("https://"))'`. Hostname pattern not found in docs | endpoints/manage | docs |
| Auth | Off by default. With `--auth token`, callers send `Authorization: Bearer <token>`. Requests without it get 401/403 | endpoints/manage, quickstart/endpoints | docs |
| Traffic limits | 120 Mbps and 300 new connections/s per endpoint (served through Nebius Tunnels) | endpoints/manage | docs |
| Autoscaling / replicas / scale-to-zero | not found in docs. Only manual stop/start exists. A stopped endpoint is not billed for compute or storage (mounted buckets are still billed) | overview, pricing-quotas | docs |
| Regions | All regions except private `eu-north2` | https://docs.nebius.com/serverless | docs |

### GPU platforms, presets, prices (on-demand, from 2026-10-08)

| GPU | Platform | 1-GPU preset | Region(s) | USD per GPU-hour | Preemptible |
|---|---|---|---|---|---|
| L40S 48GB | `gpu-l40s-a` (Intel) | `1gpu-8vcpu-32gb` (also 16/24/32/40 vCPU) | eu-north1 | $1.35 GPU + $0.012/vCPU-h + $0.0032/GiB-h | $0.65 |
| L40S 48GB | `gpu-l40s-d` (AMD) | `1gpu-16vcpu-96gb`, `1gpu-32vcpu-192gb` | eu-north1 | $1.35 + CPU/RAM | $0.65 |
| RTX PRO 6000 96GB | `gpu-rtx6000`, `gpu-rtx6000-a` | `1gpu-24vcpu-218gb` | us-central1; uk-south2, eu-south1 | $1.80 | from $0.79 (spot) |
| H100 80GB | `gpu-h100-sxm` | `1gpu-16vcpu-200gb` | eu-north1 | $4.50 (was $3.85 before Oct 1) | from $0.79 (spot) |
| H200 141GB | `gpu-h200-sxm` | `1gpu-16vcpu-200gb` | eu-north1, eu-west1, us-central1 | $5.40 | from $0.79 (spot) |
| B200 180GB | `gpu-b200-sxm`, `-a` | `1gpu-20vcpu-224gb` | us-central1, me-west1 | $8.50 | from $0.99 (spot) |
| B300 288GB | `gpu-b300-sxm` | `1gpu-24vcpu-346gb` | uk-south1, eu-west2, us-north1 | $9.50 | from $0.99 (spot) |

Sources: https://docs.nebius.com/compute/virtual-machines/types , https://docs.nebius.com/compute/resources/pricing (billed per second). Serverless AI uses Compute pricing and has no separate price list (https://docs.nebius.com/serverless/pricing-quotas). Status: docs. The pricing page does not say whether H100/H200 prices include vCPU and RAM. L40S lists CPU and RAM as separate lines.

### Object Storage (S3) and Container Registry

| Item | Value | Source | Status |
|---|---|---|---|
| S3 endpoint | `https://storage.<region>.nebius.cloud`, e.g. `https://storage.eu-north1.nebius.cloud` | https://docs.nebius.com/object-storage/interfaces/aws-cli | docs |
| AWS CLI config | `aws configure set region eu-north1` + `aws configure set endpoint_url https://storage.eu-north1.nebius.cloud` + access key ID and secret | same | docs |
| Mount into job/endpoint | `--volume 's3://bucket:/path:rw:default'` or `--volume 'storagebucket-e***:/output:rw'` | serverless/endpoints/manage | docs |
| Registry host | `cr.<region>.nebius.cloud`, e.g. `cr.eu-north1.nebius.cloud` | https://docs.nebius.com/container-registry/quickstart | docs |
| Create registry | `nebius registry create --name <n> --format json \| jq -r ".metadata.id" \| cut -d- -f 2` (gives the path) | same | docs |
| Docker auth | `nebius registry configure-helper` (credential helper). For CI: `nebius iam get-access-token \| docker login cr.<region>.nebius.cloud ...` | https://docs.nebius.com/container-registry/authentication | docs |
| Push | `docker push cr.$REGION_ID.nebius.cloud/$REGISTRY_PATH/<image>:<tag>` | quickstart | docs |

## 4. vLLM + nvidia/NVIDIA-Nemotron-Nano-9B-v2

| Fact | Value | Source | Status |
|---|---|---|---|
| Architecture | `NemotronHForCausalLM`, hybrid Mamba-2 + MLP with 4 attention layers. 56 layers, hidden 4480, BF16, 128K context (`max_position_embeddings` 131072) | https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2 , `config.json` | docs |
| License | NVIDIA Open Model License, "ready for commercial use" | model card | docs |
| Min vLLM | `pip install -U "vllm>=0.10.1"`. Docker image `vllm/vllm-openai:v0.10.1`. Latest on PyPI is `0.32.0`. The Nebius tutorial uses `vllm/vllm-openai:v0.18.0-cu130` | model card, https://pypi.org/project/vllm/ , Nebius deploy-model tutorial | docs |
| Serve (base) | `vllm serve nvidia/NVIDIA-Nemotron-Nano-9B-v2 --trust-remote-code --max-num-seqs 64 --mamba_ssm_cache_dtype float32` ("for accurate quality"). Docker example adds `--max-model-len 131072` | model card | docs |
| Tool calling | `git clone https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2`, then add `--enable-auto-tool-choice --tool-parser-plugin "NVIDIA-Nemotron-Nano-9B-v2/nemotron_toolcall_parser_no_streaming.py" --tool-call-parser "nemotron_json"`. The plugin file name says no streaming, so expect no tool-call streaming | model card | docs |
| Reasoning toggle | Put `/think` (default) or `/no_think` in the system prompt, or in a user message for one turn. With `/no_think` the chat template inserts `<think></think>`. Thinking budget is controlled client-side (`max_thinking_tokens` pattern in the card) | model card | docs |
| Reasoning parser | The model card names none. vLLM main has `nemotron_v3` but no Nano-v2-specific parser | model card, https://github.com/vllm-project/vllm/blob/main/vllm/reasoning/__init__.py | docs |
| LoRA in vLLM | The supported-models table shows `NemotronHForCausalLM` with LoRA ✅ and PP ✅. Source code declares `SupportsLoRA`, `packed_modules_mapping = {"qkv_proj": [q,k,v]}`, and `lora_skip_prefixes = ["mtp."]`. Start with `--enable-lora --lora-modules name=/path --max-lora-rank N`. Whether adapters on Mamba `in_proj`/`out_proj` load: not found in docs | https://docs.vllm.ai/en/latest/models/supported_models.html , https://github.com/vllm-project/vllm/blob/main/vllm/model_executor/models/nemotron_h.py | docs |
| HF PEFT target module names | Linear layers in `modeling_nemotron_h.py`: Mamba `in_proj`, `out_proj`; MLP `up_proj`, `down_proj` (no gate_proj); attention `q_proj`, `k_proj`, `v_proj`, `o_proj` | https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2/blob/main/modeling_nemotron_h.py | docs |
| TRL/PEFT officially supported? | not found in docs. NVIDIA documents LoRA through Megatron Bridge (`nemotron_nano_9b_v2_peft_config`, `peft_scheme="lora"`, LR 1e-4, seq 2048). Transformers tested on 4.48.3 with `trust_remote_code`. Fast paths need `mamba-ssm` and `causal-conv1d` (the modeling file checks for them) | https://docs.nvidia.com/nemo/megatron-bridge/latest/models/nemotron/nemotronh.html , model card | docs |
| GPU memory | No minimum stated. Tested on A10G 24GB and H100 80GB. Our own estimate (not from docs): BF16 weights are about 18 GB, so an L40S 48GB (`gpu-l40s-a`) should serve it at a reduced `--max-model-len`; LoRA training fits better on an H100 | model card | docs |

Fallback if vLLM LoRA fails on NemotronH: merge the adapter in PEFT (`PeftModel.from_pretrained(base, adapter).merge_and_unload()` then `save_pretrained`), copy the remote-code files (`*.py`, tokenizer) next to it, and serve the merged folder with the same flags. Second fallback: target only the attention + MLP modules (q/k/v/o, up/down), which vLLM's packed mapping clearly covers.

## 5. VISTA-3D / NV-Segment-CT

| Fact | Value | Source | Status |
|---|---|---|---|
| HF repo | `nvidia/NV-Segment-CT` (library `monai`). Also `MONAI/VISTA3D-HF`. Training code: https://github.com/NVIDIA-Medtech/NV-Segment-CTMR | https://huggingface.co/nvidia/NV-Segment-CT | docs |
| MONAI bundle | `pip install "monai[fire,ignite]" requests huggingface_hub` then `python -m monai.bundle download "vista3d" --bundle_dir "bundles/"`. Bundle v0.5.13, MONAI 1.4.0 | https://github.com/Project-MONAI/model-zoo/tree/dev/models/vista3d | docs |
| Bundle inference | `python -m monai.bundle run --config_file configs/inference.json --input_dict "{'image':'x.nii.gz','label_prompt':[1,26]}"`. Batch: add `configs/batch_inference.json` with `--input_dir/--output_dir`. TensorRT: add `configs/inference_trt.json` | bundle docs/README.md | docs |
| HF entry point | `HuggingFacePipelineHelper("vista3d").init_pipeline(<model_dir>, device=cuda)` then `pipeline(inputs, output_dir=...)` | HF card | docs |
| Input | CT NIfTI, given as an absolute path (bundle/HF) or a URL (NIM; NIfTI or NRRD). Resampled to `resample_spacing` [1.5,1.5,1.5] mm. Intensity window a_min -963.8, a_max 1053.7. Patch 128^3, sliding window | bundle `configs/inference.json` | docs |
| Point prompts | `points: [[x,y,z],...]` "IN THE ORIGINAL IMAGE SPACE" (voxel indices). `point_labels`: 1 foreground, 0 background, -1 ignore. Points only work for a single object (B must be 1). `use_point_window: true` runs a local window around the clicks | HF card, bundle docs/inference.md | docs |
| Class prompts | `label_prompt: [ids]`. With no prompt it runs "everything", 117 classes: `set(1..132) - {2,16,18,20,21,23,24,25,26,27,128..132}`. **Hepatic vessel (25) and hepatic tumor (26) are NOT in the everything set, so prompt them explicitly.** Ids 2/20/21 (kidney, lung, bone) expand into subclasses and cannot be combined with points. Zero-shot ids 133 to 254 need points | HF card | docs |
| Label ids we care about | 1 liver, 6 aorta, 7 inferior vena cava, 17 portal vein and splenic vein, 25 hepatic vessel, 26 hepatic tumor, 5 right kidney, 14 left kidney, 3 spleen, 4 pancreas, 10 gallbladder. Metadata defines ids 0 to 132 (133 entries incl. background) | bundle `configs/metadata.json` | docs |
| Output | NIfTI label map (`.nii.gz`, float32, postfix `trans`) in the original image space. The NIM returns a zip (`curl -o output.zip`) | inference.json, NIM getting-started | docs |
| Speed | NIM, 256^3 volume, everything: H100 3.0 s (TRT 2.7 s), A100 7.1 s, L40S 8.8 s. Bundle on a 16GB V100: 512^3 at 1.5mm takes 2m09s | https://docs.nvidia.com/nim/medical/vista3d/1.0.0/performance.md , bundle docs/inference.md | docs |
| GPU memory | NIM support matrix lists A100/H100 80GB and L40S 48GB (FP32). The bundle runs on a 16GB V100. TRT `max_prompt_size` 4 needs 16 GB. Out-of-memory fixes: patch 96^3, run postprocessing on CPU | NIM support-matrix, bundle README | docs |
| License | Code: Apache 2.0. Weights: the HF card says NVIDIA Open Model License; the MONAI bundle README says "NCLS v1" (non-commercial). Both say research use only, "not for clinical usage" | HF card, bundle README | docs |
| NIM option | `docker login nvcr.io --username='$oauthtoken' --password=$NGC_API_KEY`, then `docker run -p 8000:8000 -e NGC_API_KEY nvcr.io/nim/nvidia/vista3d:1.0.0`. Endpoints: `GET /v1/health/ready`, `/v1/health/live`, `/v1/vista3d/info`, `POST /v1/vista3d/inference` with `{"image": "<url>", "prompts": {"classes": ["liver"], "points": {"liver": [[x,y,z]]}}}`. Needs an NGC key. The NIM license is the AI Foundation Models Community License | https://docs.nvidia.com/nim/medical/vista3d/1.0.0/getting-started.md , api-reference.md | docs |
| Hosted API | Playground at https://build.nvidia.com/nvidia/vista-3d. A forum thread reports that `health.api.nvidia.com/v1/medicalimaging/nvidia/vista-3d` returns 200 with no file. Output retrieval not found in docs | https://forums.developer.nvidia.com/t/vista-3d-hosted-api/366762 | docs |

## 6. Tavily

| Fact | Value | Source | Status |
|---|---|---|---|
| Endpoint | `POST https://api.tavily.com/search`, header `Authorization: Bearer tvly-...` | https://docs.tavily.com/documentation/api-reference/endpoint/search | docs |
| `include_domains` | Array, up to 300 domains. A hard filter, unless `include_domains_mode: "prefer"`. `exclude_domains` takes up to 150 | same | docs |
| `include_raw_content` | `false` (default), `true`/`"markdown"`, or `"text"` | same | docs |
| Other params | `search_depth`: `basic` (default), `advanced`, `fast`, `ultra-fast`. `max_results` 0 to 20 (default 10). `topic`: `general`/`news`/`finance`. `include_answer` | same | docs |
| Cost | basic/fast/ultra-fast cost 1 credit, advanced costs 2 | https://docs.tavily.com/documentation/api-credits | docs |
| Free tier | 1,000 credits/month, no card needed | same | docs |
| Paid | Project $30 for 4k credits, Bootstrap $100 for 15k, Startup $220 for 38k, Growth $500 for 100k. Pay-as-you-go $0.008/credit | same | docs |

---

## Open questions to verify once keys arrive

- [ ] `GET /v1/models?verbose=true` on Token Factory: fill in the table in section 1, and confirm the exact IDs for Nemotron 3 Super and Nemotron 3.5 Lightning, plus whether any 9B/Nano model is listed.
- [ ] Check `supported_features` for tools and JSON schema on each Nemotron model, then send one live `tools` request and one `response_format: json_schema` request (the docs and the OpenAPI disagree).
- [ ] Find real per-token prices in the logged-in prices page. Replace the aggregator numbers.
- [ ] Turn on ZDR at the org level and screenshot the setting for the writeup.
- [ ] Serverless endpoint: is there any health/readiness probe setting? Does the managed URL wait until our port answers? What is the hostname pattern?
- [ ] Is there a GPU quota in our project? Which regions have H100 (eu-north1 only) or L40S for our tenant?
- [ ] Endpoint cold start time (image pull plus model load) after `nebius ai endpoint start`.
- [ ] Do the H100/H200 hourly prices include vCPU and RAM?
- [ ] vLLM: does `--enable-lora` load a PEFT adapter for Nemotron-Nano-9B-v2 that targets Mamba `in_proj`/`out_proj`? If not, use attention + MLP targets only, or merge.
- [ ] Tool-call parser plugin with the current vLLM (0.18 to 0.32): does `nemotron_json` still load?
- [ ] VISTA-3D: bundle versus NIM on Nebius (the NIM needs an NGC key). Measure seconds per liver CT on L40S, and check that point coordinates match our viewer's voxel indexing (x,y,z order).
- [ ] Weights license conflict (NOML vs NCLS v1) for VISTA-3D: confirm which applies to the checkpoint we use.
- [ ] Tavily key: check the free 1,000 credits and test `include_domains` filtering on medical domains.

## Account state (verified 2026-10-22 with the CLI, v0.12.294)

| Fact | Value | Status |
|---|---|---|
| Tenant | `tenant-e00er0mmfz65nbq1kn` (hackathon-jv8) | verified |
| Project we use | `project-e00dsq9rpr00td1s892p1d` (default-project-eu-north1), region eu-north1 | verified |
| Project state | Was `SUSPENDED` ("Billing: Not configured"); `ACTIVE` after billing was set up on 2026-10-22 | verified |
| GPU platforms in eu-north1 | gpu-h100-sxm, gpu-h200-sxm, gpu-l40s-a, gpu-l40s-d, gpu-gb300 | verified |
| Quota eu-north1 | compute GPUs: H100 8, H200 8, L40S 8; `msp.cloudapps.gpu.h100` 16 (H200 and L40S 0); **non-GPU vCPU 0** | verified |
| Serverless quota | Jobs on `cpu-d3` fail with `ResourceExhausted ... compute.instance.non-gpu.vcpu (limit 0, requested 4)`: Serverless CPU workloads count against the compute vCPU quota, not `msp.cloudapps.cpu` (272) | verified |
| GPU Job smoke test | `nebius ai job create --image nvidia/cuda:12.4.1-base-ubuntu22.04 --platform gpu-h100-sxm --preset 1gpu-16vcpu-200gb --disk-size 100Gi --timeout 1h --restart-policy never --async` ran `nvidia-smi`: NVIDIA H100 80GB HBM3, 81559 MiB, driver 580.173.02. States PROVISIONING (~50 s) -> STARTING -> IMAGE_PULLING -> COMPLETED; about 2 min from create to done. No `--subnet-id` needed | verified |
