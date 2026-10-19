# Submission checklist

Stage 1 is pass/fail. Every box must be checked before Devpost submit (internal deadline Oct 29, 8:00 PM ET; hard deadline Oct 30, 10:00 AM PT).

- [ ] At least one **NVIDIA open model** used **at runtime** (Nemotron 3 Super, Nemotron Nano 9B v2 + our LoRA, VISTA-3D / NV-Segment-CT, optionally Parakeet)
  - [ ] Nemotron 3 Super called at runtime from the backend (M0)
  - [ ] Nano 9B v2 + LoRA served at runtime (M3)
  - [ ] VISTA-3D runs at runtime (M2)
- [ ] Runtime use of **Nebius Token Factory** inference API
- [ ] Runtime use of **Nebius AI Cloud** (Serverless Endpoints + Serverless Jobs)
- [ ] Hosted **demo URL** works for a judge **without a webcam and without a microphone**
- [ ] Public repo
- [x] **MIT license** file in repo (`LICENSE`, added 2026-10-19)
- [ ] MIT license visible in the GitHub About sidebar (check after push)
- [ ] README with setup instructions
- [ ] README section titled exactly **"NVIDIA models used"**
- [ ] README section titled exactly **"How Nebius Token Factory and AI Cloud are used"**
- [ ] YouTube video **under 3:00**, public, shows the project running
- [ ] Track selected: **Best Apps and Agents**
- [ ] Written note: "Scrub+ was first built Oct 10–11, 2026 (inside the submission period, which opened Aug 26). Everything in sections X–Y of this README was added Oct 18–30." with the list of v2 additions
- [ ] Platform feedback written (`docs/FEEDBACK.md`) and pasted into the Devpost form
- [ ] Third-party licenses respected and listed in README:
  - [ ] MSD (CC BY-SA 4.0)
  - [ ] TotalSegmentator (Apache 2.0 code / CC BY 4.0 data)
  - [ ] VISTA-3D (code Apache 2.0, weights NVIDIA Open Model License, research use only)
  - [ ] Nemotron (NVIDIA Open Model License)
  - [ ] Tavily ToS
- [ ] No closed-model calls left in the hosted build (Gemini proxy `api/llm.ts` removed or disabled)
- [ ] No secrets in the repo or client bundle (pre-commit check passes; `grep` of `web-dist/`)
