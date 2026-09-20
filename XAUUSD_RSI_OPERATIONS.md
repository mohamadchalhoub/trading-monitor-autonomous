# XAUUSD M1 RSI — operations and recovery

Operating guide for `xauusd-m1-rsi-retest-extremes-v1`, the application's
single enabled entry strategy.

**Revision 2 (current).** Extreme SELL is 98.5. There are two independent
execution slots, so up to two positions can be open at once. XAUUSD is
observed once per second.

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

## 0b. Effective settings at a glance

| Setting | Value |
|---|---|
| Instrument / timeframe | XAUUSD, M1 |
| RSI | period 5, applied to Close (**verified** against the terminal's own `iRSI`, agreement to 5e-11) |
| Sell 2 / Sell 1 | 91 / 82 |
| Buy 1 / Buy 2 | 18 / 8.9 |
| Extreme SELL | **98.5** (triggering and rearming) |
| Extreme BUY | **1.5** (triggering and rearming) |
| Take profit / stop loss | $5 / $5 of gold price |
| Volume | 0.5 lot per order |
| Execution slots | `RETEST` and `EXTREME`, one entry each — **max 2 positions** |
| Magic numbers | 262610190 (RETEST), 262610191 (EXTREME) |
| Observation cadence | once per second |

### The two execution slots

| Slot | Setups |
|---|---|
| `RETEST` | SELL peak retest, BUY trough retest |
| `EXTREME` | Extreme SELL (>= 98.5), Extreme BUY (<= 1.5) |

- A retest position and an extreme position **may** be open at the same time.
- A second entry in the **same** family is refused while the first is
  unresolved — including an `UNKNOWN` submission, which holds its slot
  precisely because its outcome is not known.
- This is **not** one slot per directional setup: a SELL retest and a BUY
  retest compete for the same slot.
- Exposure the application cannot attribute to a slot — a foreign or manual
  position, or an unresolved submission from a retired strategy — still blocks
  **both** families.

**Broker requirement.** Two independent positions on one symbol exist only on
a hedging account. The application reads `account_info().margin_mode` and
refuses the second concurrent position unless it is `RETAIL_HEDGING`, rather
than emulating it with one net position. This account (MetaQuotes-Demo
5055783885) reports `RETAIL_HEDGING`, so both slots are usable here.

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
| `backend/.env` | `XAUUSD_RSI_SCHEDULER_INTERVAL_SECONDS` | Watch cycle, default **1**. The strategy must evaluate at the observation cadence, not merely receive observations at it. |
| `collector/.env` | `XAUUSD_RSI_EXECUTION_ENABLED` | Must be `true` for the collector to run its one-second XAUUSD observation thread and poll for orders. Requires a collector restart. |
| `backend/.env` | `GOLD_TELEGRAM_CHAT_ID` | The owner's Telegram destination. |
| `backend/.env` | `GOLD_TELEGRAM_CHAT_IDS` | Additional destinations, comma separated, each `Label:id`. Added to the owner's, never replacing it. |

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

## 2b. One-second observation

XAUUSD is read **every second**, on a thread dedicated to it inside the
collector, and the strategy's watch loop evaluates at the same cadence. Both
halves are required: a one-second collector feeding a slower evaluator would
not deliver one-second reaction.

- The collector fetches **incremental ticks** since a cursor, so movement
  between polls is captured rather than only the instant each poll lands on.
- The cursor's boundary tick is never re-pushed, and an unchanged quote
  produces no synthetic observation — a poll having happened is not itself
  market information.
- A failed push does not advance the cursor, so nothing is silently lost.
- The main collector poll loop keeps its own interval, so unrelated EURUSD
  collection is unchanged.

**Cadence is measured, not assumed.** The dashboard reports the median, p95
and worst observed interval against the one-second target, and marks it
DEGRADED rather than quietly reporting the configured value. Check it after
starting:

```bash
# median / p95 / worst, plus how many cycles were measured
curl -s -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
  http://localhost:8420/research/xauusd-rsi-status | jq .observation.cadence
```

Honest limitation: an entry still has to pass through the backend queue and
the collector's order poll, which runs on the main loop. One-second detection
does not by itself mean one-second submission, and the decision's own
signal-age and price-deviation guards will refuse an entry that arrived too
late to still be the event the rules described.

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
| `262610190` | **Active** RSI strategy, RETEST slot | $5 / $5 | Yes |
| `262610191` | **Active** RSI strategy, EXTREME slot | $5 / $5 | Yes |
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

## 6b. Telegram recipients

Notifications go to every configured recipient, with **one delivery record
each**. A retry re-sends only the recipient that failed, and one recipient's
success never hides another's failure.

Verify the audience, and optionally send a labelled test:

```bash
cd backend
npm run xauusd-rsi:telegram-test             # verify only, sends nothing
npm run xauusd-rsi:telegram-test -- --send   # verify, then send one test each
```

The verification step calls Telegram's own `getChat` for every destination
before anything is sent. If a recipient fails, the usual cause is that the
person has never started a conversation with the bot — a bot cannot message
someone who has not pressed Start. The error names the chat and says so.

The test message is clearly labelled as a delivery test, reports the actual
current execution state, and goes out through a dedicated event type so its
audit record can never be mistaken for a trading notification. It creates no
trade, position, signal or incident.

API acceptance confirms Telegram accepted the message. It does not confirm
anyone read it.

---

## 7. Evaluating the strategy

```bash
cd backend && npm run xauusd-rsi:evaluate
```

Read the output's own caveats carefully. The long-horizon numbers come from a
**closed-bar approximation**, which is a different strategy from the one that
trades: over the *same* 1.54 days of tick coverage the approximation produced
1 signal and the faithful replay produced 39. The faithful replay is limited
to whatever ordered tick history exists, and 11 trades is far too few to
conclude anything. Running the collector with the observation thread enabled
accumulates that history going forward.

The spread is **not** deducted from P&L — the entry and exit prices already
express it. A resolved trade realises exactly ±$250 at 0.5 lots, and the
spread instead affects how often a target is reached at all.
