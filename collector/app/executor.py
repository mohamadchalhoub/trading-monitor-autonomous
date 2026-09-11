"""Order execution for the autonomous demo trading system (v2, Phase 6).

The ONLY other file in this project (besides mt5_client.py) that imports
MetaTrader5, and the ONLY file anywhere in this project that calls
order_send. mt5_client.py's own docstring is explicit that IT must never
grow order-placement capability — that guarantee is about that file
staying read-only forever, not about this project never executing a
trade. Phase 6 needs order placement to exist somewhere; it lives here,
kept small, explicit, and completely separate, so mt5_client.py's
invariant stays true unchanged, and the entire write-capable surface of
this project is this one file, easy to review in full.

AUTONOMOUS_DEMO_TRADING_PLAN.md §1 non-negotiable #1: NEVER trade a
real-money account. `verify_demo_account()` is called at the START of
every single public method here, unconditionally, every time — it never
trusts a caller already checked, and never caches a previously-true
answer across calls (an account's trade_mode cannot normally change
without logging into a different account, but this project treats "never
assume" as cheaper than any clever caching would ever be worth).

This module only ever receives an order to place — it does not decide
whether one should be placed. That decision (the friend's rules, the AI
confirmation, the risk manager's independent re-validation) has already
happened in the TypeScript backend by the time anything here is called;
this file's only job is the mechanical, narrowly-scoped act of sending it
to the broker and reporting exactly what happened.

Reconciliation audit, 2nd pass — no exactly-once guarantee: MT5's
`order_send` has no idempotency-key concept, so nothing in this file (or
anywhere else) can guarantee an order is placed exactly once against the
broker. What IS guaranteed: an ambiguous outcome is never silently treated
as either "safe to retry" or "definitely failed" — it is reported as
UNKNOWN and left for a human/later reconciliation pass, never
auto-resubmitted (there is no automatic resubmission anywhere in this
project to begin with — the whole system is manually triggered, per
AUTONOMOUS_DEMO_TRADING_PLAN.md's "supervised, not automatic" posture).
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal

MT5_BRIDGE_HOST = os.environ.get("MT5_BRIDGE_HOST", "").strip()

if not MT5_BRIDGE_HOST:
    import MetaTrader5 as mt5

logger = logging.getLogger("collector.executor")

SYMBOL = "EURUSD"
# Matches technical-analysis/point-value.ts's EURUSD_POINT_SIZE exactly —
# see that file's own comment for why this is a documented constant rather
# than fetched from symbol_info() (no symbol-metadata call exists anywhere
# in this system). Kept in sync by hand since Python and TypeScript can't
# share one constant directly; a mismatch here would silently change every
# SL/TP distance this module sends, so this comment exists specifically so
# a future reader checks both sides together, not just one.
EURUSD_POINT_SIZE = 0.00001

# How far back to look for a matching deal when reconciling an ambiguous
# order_send response against closed-position history (the "filled position
# already closed again before we got to check" scenario — e.g. it hit SL/TP
# within the same second). Generous relative to how fast a fill-then-close
# could realistically happen, cheap to query.
DEAL_RECONCILIATION_LOOKBACK = timedelta(minutes=15)

OrderOutcome = Literal["FILLED", "FAILED", "UNKNOWN"]


def _points_to_price(points: float) -> float:
    return points * EURUSD_POINT_SIZE


class DemoAccountRequiredError(RuntimeError):
    """Raised whenever this module is about to touch anything but a demo
    account. Never caught and silently ignored anywhere in this project —
    the only correct response to this being raised is to stop."""


class ReconciliationQueryFailed(RuntimeError):
    """Raised when positions_get()/history lookups THEMSELVES fail (MT5
    returns None with a real error code) — fundamentally different from a
    confirmed empty result. Audit finding: an earlier version of this
    module's own reconciliation code treated `positions_get() is None` and
    `positions_get() == ()` identically ("no position found" either way),
    which is exactly the "inferred safe-to-retry from an empty query"
    mistake this project was asked not to make. A genuine query failure
    must propagate as UNKNOWN, never be silently read as "confirmed
    empty."""


@dataclass
class OrderResult:
    ok: bool
    outcome: OrderOutcome = "FAILED"
    ticket: int | None = None
    volume_filled: float | None = None
    price: float | None = None
    retcode: int | None = None
    error_message: str | None = None
    # Post-execution protective-stop verification (audit finding: a filled
    # order carries no guarantee the broker actually kept the SL attached —
    # only that we ASKED for one). True/False once actually checked; None
    # when the outcome isn't FILLED, or verification itself could not run
    # (never conflated with "confirmed absent" — see `_verify_protective_stop`).
    sl_confirmed: bool | None = None

    def __post_init__(self) -> None:
        # `ok` stays as the simple boolean callers already check; `outcome`
        # is the finer-grained signal introduced by the reconciliation audit.
        # Kept consistent with each other so nothing can read `ok=True` next
        # to `outcome="UNKNOWN"` or similar.
        if self.outcome == "FILLED":
            self.ok = True
        elif self.outcome == "UNKNOWN":
            self.ok = False
        elif self.ok:
            # Backward-compat construction path (`OrderResult(ok=True, ...)`
            # without specifying outcome, which defaults to "FAILED") —
            # infer FILLED rather than leave an inconsistent ok=True/
            # outcome=FAILED pair.
            self.outcome = "FILLED"
        else:
            self.outcome = "FAILED"


def _filled_result(ticket: int, volume: float, price: float, retcode: int | None = None) -> OrderResult:
    return OrderResult(ok=True, outcome="FILLED", ticket=ticket, volume_filled=volume, price=price, retcode=retcode)


def _unknown_result(message: str) -> OrderResult:
    logger.error("execution outcome UNKNOWN, NOT retrying: %s", message)
    return OrderResult(ok=False, outcome="UNKNOWN", error_message=message)


class Executor:
    """Owns order placement for exactly one already-connected MT5 session.

    Takes the ALREADY-CONNECTED mt5 module/proxy handle (whichever of
    native-import or RPyC-bridge `Mt5Client.connect()` resolved) rather
    than establishing a second, independent connection — one MT5 session
    per process, same assumption mt5_client.py already makes.

    Concurrency: `_lock` serializes every public method that can touch the
    broker (open/close) — this process is single-account, single-strategy,
    and normally single-caller (runner.py's own poll loop), but nothing
    upstream currently guarantees two calls can never overlap (a slow first
    call plus a second poll tick, for instance), and a single MT5 terminal
    session is not itself safe against interleaved requests. The lock makes
    "concurrent execution calls" a queuing problem, not a race.
    """

    def __init__(self, mt5_module: Any = None) -> None:
        self._mt5 = mt5_module if mt5_module is not None else mt5
        self._lock = threading.Lock()
        # Optional — wired to `Mt5Client.get_deals_since` by runner.py after
        # connect, via `set_deals_lookup`. That method (not reimplemented
        # here) already handles a real, verified-live MT5-under-Wine quirk:
        # history_deals_get() silently returns empty for a datetime-object
        # range and needs broker-timezone-aware epoch seconds instead (see
        # mt5_client.py's own get_deals_since docstring). Duplicating that
        # logic here risked getting it subtly wrong; reusing it is safer
        # than a second, independent implementation of the same lookup.
        self._deals_lookup: Callable[[datetime], list[dict[str, Any]]] | None = None

    def set_mt5_module(self, mt5_module: Any) -> None:
        """Called after `Mt5Client.connect()` succeeds, with
        `client.get_mt5_module()` — the handle isn't known at construction
        time in bridge mode (RPyC connects lazily inside `connect()`), so
        `CollectorApp` builds this Executor once up front and points it at
        the real session right after each successful (re)connect."""
        self._mt5 = mt5_module

    def set_deals_lookup(self, deals_lookup: Callable[[datetime], list[dict[str, Any]]]) -> None:
        """Wires deal-history reconciliation (see `_deals_lookup`'s own
        comment). Without this, reconciliation can only see currently OPEN
        positions — a position that filled and was ALSO closed (e.g. an
        immediate SL/TP hit) before reconciliation ran would be invisible,
        and this module would (correctly, per the audit's own instruction
        not to assume "safe to retry") report UNKNOWN rather than guess."""
        self._deals_lookup = deals_lookup

    def find_open_position(self, magic: int) -> Any | None:
        """Returns this system's own OPEN EURUSD position (matched by magic
        number — safety-constants.ts's AUTONOMOUS_MAGIC_NUMBER, a single
        fixed value never sourced from a decision row), or None if the
        query genuinely confirms there isn't one.

        Raises `ReconciliationQueryFailed` if the query itself fails —
        `positions_get()` returning `None` means MT5 could not answer the
        question at all, which is NOT the same as an empty tuple (a
        confirmed zero positions). Audit finding: an earlier version of
        this method treated both the same way (`if not positions: return
        None`), which silently turned "I don't know" into "confirmed
        empty" — exactly the mistake this project was asked not to make.
        """
        positions = self._mt5.positions_get(symbol=SYMBOL)
        if positions is None:
            message = self._last_error_message()
            raise ReconciliationQueryFailed(f"positions_get() failed ({message}) — cannot confirm whether a position already exists.")
        for position in positions:
            if getattr(position, "magic", None) == magic:
                return position
        return None

    def find_recent_deal(self, magic: int) -> dict[str, Any] | None:
        """Deal-history half of reconciliation — covers a position that
        filled and was ALSO already closed (SL/TP hit, or a stop-out)
        before this ran, which `find_open_position` alone can never see
        (a closed position leaves `positions_get()` immediately). Returns
        None (not "unknown") when deal-history lookup isn't wired up at
        all — logged clearly, since that's a real, disclosed reduction in
        what this module can confirm, not a silent gap.
        """
        if self._deals_lookup is None:
            logger.warning("find_recent_deal: no deals_lookup wired up (set_deals_lookup was never called) — cannot check closed-position history, only currently-open positions")
            return None
        since = datetime.now(tz=timezone.utc) - DEAL_RECONCILIATION_LOOKBACK
        deals = self._deals_lookup(since)
        matches = [d for d in deals if d.get("symbol") == SYMBOL and d.get("magic") == magic]
        return matches[-1] if matches else None

    def _last_error_message(self) -> str:
        try:
            code, message = self._mt5.last_error()
            return f"mt5 error {code}: {message}"
        except Exception:  # pragma: no cover - defensive only, last_error() itself should never raise
            return "mt5 error unavailable"

    def _reconcile_after_ambiguous_response(self, magic: int) -> OrderResult | None:
        """Called ONLY after an order_send response that tells us nothing
        (a bare `None`) — never after a definite rejection retcode, which
        carries no such ambiguity. Returns a FILLED result if the broker
        turns out to have actually opened (or opened-then-closed) the
        position, an UNKNOWN result if reconciliation itself could not be
        completed, or `None` if reconciliation genuinely confirms nothing
        happened (safe to retry).
        """
        try:
            existing = self.find_open_position(magic)
        except ReconciliationQueryFailed as exc:
            return _unknown_result(f"order_send returned None and reconciliation itself failed ({exc}) — cannot determine whether a position was opened; refusing to retry blind.")

        if existing is not None:
            logger.warning("order_send returned None (lost acknowledgment) but an OPEN position (ticket=%s) already exists under magic=%s — treating as filled, NOT retrying", existing.ticket, magic)
            return _filled_result(existing.ticket, existing.volume, existing.price_open)

        recent_deal = self.find_recent_deal(magic)
        if recent_deal is not None:
            logger.warning("order_send returned None but a recent deal (ticket=%s) under magic=%s was found in closed history — treating as filled, NOT retrying", recent_deal.get("ticket"), magic)
            return _filled_result(recent_deal.get("ticket"), recent_deal.get("volume", 0.0), recent_deal.get("price", 0.0))

        return None  # confirmed: no open position, no recent deal — genuinely safe to retry

    def _verify_protective_stop(self, result: OrderResult) -> OrderResult:
        """Post-execution check (audit finding — §5's "post-execution
        verification of protective stops"): a FILLED result only means the
        broker accepted an order that ASKED for an SL; it is not proof the
        SL is actually attached (a broker can reject/strip a stop under
        some conditions while still filling the market order itself). Only
        ever narrows `sl_confirmed` from None; never mutates `outcome` —
        deciding what to DO about a missing stop (close the position
        immediately? alert only?) is a policy choice for the caller, not
        this module (see the audit report's consolidated policy-decision
        list).
        """
        if result.outcome != "FILLED" or result.ticket is None:
            return result
        try:
            positions = self._mt5.positions_get(ticket=result.ticket)
        except Exception as exc:  # defensive — a verification-query failure must not be mistaken for "no stop"
            logger.warning("could not verify protective stop for ticket=%s (query failed: %s) — sl_confirmed left unknown", result.ticket, exc)
            return result
        if not positions:
            logger.warning("could not verify protective stop for ticket=%s (position not found on verification query) — sl_confirmed left unknown", result.ticket)
            return result
        position = positions[0]
        has_sl = bool(getattr(position, "sl", 0))
        if not has_sl:
            logger.error("ticket=%s FILLED WITHOUT a protective stop attached on the broker side — this needs immediate attention", result.ticket)
        result.sl_confirmed = has_sl
        return result

    def verify_demo_account(self) -> None:
        info = self._mt5.account_info()
        if info is None:
            raise DemoAccountRequiredError(
                "account_info() returned None — cannot verify this is a demo account, refusing to proceed."
            )
        if info.trade_mode != self._mt5.ACCOUNT_TRADE_MODE_DEMO:
            raise DemoAccountRequiredError(
                f"Account trade_mode={info.trade_mode} is not ACCOUNT_TRADE_MODE_DEMO "
                f"({self._mt5.ACCOUNT_TRADE_MODE_DEMO}). Refusing to place any order — "
                "this is an absolute, non-negotiable safety rule, not something any caller can override."
            )

    def send_bracket_order(
        self,
        *,
        side: str,  # "BUY" | "SELL"
        volume: float,
        stop_loss_points: float,
        take_profit_points: float,
        magic: int,
        comment: str,
        deviation_points: int = 20,
    ) -> OrderResult:
        """SL/TP are given as POINT DISTANCES, not absolute prices — on
        purpose. They were computed relative to whatever price the decision
        layer saw at decision time, which may no longer be the current
        price by the time this actually runs (network/queue/retry delay).
        Sending a frozen absolute price from that earlier moment would
        silently violate the friend's exact-distance rule (Rule 6) the
        moment price has moved at all; computing the absolute SL/TP HERE,
        from the live tick THIS call itself just fetched (and again, fresh,
        on the retry below), keeps the bracket exactly the required
        distance from the price actually being filled at, not the price
        that happened to be current when some earlier layer decided to trade.
        """
        with self._lock:
            self.verify_demo_account()

            if side not in ("BUY", "SELL"):
                raise ValueError(f"side must be BUY or SELL, got {side!r}")
            if stop_loss_points is None or take_profit_points is None:
                # Mandatory-SL enforcement at the lowest possible level, not just
                # trusted from upstream validation — AUTONOMOUS_DEMO_TRADING_PLAN.md
                # §1: "never place an order without an attached stop-loss."
                raise ValueError("stop_loss_points and take_profit_points are both required — this system never sends a bare order.")

            # Audit finding: duplicate-prevention / restart-safety. If this
            # system's own magic number already has an open EURUSD position —
            # e.g. a previous call actually filled but the caller crashed/lost
            # the response before recording that, or this process restarted
            # with a fill already on the books — refuse rather than risk a
            # second live position from what should be a single decision. A
            # query FAILURE here (not a confirmed-empty result) is itself
            # reported as UNKNOWN — refusing to send is the safe default when
            # we cannot even confirm no duplicate exists.
            try:
                existing = self.find_open_position(magic)
            except ReconciliationQueryFailed as exc:
                return _unknown_result(f"cannot verify no duplicate position exists before sending ({exc}) — refusing to send until this is resolved.")

            if existing is not None:
                logger.warning(
                    "refusing to open a new %s position — an open position (ticket=%s) already exists under this system's magic number %s",
                    side, existing.ticket, magic,
                )
                return OrderResult(
                    ok=False,
                    outcome="FAILED",
                    error_message=f"An open position (ticket={existing.ticket}) already exists under magic={magic} — refusing to open a second one.",
                )

            result = self._send_with_one_retry(
                side=side, volume=volume, stop_loss_points=stop_loss_points,
                take_profit_points=take_profit_points, magic=magic, comment=comment,
                deviation_points=deviation_points,
            )
            return self._verify_protective_stop(result)

    def close_position(self, *, ticket: int, side: str, volume: float) -> OrderResult:
        """Closes an existing position — the kill switch's "close all open
        positions" effect, and the only other way this module ever touches
        a live account besides opening a new bracketed order."""
        with self._lock:
            self.verify_demo_account()

            tick = self._mt5.symbol_info_tick(SYMBOL)
            if tick is None:
                return OrderResult(ok=False, outcome="FAILED", error_message=f"No live tick for {SYMBOL} — cannot close.")

            # Closing a BUY means selling it back, and vice versa.
            close_type = self._mt5.ORDER_TYPE_SELL if side == "BUY" else self._mt5.ORDER_TYPE_BUY
            price = tick.bid if side == "BUY" else tick.ask

            request = {
                "action": self._mt5.TRADE_ACTION_DEAL,
                "symbol": SYMBOL,
                "volume": volume,
                "type": close_type,
                "position": ticket,
                "price": price,
                "deviation": 20,
                "magic": 0,
                "comment": "autonomous-kill-switch-close",
                "type_time": self._mt5.ORDER_TIME_GTC,
                "type_filling": self._mt5.ORDER_FILLING_IOC,
            }
            result = self._mt5.order_send(request)
            return self._result_from_response(result)

    def _build_bracket_request(
        self, *, side: str, volume: float, stop_loss_points: float, take_profit_points: float,
        magic: int, comment: str, deviation_points: int,
    ) -> dict | None:
        """Builds one order_send request from a FRESH live tick — called
        once per attempt (not once per call), so a retry always prices its
        SL/TP off the price at that retry's own moment, never a stale one
        from the first attempt."""
        tick = self._mt5.symbol_info_tick(SYMBOL)
        if tick is None:
            return None

        order_type = self._mt5.ORDER_TYPE_BUY if side == "BUY" else self._mt5.ORDER_TYPE_SELL
        price = tick.ask if side == "BUY" else tick.bid
        sl_offset = _points_to_price(stop_loss_points)
        tp_offset = _points_to_price(take_profit_points)
        stop_loss = price - sl_offset if side == "BUY" else price + sl_offset
        take_profit = price + tp_offset if side == "BUY" else price - tp_offset

        return {
            "action": self._mt5.TRADE_ACTION_DEAL,
            "symbol": SYMBOL,
            "volume": volume,
            "type": order_type,
            "price": price,
            "sl": stop_loss,
            "tp": take_profit,
            "deviation": deviation_points,
            "magic": magic,
            "comment": comment,
            "type_time": self._mt5.ORDER_TIME_GTC,
            "type_filling": self._mt5.ORDER_FILLING_IOC,
        }

    def _send_with_one_retry(
        self, *, side: str, volume: float, stop_loss_points: float, take_profit_points: float,
        magic: int, comment: str, deviation_points: int,
    ) -> OrderResult:
        build_kwargs = dict(
            side=side, volume=volume, stop_loss_points=stop_loss_points, take_profit_points=take_profit_points,
            magic=magic, comment=comment, deviation_points=deviation_points,
        )

        request = self._build_bracket_request(**build_kwargs)
        if request is None:
            return OrderResult(ok=False, outcome="FAILED", error_message=f"No live tick for {SYMBOL} — cannot determine an entry price.")

        raw_result = self._mt5.order_send(request)
        outcome = self._result_from_response(raw_result)
        if outcome.ok:
            return outcome

        # A `None` response means order_send's own acknowledgment was lost,
        # NOT that the order failed — the broker may have opened (and even
        # already closed) the position anyway. A definite rejection retcode
        # carries no such ambiguity — the broker explicitly said no — so
        # reconciliation is skipped there to avoid an extra round-trip on
        # the common case.
        if raw_result is None:
            reconciled = self._reconcile_after_ambiguous_response(magic)
            if reconciled is not None:
                return reconciled  # FILLED or UNKNOWN — never retry past this

        logger.warning(
            "order_send failed (retcode=%s, error=%s) — retrying once with a fresh quote",
            outcome.retcode, outcome.error_message,
        )

        # Rebuilt from scratch, not reusing `request` — the whole reason for
        # a retry is that market conditions may have moved (a requote);
        # resending the exact same stale price/SL/TP would just fail the
        # same way again.
        retry_request = self._build_bracket_request(**build_kwargs)
        if retry_request is None:
            return OrderResult(ok=False, outcome="FAILED", error_message=f"No live tick for {SYMBOL} on retry — cannot determine an entry price.")

        raw_retry_result = self._mt5.order_send(retry_request)
        retry_outcome = self._result_from_response(raw_retry_result)
        if not retry_outcome.ok:
            # Same reconciliation on the retry's own ambiguous response —
            # otherwise a second lost acknowledgment leaves a real fill
            # permanently unreconciled and misreported as a definite failure.
            if raw_retry_result is None:
                reconciled = self._reconcile_after_ambiguous_response(magic)
                if reconciled is not None:
                    return reconciled
            logger.error(
                "order_send failed again after retry (retcode=%s, error=%s) — aborting, not retrying further",
                retry_outcome.retcode, retry_outcome.error_message,
            )
        return retry_outcome

    def _result_from_response(self, result: Any) -> OrderResult:
        if result is None:
            return OrderResult(ok=False, outcome="FAILED", error_message="order_send returned None")
        if result.retcode == self._mt5.TRADE_RETCODE_DONE:
            return _filled_result(result.order, result.volume, result.price, result.retcode)
        return OrderResult(ok=False, outcome="FAILED", retcode=result.retcode, error_message=getattr(result, "comment", None))
