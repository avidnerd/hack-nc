# Submission checklist

Stage 1 is pass/fail. Every box must be checked before Devpost submit (internal deadline Oct 29, 8:00 PM ET; hard deadline Oct 30, 10:00 AM PT).

- [x] At least one **NVIDIA open model** used **at runtime** (Nemotron 3 Super, Nemotron Nano 9B v2 + our LoRA, VISTA-3D / NV-Segment-CT, optionally Parakeet)
  - [x] Nemotron 3 Super called at runtime from the hosted backend (router fallback, rule extraction; verified 2026-10-28 from scrubplus.vercel.app)
  - [x] Nano 9B v2 + LoRA served at runtime and reached by the hosted app through the router (`scrub`, 573 ms, smoke-prod 2026-10-28)
  - [x] VISTA-3D: full-scan Serverless Job (H100) segments the 8 gallery scans; Dice in docs/RESULTS.md; the same Job segments uploaded scans (`/api/scans`); Serverless Endpoint `vista3d-point` answers alt-click point prompts (`metrics/vista_point.jsonl`)
- [x] Runtime use of **Nebius Token Factory** inference API (Super from `/api/agent` and `/api/rules`)
- [x] Runtime use of **Nebius AI Cloud** (Serverless Endpoints `scrub-backend`, `scrub-nano-scrub`, `vista3d-point`; Serverless Jobs `vista3d-full` (gallery and uploads), `distill-nano`)
- [x] Hosted **demo URL** works for a judge **without a webcam and without a microphone** (`scripts/judge-path.mjs`, `metrics/judge_path.json`)
  - [ ] A friend on a laptop with no webcam completes the 2-minute path cold (human check)
- [x] Public repo (github.com/avidnerd/hack-nc)
- [x] **MIT license** file in repo (`LICENSE`, added 2026-10-19)
- [x] MIT license visible in the GitHub About sidebar (GitHub detects MIT, verified 2026-10-29)
- [x] README with setup instructions
- [x] README section titled exactly **"NVIDIA models used"**
- [x] README section titled exactly **"How Nebius Token Factory and AI Cloud are used"**
- [ ] YouTube video **under 3:00**, public, shows the project running (script: docs/VIDEO.md)
- [ ] Track selected: **Best Apps and Agents**
- [x] Written note in README ("What was built during this hackathon") with the list of v2 additions; paste into Devpost
- [x] Platform feedback written (`docs/FEEDBACK.md`)
  - [ ] Pasted into the Devpost form
- [x] Third-party licenses respected and listed in README:
  - [x] MSD (CC BY-SA 4.0)
  - [x] TotalSegmentator (Apache 2.0 code / CC BY 4.0 data)
  - [x] VISTA-3D (code Apache 2.0, weights NVIDIA Open Model License, research use only)
  - [x] Nemotron (NVIDIA Open Model License)
  - [x] Tavily ToS (Tavily is used at runtime by `/api/rules`; cards cached in `data/device_rules/`)
- [x] No closed-model calls left in the hosted build (`api/llm.ts` deleted, `src/ai/llm.ts` closed; bundle grep for Gemini/Anthropic hosts is empty)
- [x] No secrets in the repo or client bundle (`scripts/check-secrets.sh --all` passes; build-web greps the bundle)
- [x] Git history has no AI co-author trailers (main, v2/m1, v2/scans on GitHub: 0 matches, 2026-10-29)
- [ ] Hosted backend can start upload jobs (service-account key in the `scrub-backend` secret, then `make deploy`)
- [ ] Devpost: video link, repo, demo URL, feedback, update note; then add the video link to README
