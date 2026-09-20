# XAUUSD M1 RSI — operations and recovery

Operating guide for `xauusd-m1-rsi-retest-extremes-v1`, the application's
single enabled entry strategy.

The rules themselves are in
[`backend/src/xauusd-rsi/XAUUSD_M1_RSI_RETEST_EXTREMES_V1_SPEC.md`](backend/src/xauusd-rsi/XAUUSD_M1_RSI_RETEST_EXTREMES_V1_SPEC.md),
which is frozen. This document is about running it.

---

## 0. The one thing to understand first

**This application runs only while you have started it by hand.** There is no
Windows service, no scheduled task, no autostart and no supervisor, by
explicit design.

The consequence is not cosmetic:

> **While the stack is stopped, nothing observes RSI, nothing enters, and the
> Friday pre-weekend liquidation does not run.**

If a position is open going into a Friday, the stack must be running **and**
connected to the broker before **23:00 Beirut** for the 23:30 deadline to be
met. If the laptop is asleep, the collector is down, or MT5 is disconnected,
local software cannot close anything, and no amount of code in this repository
changes that. Close the position by hand instead.

---

## 1. Starting, checking, stopping

```powershell
# start backend + collector + strategy watch (NOT the frontend)
powershell -ExecutionPolicy Bypass -File backend\scripts\start-xauusd-rsi.ps1

# read-only status: processes, ports, controls, watch state, retired processes
powershell -ExecutionPolicy Bypass -File backend\scripts\status-xauusd-rsi.ps1

# graceful stop, kill switch engaged first, positions reported not closed
powershell -ExecutionPolicy Bypass -File backend\scripts\stop-xauusd-rsi.ps1
```

The frontend is separate and manual: `npm run dev` in `frontend/`.

The start script refuses to run if anything conflicts — an untracked backend on
the port, a second watch process, or a retired strategy's scheduler still
running. It builds to `dist/` and runs the **compiled** output, never a
file-watching dev server.

### What to check after starting

1. `status-xauusd-rsi.ps1` shows all three components RUNNING.
2. The first ~20 lines of `.xauusd-rsi-runtime/logs/rsi-scheduler.log` show the
   mode, volume, brackets and state directory it actually resolved.
3. The dashboard at `/xauusd-rsi` shows **Warm-up: complete** and a fresh
   quote. Until warm-up completes, signals are observed and consumed but never
   emitted.

---

## 2. Configuration

| Where | Setting | Meaning |
|---|---|---|
| `backend/.env` | `XAUUSD_RSI_EXECUTION_MODE` | `OFF` (default), `SHADOW`, `DEMO`. Fails closed to OFF. |
| `backend/.env` | `AUTONOMOUS_TRADING_ACCOUNT_ID` | The one DEMO account to trade. |
| `backend/.env` | `XAUUSD_RSI_SCHEDULER_INTERVAL_SECONDS` | Watch cycle, default 5. |
| `collector/.env` | `XAUUSD_RSI_EXECUTION_ENABLED` | Must be `true` for the collector to stream ticks and poll for orders. Requires a collector restart. |

Both must be set. With the backend in `DEMO` but the collector flag `false`,
decisions are queued and never sent. With the collector flag `true` but the
backend `OFF`, nothing is ever queued to send.

### Controls that take effect immediately, without a restart

| File (under `backend/`) | Effect |
|---|---|
| `XAUUSD_RSI_KILL_SWITCH` | No new order is queued or sent. |
| `GOLD_KILL_SWITCH` | Same — the pre-existing gold switch is **honoured** by this strategy too. |
| `XAUUSD_RSI_STOP_NEW_ENTRIES` | No new entries. |
| `GOLD_STOP_NEW_ENTRIES` | Same, honoured. |

Creating any of these files stops new entries on the very next check. **None of
them disable protective closures, reconciliation, or the Friday liquidation of
owned positions** — that is deliberate, and it is why stopping entries is safe
to do at any time.

> A note on the current state of this repository: `backend/GOLD_KILL_SWITCH`
> **exists** and was engaged on 2026-09-16 by `stop-gold-demo.ps1`. Because
> this strategy honours it, **no entry will be submitted until it is removed.**

---

## 3. The daily pause is NOT the Friday liquidation

These two are easy to confuse and behave completely differently.

|  | Daily entry pause | Friday liquidation |
|---|---|---|
| When | 23:30 → 01:00 Beirut, **every day** | Friday, from 23:00 Beirut |
| Affects | **New entries only** | **Open positions and pending orders** |
| Open position | **Stays open.** Neither boundary closes it. | **Must be closed** before 23:30 Beirut |
| Protection/reconciliation | Continues | Continues |
| After it ends | Entries resume at 01:00 | Entries stay disabled until the broker session is confirmed open again |

An ordinary weekday position opened at 22:00 may run through the pause, past
01:00, and for days afterwards. Only Friday forces a close.

---

## 4. Friday, in order

