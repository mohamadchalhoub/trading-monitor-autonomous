"""The Phase 2 main loop: connect, push to the backend, print locally,
reconnect on failure, shut down cleanly.

Three cadences share one loop rather than separate threads: every tick
pushes an account snapshot (idempotent on captured_at); every
TRADE_SYNC_INTERVAL_SECONDS, a trade-sync runs; every
CANDLE_SYNC_INTERVAL_SECONDS (historical chart reconstruction phase, off
unless CANDLE_SYMBOLS is set), a candle-sync runs. All three read the
server's own cursor rather than local state, so a process restart can never
desync any of them.
"""
from __future__ import annotations

import logging
import signal
import threading
from datetime import datetime, timedelta, timezone
from types import FrameType

from app.api_client import ApiClient, ApiClientError
from app.api_mapper import build_candles_payload, build_snapshot_payload, build_trades_payload
from app.config import CANDLE_DURATION_BY_TIMEFRAME, Config
from app.executor import DemoAccountRequiredError, Executor
from app.formatting import (
    format_account_summary,
    format_connection_status,
    format_deals_table,
    format_positions_table,
)
from app.mt5_client import Mt5Client

logger = logging.getLogger("collector.runner")

COLLECTOR_VERSION = "0.2.0"
TRADE_SYNC_INTERVAL_SECONDS = 60
# Historical chart reconstruction phase — how many candles go in one
# /collector/candles push. A multi-year M5 backfill is hundreds of
# thousands of rows; batching keeps any single HTTP request (and the
# backend's own per-request upsert loop) to a bounded size rather than one
# giant payload.
CANDLE_PUSH_BATCH_SIZE = 2000
# Re-fetched every candle-sync tick alongside whatever's new, in case the
# most recently stored bar was still forming (and therefore incomplete) the
# last time it was pushed.
CANDLE_SYNC_OVERLAP_BARS = 3
# MT5's copy_rates_range() rejects an overly large request outright (found
# live, this session: a ~1000-day M5 request — ~288k bars — returned None
# with "Terminal: Invalid params"; the same call for a coarser timeframe
# over the same date range succeeded). Fetching in bounded date chunks
# regardless of timeframe sidesteps whatever the terminal's own per-call
# limit actually is, at the cost of more (still local, still fast) calls —
# never fewer real candles, never a fabricated one.
CANDLE_FETCH_CHUNK_DAYS = 30
# Ichimoku needs 78 closed candles minimum (26 displacement + 52 Senkou B
# period — see technical-analysis-report.service.ts's own comment) before
# it can compute anything at all. CANDLE_INITIAL_SYNC_DAYS is one global
# setting shared by every timeframe (currently 1000d in this deployment's
# own collector/.env, sized for M5/M15/H1/M30/H4/D1's needs) — raising it
# globally to cover W1/MN1 would multiply the M5 backfill by the same
# factor for no reason, since M5 already has far more than 78 candles in
# 1000 days. This per-timeframe FLOOR only ever pushes W1/MN1's own
# first-ever backfill further back; every other timeframe is unaffected
# (max() with 0 is a no-op for any timeframe not listed here).
_MIN_INITIAL_SYNC_DAYS_BY_TIMEFRAME: dict[str, int] = {
    "W1": 1825,   # ~5 years / ~260 weekly candles — well past the 78 minimum
    "MN1": 5475,  # ~15 years / ~180 monthly candles — same reasoning
}


