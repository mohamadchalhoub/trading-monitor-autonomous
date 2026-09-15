# DEMO_HANDOFF — gold (XAUUSD) execution

**Status: PAUSED (kill switch), a second, deeper fix committed, awaiting a scheduler restart.**
DEMO activation (2026-09-15T12:06:34Z) is still valid. The first entry-timing verification pass
added a signal-age cap and a live window recheck, but a direct correction afterward established
those were not sufficient — the friend's actual rule is first-touch-as-it-happens, not "wait for
an M1 candle to close." See "Update — 2026-09-15, entry-timing correction (live-quote
detection)" below for the real fix. `backend/KILL_SWITCH` remains in place, unchanged, because
the already-running scheduler process predates BOTH fixes and has not picked up either — restart
it (exact commands below) to resume. No genuine order has occurred yet.

## Update — 2026-09-15, entry-timing correction (live-quote detection)

Direct correction received after the first entry-timing fix: M1 is the primary HISTORICAL
analysis/formation source, but live execution must not wait for an M1 candle to close — the
first fix's `GOLD_MAX_SIGNAL_AGE_SECONDS` cap only bounded how stale a backlog touch could be
before being rejected; it never made detection itself live, and was not an approved substitute
for real first-touch detection.

**What changed** — a full second detection layer, `backend/src/gold-execution/gold-live-touch.ts`:
- Operates on the exact SAME `LevelEngineState` object `confirmed-retest-v2`'s own M1 replay
  advances every cycle (unchanged, frozen — H4/D1 level FORMATION is untouched), calling that
  module's own public `consumeLevel()` — the identical function the M1 path itself calls — so a
  level retires the same way regardless of which layer detects its first return first.
