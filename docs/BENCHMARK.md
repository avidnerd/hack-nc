# Workflow benchmark

Scrub+ has two ways to do the same imaging tasks:
- **manual**: navigate with the existing gesture, mouse and keyboard controls;
- **copilot**: one spoken command, then automatic navigation.

This page reports a reproducible **technical** benchmark of the copilot path. It also
describes the instrumentation for a **human** comparison, which has not been run. Nothing
here is a measurement of human performance or of time saved in surgery.

## How it is measured

`src/copilot/bench.ts` is built into the app. `window.scrub.bench.start(task, mode)` does
the following:
1. Starts a clock.
2. Counts every interaction: key, click, scroll, spoken or LLM-parsed command, and
   hand-pose change.
3. Stops when the task's completion test passes.
4. Records time, interaction count and correctness.

**Correctness is judged against an independent recomputation, never against what the
copilot drew:**

| Task | Done when | Correct when |
|---|---|---|
| distance: minimum tumour–portal vein distance | a caliper labelled tumour ↔ portal vein is on screen | its mm is within 0.6 mm of `structureDistance` recomputed at task start |
| nearest: the tumour's closest segmented vessel | a tumour caliper is on screen | the vessel matches the `nearestAmong` winner, and the mm is within 0.6 mm |
| restore: the saved planning view | plane and camera equal the baseline snapshot | (same) |
| compare: current vs saved plane | the comparison panel and both planes are shown | (same) |

## Technical benchmark (copilot)

`npm run dev`, then `npm run bench` (`scripts/benchmark.mjs`).

For each task the script:
1. boots the app;
2. does the setup outside the clock (placing and saving a plan, then moving the cut and
   the camera away from it);
3. starts the instrumentation;
4. issues the spoken command through the real grammar and dispatcher.

Results below are from 2026-10-10: 5 runs per task, Chrome, AMD Radeon 780M laptop, liver
case at 1.0 mm. Raw data is in [BENCHMARK.json](BENCHMARK.json).

| Task | Command | Interactions | Median (max) time to answer on screen | Correct |
|---|---|---|---|---|
| distance | "show me the tumor relative to the portal vein" | 1 | 479 ms (495) | 5/5, 28.3 mm |
| nearest | "show me where the tumor is closest to a major vessel" | 1 | 381 ms (395) | 5/5, intrahepatic vessel 4.8 mm |
| restore | "show me the original plan" | 1 | 567 ms (573) | 5/5, plane and camera exact |
| compare | "compare this cut to the original plan" | 1 | 9 ms (11) | 5/5 |

What the times include:
- **distance / nearest:** the exact distance transform. The camera's 650 ms flight finishes
  after the answer is already shown.
- **restore:** the 600 ms camera transition back to the saved view.
- **All tasks:** none include speech recognition. Web Speech latency comes on top and
  depends on the browser and microphone.

## The manual path, honestly

These are capability comparisons, not timings:

| Task | What the existing manual UI offers |
|---|---|
| distance | Rotate, zoom, then place two caliper points; snapping helps land on walls. The reading is the distance between the points you chose, not the guaranteed minimum. |
| nearest | No manual equivalent short of measuring every vessel by hand and comparing. |
| restore | No manual equivalent: reproducing a saved plane and camera exactly by hand is not possible. |
| compare | Read the numbers, move the plane, read them again. The previous plane is not shown. |

## Running a human comparison

The instrumentation is ready for one. For each participant and task:
1. Open the app and call `window.scrub.bench.start('<task>', 'manual')`.
2. Have them complete the task with gestures, mouse or keys.
3. Repeat with `'copilot'` and the spoken command.
4. Read the recorded trials from `window.scrub.bench.results`.

Counterbalance the order and report time, interactions and correctness per trial. We have
**not** run this study, so we make no claim about human time saved.