class CollectorApp:
    def __init__(self, config: Config, client: Mt5Client, api: ApiClient, executor: Executor) -> None:
        self._config = config
        self._client = client
        self._api = api
        self._executor = executor
        self._stop_event = threading.Event()
        self._last_trade_sync_at: datetime | None = None
        self._last_candle_sync_at: datetime | None = None

    def install_signal_handlers(self) -> None:
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    def _handle_signal(self, signum: int, frame: FrameType | None) -> None:
        logger.info("shutdown signal received", extra={"signal": signum})
        self._stop_event.set()

    def run(self) -> int:
        logger.info("collector starting", extra={
            "poll_interval_seconds": self._config.poll_interval_seconds,
            "trade_sync_interval_seconds": TRADE_SYNC_INTERVAL_SECONDS,
            "explicit_credentials": self._config.has_explicit_credentials,
            "account_id": self._config.collector_account_id,
            "api_base_url": self._config.collector_api_base_url,
            "candle_symbols": self._config.candle_symbols,
            "candle_timeframes": self._config.candle_timeframes if self._config.candle_symbols else (),
            "autonomous_execution_enabled": self._config.autonomous_execution_enabled,
        })

        backoff = self._config.reconnect_initial_backoff_seconds
        try:
            while not self._stop_event.is_set():
                if not self._client.is_connected():
                    connected, backoff = self._attempt_connect(backoff)
                    if not connected:
                        continue

                self._push_and_print_snapshot()
                if self._trade_sync_due():
                    self._sync_trades()
                if self._candle_sync_due():
                    self._sync_candles()
                if self._config.autonomous_execution_enabled:
                    self._poll_and_execute_pending_order()

                backoff = self._config.reconnect_initial_backoff_seconds
                self._stop_event.wait(timeout=self._config.poll_interval_seconds)
        finally:
            logger.info("collector shutting down, disconnecting from terminal")
            self._client.disconnect()

        logger.info("collector stopped cleanly")
        return 0

    def _deals_lookup_adapter(self, since):
        """Adapts `Mt5Client.get_deals_since()`'s dicts to the flat
        `{"symbol", "magic", "ticket", "volume", "price"}` shape
        `executor.py`'s `find_recent_deal` expects. `get_deals_since()`
        doesn't surface `magic` as a top-level field (it wasn't needed by
        this project's own analytics use of it), but preserves the full raw
        deal under `"raw"`, which does — extracted here rather than
        changing `get_deals_since()`'s own established return shape for
        every other caller.
        """
        deals = self._client.get_deals_since(since)
        return [{**d, "magic": (d.get("raw") or {}).get("magic")} for d in deals]

    def _attempt_connect(self, backoff: float) -> tuple[bool, float]:
        result = self._client.connect()
        if result.ok:
            logger.info("connected to MT5 terminal")
            if self._config.autonomous_execution_enabled:
                # Points the executor at THIS connection's real handle
                # (native import or RPyC bridge proxy) — not knowable at
                # construction time, and re-pointed on every reconnect
                # since a bridge reconnect gets a genuinely new proxy object.
                self._executor.set_mt5_module(self._client.get_mt5_module())
                # Audit finding: wires deal-history reconciliation (see
                # executor.py's own `set_deals_lookup` comment) through
                # `Mt5Client.get_deals_since`, which already handles a real,
                # verified-live MT5-under-Wine quirk (history_deals_get()
                # needs broker-timezone-aware epoch seconds, not datetime
                # objects) — reusing it here instead of a second,
                # independent implementation of the same lookup.
                self._executor.set_deals_lookup(self._deals_lookup_adapter)
            return True, self._config.reconnect_initial_backoff_seconds

        logger.warning(
            "MT5 connection failed, will retry",
            extra={"error_code": result.error_code, "error_message": result.error_message,
                   "retry_in_seconds": backoff},
        )
        self._stop_event.wait(timeout=backoff)
        next_backoff = min(backoff * 2, self._config.reconnect_max_backoff_seconds)
        return False, next_backoff

    def _push_and_print_snapshot(self) -> None:
        terminal = self._client.get_terminal_info()
        mt5_connected = terminal.get("connected") if terminal else None
        last_error = None if mt5_connected else self._client.last_error()[1]
        account = self._client.get_account_info()
        positions = self._client.get_open_positions()
        # Best-effort — a fresh, genuine bid/ask read on every snapshot tick
        # (this method's own 10s cadence) closes the gap between this
        # system's coarsest number (an M5 candle close, up to ~10 minutes
        # stale by the time it's synced) and what a trader sees live on
        # their own terminal. `None` (e.g. no candle_symbols configured, or
        # a transient MT5 error) is a safe no-op — the backend/technical-
        # analysis layer falls back to the candle-based price exactly as
        # before this existed.
        live_tick = (
            self._client.get_live_tick(self._config.candle_symbols[0])
            if self._config.candle_symbols
            else None
        )

        payload = build_snapshot_payload(
            account_id=self._config.collector_account_id,
            account=account,
            positions=positions,
            mt5_connected=mt5_connected,
            last_error=last_error,
            collector_version=COLLECTOR_VERSION,
            live_tick=live_tick,
        )
        try:
            self._api.post_snapshot(payload)
            push_ok = True
        except ApiClientError as exc:
            logger.warning("snapshot push failed, will retry next tick", extra={"error": str(exc)})
            push_ok = False

        separator = "=" * 72
        print(separator)
        print(format_connection_status(True, mt5_connected, account.get("server") if account else None))
        print(format_account_summary(account))
        print(format_positions_table(positions))
        print(f"BACKEND PUSH: {'ok' if push_ok else 'FAILED — see logs'}")
        print(separator, flush=True)

        logger.info("snapshot cycle complete", extra={
            "mt5_connected": mt5_connected,
            "open_positions": len(positions),
            "push_ok": push_ok,
        })

    def _poll_and_execute_pending_order(self) -> None:
        """Autonomous demo trading (v2), Phase 6 — the collector asking the
        backend "is there anything approved for me to execute," and, if so,
        actually placing it. Only ever reached when
        autonomous_execution_enabled is explicitly true (an existing
        deployment's behavior is otherwise unchanged). Every failure mode
        here is caught and logged, never left to crash the main loop — the
        SAME posture collector-ingress.controller.ts's own rule-evaluation
        step already takes on the backend side ("one component's failure
        must never take down another").
        """
        try:
            response = self._api.get_pending_order(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("pending-order poll failed, will retry next tick", extra={"error": str(exc)})
            return

        order = response.get("order")
        if not order:
            return

        logger.info("pending order claimed, attempting execution", extra={
            "decision_id": order["decisionId"], "side": order["side"], "volume": order["volume"],
        })

        try:
            result = self._executor.send_bracket_order(
                side=order["side"],
                volume=order["volume"],
                stop_loss_points=order["stopLossPoints"],
                take_profit_points=order["takeProfitPoints"],
                magic=order["magic"],
                comment=order["comment"],
            )
        except DemoAccountRequiredError as exc:
            # The single most severe event this process can encounter — logged
            # at CRITICAL specifically so it stands out from ordinary warnings,
            # and still reported back (never left stuck as SENT forever), but
            # never silently swallowed like an ordinary execution failure.
            logger.critical("DEMO ACCOUNT CHECK FAILED — refusing to trade", extra={"error": str(exc)})
            self._report_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return
        except Exception as exc:  # noqa: BLE001 — must never crash the main loop over this
            logger.error("order execution raised an unexpected error", extra={"error": str(exc)})
            self._report_execution_result(order["decisionId"], ok=False, error_message=str(exc))
            return

        logger.info("order execution result", extra={
            "decision_id": order["decisionId"], "ok": result.ok, "ticket": result.ticket,
            "retcode": result.retcode, "error": result.error_message,
        })
        self._report_execution_result(
            order["decisionId"], ok=result.ok, ticket=result.ticket,
            filled_price=result.price, error_message=result.error_message,
        )

    def _report_execution_result(
        self, decision_id: str, *, ok: bool, ticket: int | None = None,
        filled_price: float | None = None, error_message: str | None = None,
    ) -> None:
        payload: dict = {"ok": ok}
        if ticket is not None:
            payload["ticket"] = ticket
        if filled_price is not None:
            payload["filledPrice"] = filled_price
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            self._api.post_execution_result(self._config.collector_account_id, decision_id, payload)
        except ApiClientError as exc:
            # The order itself already happened (or definitively failed) on
            # MT5's side by this point — a failure to REPORT that back is a
            # visibility problem, not a trading-safety one, but it does mean
            # the decision row stays stuck as SENT until this is noticed.
            logger.error("failed to report execution result back to backend", extra={"decision_id": decision_id, "error": str(exc)})

    def _trade_sync_due(self) -> bool:
        if self._last_trade_sync_at is None:
            return True
        elapsed = (datetime.now(tz=timezone.utc) - self._last_trade_sync_at).total_seconds()
        return elapsed >= TRADE_SYNC_INTERVAL_SECONDS

    def _sync_trades(self) -> None:
        try:
            cursor = self._api.get_cursor(self._config.collector_account_id)
        except ApiClientError as exc:
            logger.warning("could not fetch sync cursor, skipping this trade-sync tick",
                            extra={"error": str(exc)})
            return

        last_synced_at = cursor.get("lastSyncedAt")
        if last_synced_at:
            date_from = _parse_iso(last_synced_at) - timedelta(
                minutes=self._config.history_sync_overlap_minutes
            )
        else:
            date_from = datetime.now(tz=timezone.utc) - timedelta(days=self._config.initial_sync_days)

        deals = self._client.get_deals_since(date_from)
        payload = build_trades_payload(self._config.collector_account_id, deals)

        try:
            result = self._api.post_trades(payload)
            logger.info("trade sync pushed", extra={
                "date_from": date_from.isoformat(), "deals_sent": len(deals),
                "trades_created": result.get("created"), "trades_updated": result.get("updated"),
            })
        except ApiClientError as exc:
            logger.warning("trade sync push failed, cursor unchanged, will retry next tick",
                            extra={"error": str(exc)})
            return

        print(format_deals_table(deals, days=self._config.initial_sync_days))
        self._last_trade_sync_at = datetime.now(tz=timezone.utc)

    def _candle_sync_due(self) -> bool:
        if not self._config.candle_symbols:
            return False  # off by default — CANDLE_SYMBOLS unset
        if self._last_candle_sync_at is None:
            return True
        elapsed = (datetime.now(tz=timezone.utc) - self._last_candle_sync_at).total_seconds()
        return elapsed >= self._config.candle_sync_interval_seconds

    def _sync_candles(self) -> None:
        """Historical chart reconstruction phase — one (symbol, timeframe)
        pair at a time: ask the backend for its own latest stored candle
        (server cursor, same "never local state" reasoning _sync_trades
        already uses), backfill from there (or from CANDLE_INITIAL_SYNC_DAYS
        ago if nothing stored yet) to now, and push in bounded batches.
        A slow first-ever backfill for one pair must never stop the others
        from being attempted this tick.
        """
        for symbol in self._config.candle_symbols:
            for timeframe in self._config.candle_timeframes:
                try:
                    self._sync_one_candle_series(symbol, timeframe)
                except ApiClientError as exc:
                    logger.warning("candle sync push failed, will retry next tick", extra={
                        "symbol": symbol, "timeframe": timeframe, "error": str(exc),
                    })
        self._last_candle_sync_at = datetime.now(tz=timezone.utc)

    def _sync_one_candle_series(self, symbol: str, timeframe: str) -> None:
        cursor = self._api.get_latest_candle_time(symbol, timeframe)
        latest = cursor.get("latestOpenTime")

        now = datetime.now(tz=timezone.utc)
        if latest:
            bar_duration = CANDLE_DURATION_BY_TIMEFRAME[timeframe]
            date_from = _parse_iso(latest) - (bar_duration * CANDLE_SYNC_OVERLAP_BARS)
            logger.info("candle sync (incremental)", extra={"symbol": symbol, "timeframe": timeframe, "date_from": date_from.isoformat()})
        else:
            initial_sync_days = max(
                self._config.candle_initial_sync_days,
                _MIN_INITIAL_SYNC_DAYS_BY_TIMEFRAME.get(timeframe, 0),
            )
            date_from = now - timedelta(days=initial_sync_days)
            logger.info("candle sync (initial backfill — this may take a while)", extra={
                "symbol": symbol, "timeframe": timeframe, "date_from": date_from.isoformat(),
            })

        candles = self._fetch_candles_chunked(symbol, timeframe, date_from, now)
        if not candles:
            return

        for i in range(0, len(candles), CANDLE_PUSH_BATCH_SIZE):
            batch = candles[i : i + CANDLE_PUSH_BATCH_SIZE]
            payload = build_candles_payload(symbol, timeframe, batch)
            result = self._api.post_candles(payload)
            logger.info("candle batch pushed", extra={
                "symbol": symbol, "timeframe": timeframe,
                "batch_size": len(batch), "upserted": result.get("upserted"),
            })

    def _fetch_candles_chunked(self, symbol: str, timeframe: str, date_from: datetime, date_to: datetime) -> list[dict]:
        """Splits [date_from, date_to) into CANDLE_FETCH_CHUNK_DAYS-sized
        windows and fetches each separately — see CANDLE_FETCH_CHUNK_DAYS'
        own comment for why one giant request isn't safe to assume MT5 will
        honor. A single chunk failing (mt5_client.get_candles already
        degrades to an empty list on any MT5-side error) never stops the
        remaining chunks from being tried.
        """
        chunk = timedelta(days=CANDLE_FETCH_CHUNK_DAYS)
        all_candles: list[dict] = []
        chunk_start = date_from
        while chunk_start < date_to:
            chunk_end = min(chunk_start + chunk, date_to)
            all_candles.extend(self._client.get_candles(symbol, timeframe, chunk_start, chunk_end))
            chunk_start = chunk_end
        return all_candles


def _parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
