# Implementation Checkpoint — friend's-gold strategy finish task

Written because this task's true scope (research spec extension + full live demo execution
pipeline + verified DEMO activation on a real MT5 connection) cannot be safely completed in
one bounded pass without either rushing the live-order-placement parts (explicitly forbidden:
"never claim verified unless you actually ran it", "if you cannot confirm DEMO, leave OFF") or
skipping real verification. This is an interruption, not completion. Nothing was pushed, no
order path exists, no broker order was placed.

## Done in this pass
- Read `MORNING_HANDOFF.md`, v2 spec, confirmed `confirmed-retest-dashboard` controller has
  **no order path** (grep-confirmed, matches v2 spec's own provenance note).
- Wrote `FRIEND_RULES_AND_IMPLEMENTATION.md` (rule table: friend rule / existing impl /
  delegated choice / code location) at repo root.

## Confirmed current state (facts, not assumptions)
- `confirmed-retest-v2` is research/watch-only only — no execution, no scheduler, no MT5 order
  calls anywhere in `backend/src/research/confirmed-retest-v2/` or
  `confirmed-retest-dashboard/`.
- `AUTONOMOUS_EXECUTION_ENABLED=false` per last handoff; no strategy currently places orders.
- v1 and v2 specs/results are untouched and must stay that way (do not overwrite).
- EURUSD legacy strategy and `h4-trend-h1-breakout-v1` are out of scope for activation; not
  yet re-audited this pass for "still working" collection/volume/occupancy claim in item 4 of
  the task — needs a fresh check before final handoff.

## Not started / remaining work (in order)
1. **Versioned gold spec doc** — write `XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_V1_SPEC.md`
   (or v2.1) documenting: reuse of v2's pivot+retest engine unchanged, gold-specific
   confirmation of D1-descriptive-only, and any fidelity gaps (winter EET offset) — required
   *before* running any new evaluation per task step 3.
2. **Historical evaluation, 3 outputs** (task step 7) — eligible first-return events,
   one-position simulation under real risk caps, and an (initially empty) forward demo trades
   table. v2's `pipeline.ts`/`paper.ts`/`report.ts` can likely be reused directly since v2
   already implements the friend's rule set almost verbatim — needs confirming there is no
   rule mismatch (e.g. D1 usage, ambiguous-outcome handling) before trusting old v2 output
   as-is versus re-running.
3. **Occupancy + risk live gate module** (new code) — persistent one-active-trade-per-symbol
   reservation across manual/strategy/pending/UNKNOWN broker state; equity-based risk caps
   pre-trade check; never auto-resize volume.
4. **Execution wiring** (new code) — scheduler, MT5 executor with dedicated magic number,
   broker-native SL/TP, max-entry-deviation guard, reject/partial-fill/UNKNOWN handling
   without blind retry, deal-history reconciliation across polls.
5. **Controls** — OFF/SHADOW/DEMO modes, STOP NEW ENTRIES rechecked pre-send, explicit
   strategy-position close control, persistent risk-block/incident log.
6. **Dashboard extensions** — active strategy/version+mode, volumes, selected levels+why,
   first-return/skip reasons, open/closed positions with real P&L, "EURUSD strategy inactive"
   banner, data-freshness/health/protection status.
7. **Verification before any activation** (task step 8): live query confirming
   `trade_mode == DEMO` on the actual connected account (record the literal returned value),
   symbol/volume validation, one-position enforcement test, protection-placement test,
   restart-recovery test, kill-switch test, no duplicate collector/scheduler processes,
   focused unit/integration tests, bounded shadow run.
8. **Activation** — only after every item in 7 passes with pasted evidence. If blocked,
   report exact blocker instead.
9. **Remaining handoff docs** — startup/shutdown/recovery doc, `DEMO_HANDOFF.md`.

## Exact resume point
Start at item 1 above. `confirmed-retest-v2/` is the correct reuse base (confirmed already);
do not restart from v1 or from scratch. Do not modify v1 or v2's existing frozen spec/results
files — create new files for the gold-live version per task's own versioning instruction.

## Explicit current answer to the required final-report questions (as of this checkpoint)
- Implemented so far: rule-table doc only; no code changes.
- Tested: nothing new (no code changed).
- Verified against live demo connection: nothing yet — DEMO activation has NOT happened and
  must not be claimed as happened.
- Demo automation active: **No.**
- Genuine strategy orders occurred: **No, none.**
- Start/stop/recover: unchanged from `MORNING_HANDOFF.md`'s existing commands (collector,
  backend, frontend, watch-only watcher) — no new process introduced yet.
- Concrete blocker: task scope (full execution pipeline + verified demo activation) requires
  substantially more implementation and live-verification work than fits in one bounded pass;
  continuing requires picking up at "Exact resume point" above.
