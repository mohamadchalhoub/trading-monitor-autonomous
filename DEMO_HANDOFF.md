# DEMO_HANDOFF — gold (XAUUSD) execution

**Status: NOT ACTIVATED. Demo order submission has NOT been turned on.** Substantial progress
since the previous version of this doc — DEMO is now positively, independently confirmed — but
activation still correctly has not happened, for reasons stated plainly below.

## 1. Account identity — DEMO is now POSITIVELY CONFIRMED, with evidence

Corrected timeline:
- The original `api_mapper.py` trade_mode-label bug (see §2) meant the account's `tradeMode`
  read `"REAL"` in earlier data — that reading was never trustworthy, and was correctly never
  treated as a real confirmation.
- The bug was fixed (commit `07a154c`) and the collector was restarted (by the user) after the
  fix.
- **Independently re-queried directly against the real Postgres DB** (not the API, not a log
  claim): the freshest `account_snapshots` rows for account `753b3a50-205b-45a3-b770-885357539d54`
  (MT5 `5055783885`, broker `MetaQuotes-Demo`) — three consecutive rows at `10:57:09`,
  `10:57:20`, `10:57:30` UTC — all show `trade_mode = 'DEMO'`, `balance = equity = 50000`.
- **Cross-corroborated independently a second way**: `live_ticks` rows for both `XAUUSD`
  (bid 4281.39 / ask 4281.66) and `EURUSD` (bid/ask 1.15354) carry the identical timestamp
  `2026-09-15T10:57:30Z` — proof this was a live, actively-connected collector cycle at that
  moment, not a stale or synthetic row.
- **End-to-end mapping re-verified from source**: the installed `MetaTrader5` package's own
  `__init__.py` defines `ACCOUNT_TRADE_MODE_DEMO=0, CONTEST=1, REAL=2`; the corrected
  `api_mapper.py._TRADE_MODE_LABELS = {0: "DEMO", 1: "CONTEST", 2: "REAL"}` now matches this
  exactly (checked directly, not from memory). `executor.py`'s own live order-placement gate
  (`verify_demo_account`) was never affected by the old bug either way — it compares against
  the real `MetaTrader5` module's own constant directly.

**Conclusion: DEMO is positively confirmed as of ~10:57:30 UTC on 2026-09-15**, from real,
freshly-pushed, cross-corroborated data, using the corrected mapping, checked end-to-end.

## 2. But the collector is NOT currently running — this is the actual remaining blocker

Checked directly, twice, a few minutes apart: `Get-CimInstance Win32_Process -Filter
"Name='python.exe'"` shows **zero** processes with `main.py` on their command line right now.
Whatever process produced the 10:57:30 UTC data has since stopped (cleanly or not — unknown).
Starting a fresh collector process was attempted by this agent and **explicitly denied by this
environment's own "Interfere With Workloads" safety classifier** — the same restriction that
blocked killing a process in the previous round. This is a genuine external tooling
constraint, not something bypassed, and not something this agent can resolve without a human
starting the process.

**Correction to the previous version of this doc, per direct user correction**: the two
`python.exe main.py`-looking processes seen earlier (PID 4664 venv-python, PID 12532
system-python) were **not two independent duplicate collectors** — 12532 was a child process
of 4664 (the MetaTrader5 IPC bridge spawning a helper), a normal, expected process shape, not
a duplicate-instance problem. The "kill the duplicate" framing in the prior version of this
doc was wrong and is retracted. The duplicate-process check in
`GOLD_STARTUP_SHUTDOWN_RECOVERY.md` is updated accordingly (check for more than one *process
tree*, not more than one *process*).

## 3. Data freshness — XAUUSD M1 is NOT currently acceptable for live decisions