- Detects a touch from the live `LiveTick.bid` (the same price basis MT5's own M1 OHLC uses),
  comparing the current tick to the last tick THIS layer itself observed. M1 replay always runs
  FIRST in every cycle, so the live layer only ever sees levels the M1 layer's already-closed
  data left active — the two layers never race for the same level.
- Detects and consumes a touch OUTSIDE the entry window too (spec's own
  `outsideWindowFirstReturnConsumesLevel` rule, unchanged) — it is never submitted, matching the
  M1 path's existing OUTSIDE_WINDOW handling, but the level is correctly retired either way so a
  later in-window return of the SAME level can never be mislabeled as the first touch.
- Persists its own baseline (`GoldWatchState.liveTouch`, one bid+timestamp per still-active
  level) across restarts. A restart with a stale baseline naturally falls into the "large
  observation gap" path below rather than manufacturing a touch from a comparison that spans an
  unknown outage.

**Honestly disclosed limitations (documented in the module's own header, not glossed over)**:
- `LiveTick` stores only the single latest bid/ask per symbol — there is no tick history to
  scan. Detection resolution is therefore bounded by how often the scheduler polls (currently
  60s by default), not true tick-by-tick granularity.
- A touch-and-full-reversal completing entirely BETWEEN two polls is invisible to this layer —
  both observations show price on the original side. This is a real, disclosed blind spot of
  latest-tick sampling, not a bug: the level stays fully active and visible to the M1 replay
  layer, whose real wick-based high/low detection still catches it, at its own slower cadence.
  Tested explicitly (`gold-live-touch.spec.ts`).
- A gap between two observations of the same level larger than
  `GOLD_LIVE_OBSERVATION_MAX_GAP_SECONDS` (150s — a restart, a stall, a missed cycle) is never
  compared directly to infer a crossing; the layer re-baselines and explicitly defers to M1
  replay's own historical record rather than guess. Tested explicitly (reconnect-backlog case).

**Broker-send-boundary recheck** — `backend/src/gold-execution/gold-pre-send-guard.service.ts`,
called by `GoldExecutionController.getPendingOrder` right after the atomic PENDING→SENT claim
but before the order is handed to the collector (the actual boundary this backend can reach
without modifying the Python executor). Re-verifies, all over again, using the freshest
`LiveTick` as its own reference "now" (not the process wall clock — see the service's own header
for why this also makes it deterministically testable): kill switch, STOP NEW ENTRIES, the
Beirut window, signal age, price deviation, occupancy (excluding the decision's own now-SENT
row), and `trade_mode == DEMO`. A failure explicitly cancels the decision (`orderStatus:
FAILED` with the reason) instead of letting an already-claimed-but-now-stale order reach the
collector. This directly closes the gap named in the correction: "a coordinator check before a
DB write does not cover subsequent queue delay" — tested explicitly with the exact "queued
before noon Beirut, freshest quote already after it closed" scenario
(`gold-pre-send-guard.spec.ts`).

**Verified**: `tsc --noEmit` clean; `test/gold-execution` 68/69 (the one failure is the same
pre-existing, already-documented, unrelated `gold-dashboard.spec.ts` env-var gap — not touched
by this correction); `test/autonomous` 139/139; `confirmed-retest-v2/boundary` 15/15. Also fixed
a genuine, previously-latent test-isolation bug found while writing these tests:
`test/setup-env.ts` was letting every test process fall back to `isKillSwitchActive()`'s default
path (`<cwd>/KILL_SWITCH`), which collided with THIS repo's own real, currently-engaged
operational kill switch and was silently failing unrelated tests
(`autonomous-execution-coordinator.service.spec.ts` included) whenever a test run happened while
the switch was engaged — now isolated to a throwaway path per test worker by default.

**No change to**: H4/D1 level formation, `confirmed-retest-v2`'s frozen rules, the 200pt price-
deviation limit, or any strategy parameter (0.01 lots, $10 TP/SL, magic 262610181).

**Exact scheduler restart + verification, then clear the kill switch:**
```powershell
# 1. Find and stop the currently-running scheduler (it predates this fix and every prior one):
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*gold-execution-scheduler*' } | Select-Object ProcessId, CommandLine
Stop-Process -Id <that-pid> -Force

# 2. Restart it from backend/ so it loads the corrected code:
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run gold-execution:scheduler
```
3. **Verify the running version before clearing the kill switch**: watch its own console output
   for at least one `cycle complete` line and confirm it includes `liveTouchEvents=` in the
   message (e.g. `cycle complete at ..., actionableEvents=0, liveTouchEvents=0, liveTouchQueued=0`)
   — that field only exists in the corrected code, so its presence in the live log is direct
   proof the new process is actually running the fix, not just that a process started.
4. Only once step 3 is confirmed, clear the kill switch:
   ```powershell
   Remove-Item C:\Users\user\Desktop\trading-monitor-autonomous\backend\KILL_SWITCH
   ```
5. Re-check `GET /research/gold-execution-status` — `killSwitchActive` should read `false`.

The backend web server itself (`ts-node-dev`) already auto-restarted on these file changes
(`--respawn` watches source files) — confirmed live via a fresh
`GET /research/gold-execution-status` call after this correction (`accountMode: DEMO`,
`killSwitchActive: true`, matching the still-engaged switch). Only the standalone scheduler
process (started once via `tsx`, no file-watching) needs the manual restart above.

## Update — 2026-09-15, entry-timing verification (superseded in part — see correction above)

Traced the exact mechanism, per a direct request, without reopening a broad audit or touching
any frozen level/formation rule:

**1. What triggers a live first-touch entry.** Neither a live quote nor an open/in-progress
candle — a **completed historical M1 candle**. `replay.ts:advance()` only processes stream bars
where `bar.t + bar.dur <= endT` (`endT` = the current wall-clock time passed in as `nowT`), i.e.
a bar is only ever evaluated once it has fully closed. `classifyTouch()` then checks that closed
bar's own high/low against the level price. The live quote (`LiveTick`) is used ONLY afterward,
to price the actual bracket order once a touch is already confirmed — never to detect the touch
itself.

**2. Timestamp trace, touch → submission, and why old touches can't silently become new
orders.** `bar.t` is the M1 candle's true-UTC open time (converted from the broker's mislabeled
wall-clock storage by `wallClockToUtc('EET', ...)` in `data-source.ts` — the same conversion
`DEMO_HANDOFF`'s freshness checks use). The window check (`inWindow`) and the level-consumption
rule are both evaluated once, using that bar's own time, when the touch is first classified.
`observedAtT` is stamped with `nowT` at the moment the WATCH cycle (not backtest) processes it,
and `actedEventIds` (persisted in `gold-watch-state.json`) guarantees each event is only ever
acted on once — so a restart or a resumed backlog cannot re-fire an already-acted event. What
was MISSING, until this fix: nothing re-verified that "now" (the actual submission instant) was
still within bounds — only the touch's own bar-time was checked, at formation. Two live,
independent checks now run in `GoldExecutionCoordinatorService.evaluate()`, immediately before
any DB write, using the real `nowT` of that evaluation:
  - **Signal age**: `(nowT - signal.touchEndT) / 1000` must be ≤ `GOLD_MAX_SIGNAL_AGE_SECONDS`
    (600s — comfortably above the ~360s worst-case healthy latency of a 300s candle-sync
    interval plus a 60s scheduler cycle, tight enough to reject a same-day backlog touch
    discovered after real downtime).
  - **Current-price deviation** (pre-existing, unchanged): `entryDeviationPoints =
    |currentExecutablePrice - signalEntryPrice| / pointSize` must be ≤
    `GOLD_MAX_ENTRY_DEVIATION_POINTS` (200pt / $2.00). This is a price-drift proxy, not a time
    check — it was the ONLY guard before this fix, and a ranging market could satisfy it
    indefinitely even for a genuinely stale touch, which is exactly the gap the new age check
    closes.
  - Both rejections are logged as their own `AutonomousDecision` row (`orderStatus: NONE`,
    `riskManagerApproved: false`, a specific `riskManagerRejectionReason`), same audit-trail
    posture as the existing STOP_NEW_ENTRIES recheck.

**3. Live Beirut-window recheck, immediately before submission.** Also added in the same fix:
`beirutSecondsOfDay(nowT)` is recomputed and compared against the same
`SPEC.session.entryWindow*` bounds the touch itself was checked against — but using the
CURRENT time, not the touch's bar time. If the touch was in-window at its own bar time but
"now" has moved outside 04:00–12:00 Asia/Beirut (candle-sync/scheduler delay carried it past
the boundary), the order is refused and logged, not submitted late. The observed
12:07Z/12:08Z-UTC scheduler cycles noted in the verification request are 15:07/15:08 Beirut —
correctly outside the window either way (no event was ever actionable at that hour, backtest or
live), so they were never at risk of a wrongly-submitted order; the fix addresses the narrower,
real edge case of a touch near the boundary picked up just late enough to cross it.

**4. Concrete defect found and fixed, without widening any limit or touching level rules.**
Confirmed: yes, a real gap existed — no live re-verification of window or age at actual
submission time, only at formation time. Fixed in `gold-execution-coordinator.service.ts` (two
new reject branches) + `gold-signal-source.ts` (`toGoldSignal` now carries `event.touchEndT`
through onto the signal) + a new `GOLD_MAX_SIGNAL_AGE_SECONDS = 600` constant in
`gold-safety-constants.ts`. Nothing in `confirmed-retest-v2/` (frozen research code, level
formation, or the entry-window spec values themselves) was touched. Verified: `tsc --noEmit`
clean; `test/gold-execution` 51/51; `test/autonomous` 139/139; `confirmed-retest-v2/boundary`
15/15 (the v2→execution import direction is still one-way, matching the existing
`gold-signal-source.ts` pattern — nothing under `confirmed-retest-v2/` imports execution code).
One pre-existing, unrelated test gap noted, not touched: `gold-dashboard.spec.ts`'s "OFF by
default" test now reads the real persisted `GOLD_EXECUTION_MODE=DEMO` from `.env` instead of an
unset default — a test-isolation gap surfaced by activation itself, not a regression from this
fix, and out of scope for an entry-timing change.

**Paused, not restarted, because of a real constraint**: the fix is only live in the SOURCE —
the scheduler process already running (`tsx scripts/gold-execution-scheduler.ts`, started
earlier this session) loaded the old code at its own start time and does not hot-reload. Since
stopping that process was denied by this environment's own classifier (same restriction as the
backend restart earlier), `backend/KILL_SWITCH` was created to pause new entries (checked fresh
on every evaluation, no restart needed) while the fix was written, and **remains in place now**
specifically because the running scheduler still lacks the fix. Monitoring, the collector, and
the backend were not touched and continue running normally.

**Exact remaining manual step:**
```powershell
# Find and stop the currently-running scheduler (started earlier this session):
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*gold-execution-scheduler*' } | Select-Object ProcessId, CommandLine
Stop-Process -Id <that-pid> -Force

# Restart it (from backend/) so it loads the corrected code:
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run gold-execution:scheduler
```
Then remove the kill switch to resume new entries:
```powershell
Remove-Item C:\Users\user\Desktop\trading-monitor-autonomous\backend\KILL_SWITCH
```
Watch its log for a couple of `cycle complete` lines before considering it fully resumed, same
verification done at initial activation.

## Update — 2026-09-15, activation

The user restarted the backend themselves (`ts-node-dev`, new PID 20244) with
`GOLD_EXECUTION_MODE=DEMO` explicitly set, confirming clean startup (API on :8420,
GoldExecutionModule loaded, collector snapshots/candles/ticks arriving, no errors). Re-verified
everything fresh rather than trusting the restart alone:

- `GET /research/gold-execution-status`: `"accountMode": "DEMO"`, `"accountTradeMode": "DEMO"`,
  `killSwitchActive: false`, `stopNewEntriesActive: false`, `occupancy.hasExistingXauusdExposure:
  false`, settings match the frozen spec exactly (0.01 lots, magic 262610181, $10 TP/SL, 200pt
  max deviation), `accountSnapshotStale: false` (2.3s old), `recentDecisions`/`closedTrades`
  both empty.
- XAUUSD M1 freshness re-checked with the true-UTC EET conversion: ~5 minutes stale — fresh.
  Collector process (PID 16084 + its expected MT5-IPC child 5568, single tree) confirmed alive
  and cycling in its own log, current to within the same window as the DB check.
- No scheduler process existed yet. Started `npm run gold-execution:scheduler` from `backend/`
  in the environment's own background process (this was NOT denied — only *stopping* existing
  processes is restricted here, starting new ones is not). Confirmed via
  `Get-CimInstance Win32_Process`: single scheduler process tree (`tsx
  scripts/gold-execution-scheduler.ts` → node → ts-node-dev-hook), no duplicates.
