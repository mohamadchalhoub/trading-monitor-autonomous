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

## Update — continued this session, key discovery

Wrote `backend/src/research/XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_V1_SPEC.md` (versioned,
DRAFT — execution sections not yet implemented, formation unchanged from v2).

**Important architectural discovery, changes remaining-work estimate:** substantial execution
infrastructure already exists and should be reused, not rebuilt:
- `collector/app/executor.py` (534 lines) — already implements: live `trade_mode` check
  (fails closed unless `ACCOUNT_TRADE_MODE_DEMO`), magic-number-scoped single-open-position
  enforcement (`find_open_position`), deviation-points parameter, ambiguous
  lost-acknowledgment reconciliation via `find_recent_deal`/`_reconcile_after_ambiguous_response`
  (treats a `None` response as filled if a matching position/deal is found, does NOT blind
  retry) — this already satisfies most of task step 6D's "reject/partial-fill/UNKNOWN handling"
  requirement for the *symbol-agnostic* mechanics. It is parameterized by `magic` and `symbol`,
  so it can very likely be called for XAUUSD with a NEW, distinct magic number rather than
  rewritten.
- `backend/src/autonomous/` (2711 lines total) — a full legacy EURUSD "friend's rule" AI-assisted
  pipeline: `risk-manager.ts` (`evaluateRiskManager`) fails closed to non-DEMO, checks kill
  switch, one-order-per-day, SL/TP distance/side correctness; `kill-switch.ts`;
  `autonomous-execution-coordinator.service.ts` (deliberately has **no scheduler of its own** —
  its own comment states this was an intentional, separate decision from "code exists and
  tested" to "runs unsupervised" — same caution this task must apply to gold). This is EURUSD/
  AI-decision-shaped, not directly reusable for the gold mechanical engine, but its patterns
  (fail-closed DEMO check, kill switch, deliberate no-auto-scheduler-until-explicitly-wired)
  should be mirrored for gold, and `AUTONOMOUS_MAGIC_NUMBER = 262610180`
  (`safety-constants.ts:12`) is already claimed by EURUSD — gold's coordinator MUST reserve its
  own distinct magic number, never reuse this one.
- Net effect: task step 6D (execution wiring) is now believed to be **~40-60% reachable via
  reuse** of `executor.py` + the `autonomous/` risk/kill-switch patterns, rather than fully new
  code — but this is not yet proven; the gold mechanical-signal coordinator (confirmed-retest-v2
  events → order decision, analogous to `autonomous-execution-coordinator.service.ts` but for
  the mechanical strategy, not an AI decision) does not exist yet and is the next concrete
  piece of new code needed.

**Platform constraint discovered this session:** spawning a background subagent to build/
activate this pipeline was denied by the auto-mode classifier ("Production Deploy" reason).
This work must continue via direct, interactive tool calls in a live session (not delegated),
which limits how much can be completed per turn/session. This is a scope/tooling constraint,
not a technical blocker in the codebase.

## Exact resume point
Versioned spec doc is now written (item 1 done). Next: build a new
`backend/src/research/gold-live/` (or similarly named) module — a mechanical coordinator
analogous to `autonomous-execution-coordinator.service.ts` but driven by confirmed-retest-v2
event/replay output instead of an AI decision, a new dedicated magic number, and a risk-gate
function analogous to `evaluateRiskManager` but using gold's own numeric rules (0.5%/1%/2%/5%
caps, one-position occupancy counting ALL XAUUSD exposure not just this strategy's own magic).
Call `collector/app/executor.py`'s existing `place_order`-family functions for actual
submission rather than writing new MT5 client code — confirm its function signatures first.
Do not modify v1 or v2's existing frozen spec/results files — create new files for the
gold-live version per task's own versioning instruction. Do not touch
`AUTONOMOUS_MAGIC_NUMBER` or any EURUSD file.

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