| Beirut time | What happens |
|---|---|
| before 23:00 | Entries allowed, subject to every other gate. |
| **23:00:00** | Entry cutoff. Strictly before 23:00 is allowed; at and after, nothing new is submitted. Queued-but-unsent decisions are cancelled at the pre-send check. Liquidation **starts now**, not at 23:29. |
| 23:00 → 23:30 | Close requests are submitted for owned positions and retried, bounded, until the broker confirms. |
| **23:30:00** | Deadline. Owned exposure must be gone. |
| after 23:30 | If anything remains, it becomes a durable `FAILED` liquidation row and a critical incident naming the remaining exposure. |

**Success requires broker evidence.** A submitted close request is never
treated as a closure. An item is only `CONFIRMED_CLEARED` once it has
disappeared from real broker-derived position data.

### Scope — what gets closed and what does not

- **Closed:** positions carrying this strategy's magic number (`262610190`),
  and positions carrying the retired H4 gold strategy's (`262610181`), because
  this application still owns and manages those.
- **Never closed:** anything else. A manual trade or another system's position
  is displayed separately, counted for the one-position occupancy rule, and
  left completely alone.

This is why the dashboard says *"owned exposure flat"* and never *"the account
is flat"*.

---

## 5. Recovery scenarios

### Starting up after the Friday cutoff, or during the weekend

Just start the stack normally. The watch process reconciles before it does
anything else:

1. Any `PENDING` decision it left behind is **retired** with an audit reason —
   it was never sent, and an intrabar signal is not valid to submit later.
2. Any `SENT` or `UNKNOWN` decision is matched against real broker positions.
   A match becomes `FILLED`. **No match does not become `FAILED`** — it stays
   `UNKNOWN`, because the order may have filled and already closed. Entries
   stay blocked until an operator resolves it.
3. If owned exposure remains and the deadline has passed, liquidation resumes
   immediately and the miss is reported.

Nothing depends on a scheduled callback having fired while the machine was off.

### An `UNKNOWN` decision is blocking entries

This is deliberate: the application will not guess. Resolve it against the
broker's own deal history in MT5:

- **It did fill** → the position will appear in the next collector snapshot and
  reconciliation will mark it `FILLED` on the next start.
- **It never filled** → mark that decision resolved in the database, after
  confirming in the terminal. Do not guess from the absence of a position.

### The Friday deadline was missed

1. `status-xauusd-rsi.ps1` and the dashboard both show
   `FRIDAY_CLOSURE_DEADLINE_MISSED` with the remaining tickets named.
2. A critical Telegram incident was raised on the gold channel.
3. **Close the remaining position manually in MT5**, if the market is still
   open. If it is closed, the exposure carries over the weekend — that is the
   real outcome, and the application reports it rather than papering over it.
4. Entries stay disabled until the broker session is confirmed open again.

The application never reports success it cannot prove, and never assumes a
position disappeared.

### The watch process will not start: "another watch process holds the lock"

Two watch processes would both claim decisions and could both submit, so
starting a second is refused.

1. Run `status-xauusd-rsi.ps1` and confirm no watch process is actually
   running.
2. Only then delete `backend/xauusd-rsi-runtime/xauusd-rsi-watch.lock`.
3. The lock also goes stale on its own after 15 minutes.

### The watch process will not start: spec hash mismatch

The persisted state was written under different rules. This is refused rather
than migrated, because reinterpreting old state under new thresholds produces
decisions no audit can explain.

Archive `backend/xauusd-rsi-runtime/` and start fresh. Warm-up runs again.

### A data gap or a restart

Pattern state is discarded across any gap longer than 90 seconds — a peak whose
pullback happened unobserved is not a peak this strategy may trade. The
**indicator is not** discarded: RSI carries across session breaks exactly as
MetaTrader's does, so Monday morning agrees with the terminal.

---

## 6. Ownership and history

Nothing in this migration deleted trading history. `trades`,
`autonomous_decisions`, `trend_breakout_decisions` and every migration are
intact. The retired strategies' code remains readable; only their ability to
generate or submit an entry was removed.

| Magic | Owner | Protective distance | Can it enter? |
|---|---|---|---|
| `262610190` | **Active** RSI strategy | $5 / $5 | Yes |
| `262610181` | Retired H4 confirmed-retest gold | **$10 / $10, unchanged** | No |
| `262610180` | Retired legacy EURUSD autonomous | n/a | No |
| anything else | Foreign / manual | Never modified | No |

An old position is never adopted, never relabelled, and never re-protected at
the new strategy's $5.

To inspect all of this at any time, read-only:

```bash
cd backend && npm run xauusd-rsi:migrate
```

---

## 7. Evaluating the strategy

```bash
cd backend && npm run xauusd-rsi:evaluate
```

Read the output's own caveats carefully. The long-horizon numbers come from a
**closed-bar approximation**, which is a different strategy from the one that
trades — the two models differ by roughly 50× in signal frequency. The faithful
tick replay is limited to whatever ordered tick history exists. Running the
collector with the tick stream enabled accumulates that history going forward.
