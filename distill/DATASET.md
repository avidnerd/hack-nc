# Dataset card: Scrub+ surgeon commands and verified Nemotron traces

- **Source:** `distill/gen_commands.py` (seed fixed), templates in `distill/templates.py`, paraphrases by Nemotron 3 Super cached in `distill/data/paraphrases.json`.
- **Size:** 6,000 commands over 2 cases (liver 5,792, aorta 208), covering all 13 tools, single and multi-step, with slot values (margins, offsets, structures), slang, and requests that should get a clarifying question.
- **Labels:** each command carries a machine-checkable goal predicate on the final engine state, and optional setup steps.
- **Split:** train 5,166, val 578, test 256. A split by case needs at least three cases of a kind; with one liver and one aorta case, the test set is held out by phrasing instead: the last phrasing of each template is test only. Test phrasings never appear in training, but the test CTs do. VISTA-3D gallery cases were not added to the command set.
- **Teacher traces:** `nvidia/nemotron-3-super-120b-a12b` on Token Factory solved the 5,744 train and val commands with the Python engine executing tool calls (`distill/teach.py`).
- **Verification:** kept when every call is schema-valid, the goal predicate holds, and the final text passes `ground_check` (`distill/verify.py`). Kept 4,133 of 5,744 (72.0 %); dropped 1,242 goal, 183 grounding, 176 errors, 10 schema.
- **SFT files:** `sft_train.jsonl` 3,718 traces (8,850 assistant turns), `sft_val.jsonl` 415 traces (986 turns). Median 1,880 tokens per example, max 2,904, none truncated.
- **Device rules:** traces use the default EVAR rules only (`SCRUB_DEVICE_RULES=0`), so the model was not trained on IFU rule cards.
- **Known limits:** two CTs, so the model may learn case-specific numbers; phrasing-based held-out test; English only.