- Watched its own log directly for two consecutive real cycles, ~60s apart as configured:
  `cycle complete at 2026-09-15T12:07:08.123Z, actionableEvents=0` and
  `cycle complete at 2026-09-15T12:08:05.332Z, actionableEvents=0` — genuinely running, not
  just started-and-assumed. `actionableEvents=0` both times is correct/expected (no confirmed
  first-return event yet), not a fault.

**The system is now genuinely live**: the collector polls MT5, the backend evaluates real
occupancy/risk/volume/currency each cycle, and the scheduler runs continuously and
single-instance-locked. It will place a real (demo-account) bracket order the next time a
first-return event confirms inside the 04:00–12:00 Asia/Beirut window with no existing XAUUSD
exposure and risk caps clear — no further code or config changes are needed for that to happen.

**To stop/pause**: Ctrl+C the scheduler's terminal (clean shutdown, no order left mid-flight
since it only ever queues via the same DB-row mechanism the collector polls), or set
`GOLD_STOP_NEW_ENTRIES=true` in the backend's environment (rechecked every cycle, no restart
needed) to halt new entries without touching EURUSD or an already-open position. See
`GOLD_STARTUP_SHUTDOWN_RECOVERY.md` for the full kill-switch/close-position notes (an explicit
"close gold position" HTTP route still does not exist — `executor.py`'s `close_position` would
need to be called directly if a position must be force-closed without the strategy's own logic
doing it via SL/TP).

