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
