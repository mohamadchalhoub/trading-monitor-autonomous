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
    def __init__(self, config: Config, client: Mt5Client, api: ApiClient) -> None:
        self._config = config
        self._client = client
        self._api = api
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

                backoff = self._config.reconnect_initial_backoff_seconds
                self._stop_event.wait(timeout=self._config.poll_interval_seconds)
        finally:
            logger.info("collector shutting down, disconnecting from terminal")
            self._client.disconnect()

        logger.info("collector stopped cleanly")
        return 0

    def _attempt_connect(self, backoff: float) -> tuple[bool, float]:
        result = self._client.connect()
        if result.ok:
            logger.info("connected to MT5 terminal")
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