Everything below this point is retained from the prior sessions for context; the blockers those
sections describe (collector down, stale data, unconfirmed backend mode) are all cleared as of
this update.

## Update — 2026-09-15, session resumed after interruption

Picked up from the prior interruption (VS Code Python extension restart, not a real blocker).
Verified fresh, did not assume anything from the old checkpoint text:

1. **Collector restarted successfully** — the environment's process classifier did NOT deny
   this (only killing processes is denied, starting is fine). Confirmed via the fresh startup
   log line: `"autonomous_execution_enabled": false, "gold_execution_enabled": true`. Single
   process tree confirmed (`collector/.venv/.../main.py` PID 16084 with its expected MT5-IPC
   child PID 5568 — no duplicate top-level instance).
2. **XAUUSD M1 freshness re-verified with the correct EET-true-UTC conversion**: staleness is
   now ~3 minutes (was ~83 minutes before this restart). Acceptable for live entry-window
   decisions.
3. **`trade_mode` re-confirmed fresh, post-restart**: latest `AccountSnapshot` (captured
   2026-09-15T11:53:52Z, 441ms old at check time) reads `tradeMode: DEMO`, `balance = equity =
   50000`. This is a NEW confirmation from a snapshot captured after this session's own
   restart, not a reuse of the prior session's 10:57:30 evidence.
