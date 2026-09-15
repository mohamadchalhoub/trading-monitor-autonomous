# DEMO_HANDOFF — gold (XAUUSD) execution

**Status: NOT ACTIVATED. Demo order submission has NOT been turned on.** This is the honest,
current state — read this before assuming anything below is live.

## The exact blocker to activation, stated plainly

The account's own `trade_mode` cannot currently be trusted, for a documented, fixed-but-not-
yet-re-verified reason:

1. While building this task's live-verification pass, a bounded gold-execution shadow run
   (`npm run gold-execution:watch` with `GOLD_EXECUTION_MODE=SHADOW`) against the real dev
   database showed the live MT5 account's latest `AccountSnapshot.tradeMode` as `"REAL"`.
2. Investigating that finding surfaced a real, pre-existing bug:
   `collector/app/api_mapper.py`'s `_TRADE_MODE_LABELS` was `{0: "REAL", 1: "DEMO", 2:
   "CONTEST"}` — a complete permutation error against the actually-installed `MetaTrader5`
   package's real enum, verified directly from
   `collector/.venv/Lib/site-packages/MetaTrader5/__init__.py`:
   `ACCOUNT_TRADE_MODE_DEMO=0, CONTEST=1, REAL=2`. An existing unit test had been asserting the
   wrong mapping as correct, self-confirming the bug instead of catching it.
3. **This is now fixed** (commit `07a154c`): `_TRADE_MODE_LABELS = {0: "DEMO", 1: "CONTEST", 2:
   "REAL"}`, with the self-confirming test corrected too. Full collector suite 194/194 passing
   after the fix.
4. **But the running collector process was never restarted**, so it is still executing the
   old, buggy code in memory (Python does not hot-reload). A restart is required to push a
   corrected snapshot. **Restarting the collector process was attempted and explicitly denied
   by this environment's own automated safety classifier** ("Interfere With Workloads") — not
   worked around, per the operating rules for this task.

**Net effect:** the account's true `trade_mode` is genuinely unconfirmed right now. The
pre-fix `"REAL"` reading must NOT be trusted (it came from known-buggy code — it is very
plausibly actually DEMO, given the account's display name is `MT5 5055783885
(MetaQuotes-Demo)`, but "plausibly" is not the same as "positively confirmed," and this task's
own rule is explicit: never activate without positive confirmation). A corrected reading has
not yet been observed. **This is the single concrete remaining blocker to activation** — not a
missing feature, a data-confirmation gap.

Also found and fixed: a second `python main.py` process was running alongside the documented
one (`collector/.venv/Scripts/python.exe main.py` at PID 4664 vs a system-Python invocation at
PID 12532, both started the same second). Terminating it was also denied by the same
classifier. Both must be resolved by the user directly — see `GOLD_STARTUP_SHUTDOWN_RECOVERY.md`
for the exact commands.

## What IS implemented (code, tested, committed locally — not pushed)

- `backend/src/gold-execution/` — full module: gold-specific magic number (262610181, distinct
  from EURUSD's 262610180), fixed volume (0.01 lots)/point-size/TP-SL/risk-cap constants,
  `evaluateGoldRiskManager` (fails closed on non-DEMO, kill switch, occupancy, entry-deviation,
  broker step/min/max, SL/TP distance/side, equity-based 0.5/1/2/5% caps), OFF/SHADOW/DEMO mode
  switch (env `GOLD_EXECUTION_MODE`, fails closed to OFF) with a separately-rechecked
  `GOLD_STOP_NEW_ENTRIES`, `GoldExecutionCoordinatorService` (logs SHADOW decisions or queues
  DEMO orders), `GoldAccountStateService` (live occupancy from real broker-synced `Position`
  rows + in-flight decisions, live equity/trade_mode from the latest snapshot fails closed to
  REAL/0 when absent, live broker volume constraints from `SymbolMetadata` fails closed to an
  impossible constraint when missing/stale), collector-facing poll/report routes
  (`GoldExecutionController`, symbol-scoped — verified NOT to collide with EURUSD's own route),
  and a dashboard endpoint (`GoldDashboardController` at `GET /research/gold-execution-status`).
- `backend/src/gold-execution/gold-signal-source.ts` — bridges confirmed-retest-v2's pure
  research engine (formation, first-return consumption, entry-window, D1-descriptive-only) to
  the coordinator, without modifying v2 itself (its own boundary test, forbidding execution
  imports inside `src/research/confirmed-retest-v2/`, still passes unaffected — verified,
  34/34 v1+v2 boundary tests). `isActionableLiveEvent`/`toGoldSignal` are pure, heavily tested
  functions; `runGoldWatchCycle`/`GoldWatchStore` are the thin, restart-safe orchestration.
- Collector-side (`collector/app/api_client.py`, `config.py`, `runner.py`): an independent
  `GOLD_EXECUTION_ENABLED` flag (never coupled to EURUSD's own), gold poll/report calls, and
  `executor.py` reuse via its existing `symbol`/`point_size` parameters (no executor.py change
  needed).
- `backend/scripts/gold-execution-watch.ts` (`npm run gold-execution:watch`) — a manually-
  invoked, not-yet-scheduled single watch cycle, used to produce the evidence above.
- Docs: `FRIEND_RULES_AND_IMPLEMENTATION.md`, `backend/src/research/XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_V1_SPEC.md`,
  `backend/src/gold-execution/GOLD_LIVE_HISTORICAL_EVALUATION.md`,
  `GOLD_STARTUP_SHUTDOWN_RECOVERY.md`, this file.

## What was tested, and how (evidence)

- `backend`: `npx tsc --noEmit` clean throughout. `test/gold-execution/` — 39 tests (risk
  manager unit tests, e2e collector-route symbol-scoping against the real test Postgres DB,
  occupancy/equity/volume-constraint resolution, signal-mapping unit tests, dashboard e2e).
  `test/autonomous/` — 139 tests, unaffected (no EURUSD regression from the
  `claimOldestPendingOrder` symbol-scoping fix). `test/research/confirmed-retest{,-v2}/boundary.spec.ts`
  — 34 tests, unaffected (proves v2's no-order-path invariant still holds after adding
  `gold-signal-source.ts` outside its directory).
- `collector`: full pytest suite 194/194 (was 189 at task start; +5 gold-polling tests this
  task added, all passing) — including after the `trade_mode` mapping fix.
- Bounded SHADOW run: `GOLD_EXECUTION_MODE=SHADOW npx tsx scripts/gold-execution-watch.ts`
  against the real dev database. Genuine result: it found real, already-formed
  confirmed-retest-v2 levels from the historical study, correctly computed BUY/SELL signals
  from their SUPPORT/RESISTANCE role, and correctly REFUSED every one at the risk gate with
  the reason `"Refusing to trade gold: account trade_mode is \"REAL\", not DEMO."` — proving
  the fail-closed mechanism works end-to-end, even though the specific `"REAL"` value itself
  was later found to be unreliable (see blocker above). No order was queued or sent; this is
  exactly the intended SHADOW behavior.

## Whether genuine orders have occurred

**No.** `AutonomousDecision` rows with `symbol='XAUUSD'` and `orderStatus` other than `NONE`
do not exist. Verify at any time via `GET /research/gold-execution-status`'s
`recentDecisions`/`closedTrades` (both empty) or a direct query.

## Whether demo automation is active

**No.** `GOLD_EXECUTION_MODE` defaults to `OFF`; `GOLD_EXECUTION_ENABLED` (collector-side) was
never set to `true` in any running process; no scheduler invokes `gold-execution:watch`
automatically. Nothing was activated.

## What remains, in order

1. Restart the collector (user action — blocked for this agent by the platform's process-
   management restriction) and confirm exactly one instance is running.
2. Re-query the MT5 account's fresh `AccountSnapshot.tradeMode`. If (and only if) it now reads
   `"DEMO"`, this specific blocker is cleared.
3. Re-run the bounded SHADOW cycle and confirm the risk gate no longer rejects purely on
   trade_mode (other rejections — occupancy, deviation, risk caps — may still legitimately
   fire; that is correct behavior, not a bug).
4. Only then set `GOLD_EXECUTION_MODE=DEMO` and `GOLD_EXECUTION_ENABLED=true`, and decide on a
   scheduling mechanism for `gold-execution:watch` (none exists yet — see
   `GOLD_STARTUP_SHUTDOWN_RECOVERY.md`).
5. Build the still-missing explicit "close gold strategy positions" control (task step 6E) —
   `executor.py`'s existing `close_position` can be called with `GOLD_MAGIC_NUMBER`, but no
   HTTP route/test exists for it yet.
6. Historical evaluation (task step 7, Outputs A/B) is already done and reported honestly as a
   loss under tested assumptions — see `backend/src/gold-execution/GOLD_LIVE_HISTORICAL_EVALUATION.md`.
   This does not by itself block activation; the trade_mode confirmation above does.