Checked directly with the same conversion layer `confirmed-retest-v2/data-source.ts` uses
(`wallClockToUtc('EET', ...)`, not the raw broker-mislabeled timestamp): the latest stored
XAUUSD M1 bar's raw label is `2026-09-15T12:44:00Z`; its TRUE UTC open time is
`2026-09-15T09:44:00Z`. At the time of this check (`2026-09-15T11:06:57Z` true UTC), that is
**~83 minutes stale**, and rising, since the collector is not running to sync further. This is
far outside an acceptable bound for trusting entry-window/signal decisions live — do NOT rely
on current M1 data for a live signal until the collector has run continuously long enough to
resync (the live tick pipe, separately, was healthy — only ~6-9 minutes stale at 10:57:30 —
suggesting the M1 candle-sync specifically had a backlog to work through when it stopped, not
a renewed version of the original candle-sync-lag bug from `MORNING_HANDOFF.md`, which that
fix already addressed for the tick-adjacent path).

## 4. Effective `GOLD_EXECUTION_ENABLED` value — cannot be read from a live process right now

`collector/.env` has no `GOLD_EXECUTION_ENABLED` line at all (defaults to `false` per
`config.py`). The user separately reported setting `$env:GOLD_EXECUTION_ENABLED = "false"` in
the PowerShell session used to relaunch the collector — and `main.py`'s own `load_dotenv()`
call is confirmed, by its own comment, to **never override an existing process env var**
(python-dotenv's default `override=False`), so a process-level override like that would win
over `.env` regardless of the file's contents. Since no collector process is currently
running, there is no live process to read an effective value from at all right now — this
must be re-checked from the actual startup log line (`"gold_execution_enabled": ...`,
`runner.py`'s own startup log) the next time the collector is started, not assumed from either
the `.env` file or a shell variable alone.

## 5. Scheduler — built this round (was missing before)

`backend/src/gold-execution/gold-execution-scheduler.ts` + `backend/scripts/gold-execution-scheduler.ts`
(`npm run gold-execution:scheduler`): a real, restart-safe, single-instance-locked (reuses
v1's own `ProcessLock`), periodic (default 60s, `GOLD_SCHEDULER_INTERVAL_SECONDS`) invocation
of the gold watch cycle. Never overlaps cycles, never crashes the loop on one cycle's error,
handles SIGINT/SIGTERM cleanly. 6 new tests (fake timers), all passing. It is NOT currently
running (nothing is, per §2) and has never been run continuously in production — only
unit-tested in isolation.

## 6. EUR/USD currency conversion — added this round

`evaluateGoldRiskManager` now requires `accountCurrency`/`profitCurrency`/a live
`profitCurrencyToAccountCurrencyRate` and fails closed (rejects) rather than assume 1:1 when a
conversion is actually needed (confirmed live: this account's currency is EUR, gold's real
`SymbolMetadata.profitCurrency` is USD) but no live rate is available.
`GoldAccountStateService.resolveConversionRate` derives the rate from the same live
`LiveTick('EURUSD')` row gold's own price comes from. 6 new tests, including one that proves
the real conversion and a naive 1:1 assumption produce genuinely different pass/reject
verdicts on the same input (not just different numbers).

## 7. What IS implemented (code, tested, committed locally — not pushed)

- `backend/src/gold-execution/` — constants, risk manager (now currency-aware), OFF/SHADOW/DEMO
  mode switch, coordinator, account-state resolver (occupancy/equity/trade_mode/volume
  constraints/currency, all live-queried, all fail closed), collector poll/report routes,
  dashboard endpoint, signal source bridging confirmed-retest-v2 (without modifying it), and
  the scheduler (§5).
- Collector-side: independent `GOLD_EXECUTION_ENABLED` flag, gold poll/report calls, reuse of
  `executor.py`'s existing symbol/point-size parameters (no executor.py change needed), and the
  `api_mapper.py` trade_mode fix (§1/§2 of the prior finding).
- Docs: `FRIEND_RULES_AND_IMPLEMENTATION.md`,
  `backend/src/research/XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_V1_SPEC.md`,
  `backend/src/gold-execution/GOLD_LIVE_HISTORICAL_EVALUATION.md`,
  `GOLD_STARTUP_SHUTDOWN_RECOVERY.md`, this file.

## 8. Tested, and how (evidence) — scoped, not the full 1200+ suite re-run every time

`tsc --noEmit` clean throughout. `test/gold-execution/` — 51 tests across risk-manager
(including currency conversion), e2e collector-route symbol-scoping + occupancy + volume +
currency resolution (against the real test Postgres DB), signal-mapping, dashboard, and
scheduler (fake-timer) suites — all passing. `test/autonomous/` 139 tests unaffected. v1/v2
research-boundary suites 34 tests unaffected. Collector pytest suite 194/194 (includes the
trade_mode-mapping fix and its corrected test). A full 1229-test backend run was done once
earlier this task and found 3 pre-existing, already-documented flaky failures unrelated to
gold — it was **not** re-run again for this round's smaller, scoped changes, per instruction;
scoped-suite passing is good evidence, not absolute proof against a regression somewhere
entirely untouched by this work.

## 9. Whether genuine orders have occurred

**No.** `AutonomousDecision` rows with `symbol='XAUUSD'` and `orderStatus` other than `NONE` do
not exist. Verify via `GET /research/gold-execution-status`'s `recentDecisions`/`closedTrades`
(both empty) or a direct query.

## 10. Whether demo automation is active right now

**No, on every axis**: `GOLD_EXECUTION_MODE` was left at its default `OFF` (not flipped to
DEMO by this agent — see §11 for why), `GOLD_EXECUTION_ENABLED` was not set, the scheduler was
not started, and — separately, factually — no collector process is running at all right now
regardless of any flag.

## 11. Why activation was NOT completed even though DEMO is confirmed

Positive DEMO confirmation (§1) was the PRIMARY blocker from the previous round, and it is now
cleared. But three things still make activation premature right now, and this agent
deliberately did not flip `GOLD_EXECUTION_MODE`/`GOLD_EXECUTION_ENABLED` to true in any
persisted config given all three:
1. **No collector process is running** (§2) — flipping the switches now would do nothing
   except silently arm a system that will start acting the moment someone next launches the
   collector, possibly without them re-checking the two items below first.
2. **XAUUSD M1 data is ~83 minutes stale** (§3) — entry-window and signal correctness depend
   on this data; it must be fresh (which requires the collector running continuously for a
   period to resync) before any live signal decision can be trusted.
3. **The full live operational checklist** (occupancy under real contention, protection
   placement, restart recovery, kill switch against a live process, no-duplicate-process check
   — corrected per §2) has not been re-run against an actually-running system this round,
   since none is running to test against.

## 12. Exact next steps for a human with process-management access

1. Start the collector (`GOLD_STARTUP_SHUTDOWN_RECOVERY.md` has the command) and let it run
   long enough for XAUUSD M1 to resync to a small staleness (re-check with the same
   `wallClockToUtc('EET', ...)` method used in §3 — do not trust the raw label).
2. Confirm the collector's own startup log line's `gold_execution_enabled` value directly
   (§4) — do not assume from `.env` alone.
3. Re-confirm `trade_mode == 'DEMO'` one more time from a snapshot captured after that fresh
   start (cheap, and removes any doubt from the process having restarted again).
4. Only then set `GOLD_EXECUTION_MODE=DEMO` and `GOLD_EXECUTION_ENABLED=true` and start
   `npm run gold-execution:scheduler`.
5. Historical evaluation (Outputs A/B) is already done and reported honestly as a loss under
   tested assumptions — see `GOLD_LIVE_HISTORICAL_EVALUATION.md`. This does not block
   activation by itself.
6. Still not built: an explicit "close gold strategy positions" HTTP route (task step 6E) —
   `executor.py`'s existing `close_position` can be called with `GOLD_MAGIC_NUMBER`, but no
   route/test exists yet.
