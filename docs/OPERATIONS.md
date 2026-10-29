# Operations: starting, stopping and guarding the endpoints

Four Nebius resources serve the hosted demo, and one Serverless Job runs per uploaded scan. The frontend is static on Vercel (`scrubplus.vercel.app`).

| Resource | ID | Region | Cost when running | Needed for |
|---|---|---|---|---|
| `scrub-backend` (FastAPI router) | `aiendpoint-e07ca70g7h017hbs4s` | eu-south1 (`project-e07gy4etma00qzp4yapzqb`) | cpu-d3, 2 vCPU | Every agent call from the hosted app |
| `scrub-nano-scrub` (vLLM, Nano 9B v2 + LoRA) | `aiendpoint-e00wgg4g34x43z1mcc` | eu-north1 | 1x H100, about $4.50 per hour | The router's fast path |
| `scrub-nano-base` (vLLM, base 9B) | `aiendpoint-e00drkq0b76g6b5d2w` | eu-north1 | 1x H100 | Eval only; keep stopped |
| `vista3d-point` (VISTA-3D point prompts, `vista/point/`) | `aiendpoint-e00wtmh8t3jx0awzzc` | eu-north1 | 1x H100, about $4.50 per hour | Alt-click and "what's this?" |
| `vista3d-upload_<id>` Serverless Jobs (`vista/job/`) | one per upload | eu-north1 | 1x H100 while it runs (about 1 min of container time) | "Segment on Nebius" after an upload |

## Commands

```bash
nebius ai endpoint list                                   # eu-north1 (default profile)
nebius ai endpoint list --parent-id project-e07gy4etma00qzp4yapzqb   # eu-south1
nebius ai endpoint start --id aiendpoint-e00wgg4g34x43z1mcc   # Nano: about 18 to 25 min until /v1/models answers
nebius ai endpoint stop  --id aiendpoint-e00wgg4g34x43z1mcc
nebius ai endpoint start --id aiendpoint-e07ca70g7h017hbs4s   # backend: about 4 min (downloads the pinned commit, pip install)
nebius ai endpoint start --id aiendpoint-e00wtmh8t3jx0awzzc   # vista3d-point: image pull, pip install, model load
nebius ai endpoint stop  --id aiendpoint-e00wtmh8t3jx0awzzc
bash vista/point/launch.sh                                # a new vista3d-point endpoint; writes POINT_BASE_URL to .env
curl -s "$BACKEND_URL/api/health"                         # {"ok":true,"token_factory":true,"nano":true,...}
```

Redeploy the backend at a new commit: push, then `make deploy` (creates a new endpoint and writes `BACKEND_URL` to `.env`; delete the old one, and rebuild the frontend if the URL changed, since `scripts/build-web.mjs` carries it).

## What happens when something is off

- **Nano stopped:** the router's 1.5 s call fails fast and the request goes to Nemotron 3 Super on Token Factory. The app keeps working, at Super's latency and cost. The Under the hood drawer shows the Super model name and "escalated".
- **Backend stopped or over budget:** the browser's agent request fails, the client skips the agent for 30 s, and the v1 regex grammar handles commands. Every engine feature still works.
- **vista3d-point stopped:** alt-click says "Segmentation service warming up." and nothing else changes.
- **Upload jobs unavailable** (no service-account key in the backend): the health check reports `scans: false` and the app never offers "Segment on Nebius"; uploads still open in the browser.
- **Tavily or Token Factory down:** committed rule cards still load (they are bundled); a device without a card keeps the default rules, labelled as such.

## Guards

- `AGENT_RPM` (30) and `RULES_RPM` (3): requests per minute per IP (first `X-Forwarded-For` hop). Over the limit: HTTP 429.
- `DAILY_BUDGET_USD` (15): Token Factory spend per UTC day, from Super's token counts at $0.30 / $0.90 per 1M. Over budget: HTTP 503 and the app falls back to the grammar. Counters are in memory and reset on restart.
- `SCANS_PER_HOUR` (3 per IP) and `SCANS_PER_DAY` (20 for everyone): each upload starts an H100 job. Uploads over 300 MB get HTTP 413. `POINT_RPM` (12 per IP) for point prompts.
- Keys (`NEBIUS_TF_API_KEY`, `TAVILY_API_KEY`, `NANO_API_KEY`, `POINT_API_KEY`, the bucket keys and the job service-account key `NEBIUS_SA_KEY_JSON`) live in the SecretStash secret `scrub-backend` in eu-south1, never in the image or the client bundle.
- The job service-account key belongs to `scrub-storage` (editors group) and expires 2026-12-31. Create it with `nebius iam auth-public-key generate --service-account-id serviceaccount-e00hvvt4n5m4e9ajm0 --expires-at 2026-12-31T23:59:59Z --output ~/.nebius/scrub-jobs-sa.json`, set `NEBIUS_SA_KEY_FILE` in `.env`, then `make deploy`.

## Judging plan (Dec 1 to 15)

- Backend: running throughout (CPU).
- Nano: one H100 around the clock for 15 days is about $1,620. Default: stopped, with Super as the fallback; start it for recording and on request. This is a product-owner decision; change it here if it changes.
- vista3d-point: same trade-off as Nano (about $1,620 for 15 days). Default: stopped; alt-click then says the service is warming up. Start it for recording and on request.
- Check daily: `curl $BACKEND_URL/api/health` and `node scripts/smoke-prod.mjs`.
