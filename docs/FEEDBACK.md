# Platform feedback (Nebius Token Factory, Nebius AI Cloud, NVIDIA models)

Written as we go. Each entry: what we tried, exact steps, what happened, what would have helped. Pasted into the Devpost form at submission.

## Token Factory

_(entries start when the API key arrives)_

## AI Cloud: Serverless Endpoints

## AI Cloud: Serverless Jobs

## NVIDIA models (Nemotron 3 Super, Nemotron Nano 9B v2, VISTA-3D)

## What worked well

- 2026-10-22, CLI setup: `nebius profile create` accepts the tenant display name (`hackathon-jv8`) at the "Set Tenant ID" prompt, then fails with "'hackathon-jv8' is invalid for parentId" and still saves the name as `tenant-id`. Suggest: list tenants to pick from, or validate the `tenant-` prefix at the prompt.
- 2026-10-22, onboarding: the hackathon tenant comes with GPU quota but the project is `SUSPENDED` until billing is configured, and the CLI does not say so until you inspect the project. A banner in `nebius iam whoami` or on first use would save time.
- 2026-10-22, Serverless quota: a CPU-only Serverless Job fails with `compute.instance.non-gpu.vcpu (limit 0)` while the tenant shows `msp.cloudapps.cpu` 272 and 8 H100s. A GPU job works right away. It was not obvious which quota Serverless CPU uses, and a hackathon tenant that can run H100s but not a 4-vCPU API server is surprising. Suggest a small default CPU quota for Serverless, or naming the quota in the Serverless docs.
- 2026-10-22, what worked well: the first GPU Job (`nvidia-smi` on H100) needed no subnet, no registry setup and no YAML; one CLI command, done in about 2 minutes.
