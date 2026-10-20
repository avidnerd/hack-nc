# Decisions

One line per decision: date, decision, reason. Code carries a matching `// DECISION:` (or `# DECISION:`) comment where relevant.

- 2026-10-19: `CLAUDE.md` stays gitignored, as in v1. Reason: v1 kept agent notes out of the repo on purpose (`.gitignore`). There was no HackNC `CLAUDE.md` in this checkout, so `docs/CLAUDE_hacknc.md` was not created.
- 2026-10-19: Optimizer timing test takes the best of two runs and honours `PERF_SLACK` (CI sets 2). Reason: single cold timings ranged 405 to 650 ms on one machine under load; the worker pays JIT warm-up at case load, so the warm number is what a user sees.
- 2026-10-19: Frame time is measured by `scripts/frametime.mjs` into `metrics/frametime.json`, hands off. Reason: "measure, never estimate"; camera input cannot run under automation.
- 2026-10-19: Backend lives in `backend/` (FastAPI, Python 3.11, `uv`-managed). Token Factory is called with the `openai` Python SDK against its OpenAI-compatible base URL. Reason: one client for Token Factory and for our own vLLM endpoint, which is also OpenAI-compatible.
- 2026-10-19: LICENSE copyright holder is "the Scrub+ authors". Reason: no legal name given; change if the team wants names.
- 2026-10-19: "Nano few-shot" baseline = our `scrub-nano` endpoint serving Nano 9B v2 without the LoRA. Reason: Token Factory does not list Nano 9B v2 (PLATFORM_NOTES section 2); the brief's fallback applies. Nemotron 3.5 Lightning on Token Factory may be added as an extra row only if verified to support tools.
- 2026-10-19: LoRA targets attention and MLP projections only (q/k/v/o_proj, up/down_proj), not the Mamba in_proj/out_proj. Reason: vLLM documents LoRA for NemotronH but not for the Mamba layers; this keeps the adapter servable without merging.
- 2026-10-19: VISTA-3D full-scan job requests hepatic tumor (26) and hepatic vessel (25) by class id in addition to "everything". Reason: both are excluded from the default 117-class set.
- 2026-10-20: The Python engine (`backend/app/engine/`) is a line-for-line port of the TS planning engine, held to it by `tests/fixtures/parity.json` (`make parity`). Reason: teacher traces, the verifier and eval must run tools without a browser and get the numbers the HUD shows.
- 2026-10-20: `optimize_plane` runs the app's full optimize flow (local, then wide fallback, from `main.ts optimizePlan`), and its `margin_min_mm` / `flr_min_pct` change the session thresholds for good. Reason: matches a spoken "optimize for a 12 mm margin".
- 2026-10-20: `optimize_plane.avoid` maps onto the existing "vessels" priority; `max_rotate_deg` / `max_offset_mm` bound the local search and turn off the wide fallback. Reason: the engine has no per-structure penalty, and adding one would change the TS engine.
- 2026-10-20: Stent `device_id` is free-form and every device uses the default simplified EVAR rules until M4 rule cards exist. Reason: there is no device catalog yet.
- 2026-10-20: `optimize_stent` with no stent placed starts from the default seat (2 mm below the lowest renal ostium), sized there. Reason: the app only optimizes a placed stent; the agent may ask first.
- 2026-10-20: `measure tumor_volume` counts full-resolution label voxels (matches `meta.truth.tumorVolumeMl`); `distance` is voxel-centre distance on the planning grid. Reason: one documented formula each, cheap to mirror in TS.