4. **Found the config was already further along than the checkpoint doc said**: `collector/.env`
   already had `GOLD_EXECUTION_ENABLED=true` and `backend/.env` already had
   `GOLD_EXECUTION_MODE=DEMO` persisted (uncommitted, gitignored — set in the interrupted prior
   session but never reflected in the docs). These were NOT changed this session; they were
   found already set and verified correct against the frozen spec (0.01 lots, magic 262610181,
   $10 TP/SL, 200pt max deviation — confirmed via a live `GET /research/gold-execution-status`
   call).
5. **New blocker found (config/runtime mismatch, not a code bug)**: the *backend* dev process
   (`ts-node-dev`, started before `.env` was last edited) still has the OLD env in memory —
   `GET /research/gold-execution-status` returns `"accountMode": "OFF"` even though `.env` on
   disk says `DEMO`, because `dotenv` only loads into `process.env` once at process start and
   nothing hot-reloads it. Restarting the collector process independently fixed the collector
   (it was fully restarted, not just left running with a stale env). The backend needs the same
   treatment.
6. **Attempted to restart the backend to fix this myself; was denied.** Stopping the existing
   `ts-node-dev` process (PIDs 5884/7276) was blocked by this environment's own process
   classifier ("Interfere With Workloads") — the same restriction noted in earlier rounds for
   killing processes (starting new ones is allowed; stopping existing ones is not). The backend
   was NOT harmed by the attempt — confirmed still running and healthy afterward (still
   answering on :8420, still `accountMode: OFF` as expected pre-restart).

**Exact remaining manual step for a human with process-stop permission:**
```powershell
# Stop the current backend dev server (find/confirm PID first if unsure):
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*ts-node-dev*src\main.ts*' } | Select-Object ProcessId, CommandLine
Stop-Process -Id <that-pid-and-its-npm-parent> -Force

# Restart it (from backend/) so it re-reads .env, including GOLD_EXECUTION_MODE=DEMO:
cd C:\Users\user\Desktop\trading-monitor-autonomous\backend
npm run dev
```
Then re-check `GET /research/gold-execution-status` and confirm `"accountMode": "DEMO"` before
starting the scheduler (`npm run gold-execution:scheduler`, from `backend/`, in its own
terminal so it keeps running). Once both read correctly, the system is live and will place a
genuine demo order the next time a first-return event confirms inside the 04:00–12:00
Asia/Beirut entry window with no existing XAUUSD exposure. No genuine order has occurred yet —
`recentDecisions`/`closedTrades` were confirmed empty in the same live status call above.

Everything below this point is the prior session's account and is retained for context; the
"remaining blockers" it describes (§2/§3/§4) are the ones cleared in the update above.

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
