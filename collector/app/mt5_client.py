"""Thin, read-only wrapper around the MetaTrader5 package.

There is no function here, and there must never be one added, that can
place, modify, or close a trade: no order_send, no order_check, no
order_calc_*. That guarantee holds identically in both modes below, since
both ultimately expose the exact same real MetaTrader5 API surface — the
guarantee has always come from this file's own discipline about which
functions it calls, never from the transport lacking them.

Autonomous demo trading (v2), Phase 6: order placement now exists in this
project, but deliberately NOT here — it lives in `executor.py`, the only
other file that imports MetaTrader5 (or a bridge proxy to it) and the only
file anywhere in this project that calls order_send. This file's own
invariant above stays exactly as true as it always was; the small,
separately-reviewable set of functions capable of writing anything to a
live account is now `executor.py` in full, and nowhere else.

Two modes, chosen at runtime by MT5_BRIDGE_HOST:

- **Native (local Windows dev)** — MT5_BRIDGE_HOST unset. Imports the real
  MetaTrader5 package directly, talking to a real MT5 terminal on the same
  Windows machine via its own IPC. This is the original, only mode until
  the VPS deployment — still exactly how local development works.
- **Bridge (Linux production)** — MT5_BRIDGE_HOST set. The MetaTrader5
  PyPI package ships Windows-only wheels and cannot be installed on Linux
  at all, so there is nothing to `import` natively here. Instead this
  connects over RPyC (rpyc.classic.connect) to a separate `mt5-bridge`
  Docker service (the community `lprett/mt5linux` image: Wine + a real MT5
  terminal + a small Windows-Python RPyC server, `mt5server.exe`) running
  elsewhere in the same docker-compose stack. `conn.modules["MetaTrader5"]`
  is a transparent remote proxy to the REAL MetaTrader5 module running
  inside that container — every function/constant this file already uses
  (positions_get(), TIMEFRAME_M5, POSITION_TYPE_BUY, ...) works identically
  to the native import, so no method body below needs to know which mode
  is active.

The connection is resolved lazily, inside `connect()`, not at module import
time — this preserves runner.py's existing reconnect/backoff loop (a bridge
container that isn't ready yet is a retryable connect() failure, exactly
like a not-yet-running terminal is today, not a crash at process startup).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.config import CANDLE_DURATION_BY_TIMEFRAME, Config

logger = logging.getLogger("collector.mt5_client")

MT5_BRIDGE_HOST = os.environ.get("MT5_BRIDGE_HOST", "").strip()

if not MT5_BRIDGE_HOST:
    # Windows-only package; never installed/importable in the Linux bridge
    # deployment (no Linux wheel exists), hence this being conditional.
    import MetaTrader5 as mt5


@dataclass
class ConnectResult:
    ok: bool
    error_code: int | None = None
    error_message: str | None = None


class Mt5Client:
    """Owns the single MT5 terminal connection for this process."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._connected = False
        # Native mode: the module is already available at import time (see
        # top of file), so it's safe to set here directly — preserves the
        # existing behavior/tests that call get_candles() etc. without
        # calling connect() first. Bridge mode: genuinely can't be resolved
        # until connect() succeeds (that's the whole point of resolving it
        # lazily — a not-yet-ready bridge container must be a retryable
        # connect() failure, not a crash before the first connect attempt).
        self._mt5: Any = mt5 if not MT5_BRIDGE_HOST else None
        self._rpyc_conn: Any = None

    # -- connection lifecycle -------------------------------------------------

    def connect(self) -> ConnectResult:
        if MT5_BRIDGE_HOST:
            try:
                import rpyc  # only ever needed in bridge mode

                bridge_port = int(os.environ.get("MT5_BRIDGE_PORT", "18812"))
                self._rpyc_conn = rpyc.classic.connect(MT5_BRIDGE_HOST, bridge_port)
                self._mt5 = self._rpyc_conn.modules["MetaTrader5"]
            except Exception as exc:
                self._connected = False
                return ConnectResult(ok=False, error_code=None, error_message=f"mt5 bridge connection failed: {exc}")
        else:
            self._mt5 = mt5

        kwargs: dict[str, Any] = {"timeout": self._config.mt5_timeout_ms}
        if self._config.mt5_terminal_path:
            kwargs["path"] = self._config.mt5_terminal_path
        if self._config.has_explicit_credentials:
            kwargs["login"] = self._config.mt5_login
            kwargs["password"] = self._config.mt5_password
            kwargs["server"] = self._config.mt5_server

        ok = self._mt5.initialize(**kwargs)
        if not ok:
            code, message = self._mt5.last_error()
            self._connected = False
            return ConnectResult(ok=False, error_code=code, error_message=message)

        self._connected = True

        # Explicit, not left to a side effect of the candle-sync cycle (which
        # runs on its own, much slower interval) — without this, a fresh
        # connect() followed immediately by the first snapshot cycle's
        # get_live_tick() call could hit an unselected symbol before candle
        # sync has ever run, risking the exact stale-tick failure mode this
        # method exists to avoid. Best-effort: a symbol that fails to select
        # here still gets picked up once candle sync runs, so this never
        # blocks startup.
        for symbol in self._config.candle_symbols:
            self._mt5.symbol_select(symbol, True)

        return ConnectResult(ok=True)

    def disconnect(self) -> None:
        if self._connected and self._mt5 is not None:
            self._mt5.shutdown()
        if self._rpyc_conn is not None:
            self._rpyc_conn.close()
            self._rpyc_conn = None
        self._connected = False

    def is_connected(self) -> bool:
        """True only if we've successfully initialized AND the terminal
        itself currently reports an active broker connection."""
        if not self._connected:
            return False
        info = self._mt5.terminal_info()
        if info is None:
            return False
        return bool(info.connected)

    def last_error(self) -> tuple[int, str]:
        return self._mt5.last_error()

    def get_mt5_module(self) -> Any:
        """Returns the already-connected mt5 module/proxy handle (native
        import or RPyC bridge, whichever connect() resolved) — the ONLY
        reason this exists is so `executor.py`'s `Executor` can share this
        SAME session rather than opening a second one; nothing else should
        call this. Does not itself grant any new capability — `Executor` is
        still the only place that ever calls order_send with whatever
        handle it's given."""
        return self._mt5

    # -- read-only data access --------------------------------------------------

    def get_terminal_info(self) -> dict[str, Any] | None:
        info = self._mt5.terminal_info()
        return info._asdict() if info is not None else None

    def get_account_info(self) -> dict[str, Any] | None:
        info = self._mt5.account_info()
        if info is None:
            return None
        d = info._asdict()
        return {
            "login": d.get("login"),
            "server": d.get("server"),
            "currency": d.get("currency"),
            "balance": d.get("balance"),
            "equity": d.get("equity"),
            "margin": d.get("margin"),
            "margin_free": d.get("margin_free"),
            "margin_level": d.get("margin_level"),
            "profit": d.get("profit"),
            "leverage": d.get("leverage"),
            "trade_allowed": d.get("trade_allowed"),
            # Autonomous demo trading (v2) — promoted to a first-class field
            # alongside the others above (was previously only reachable via
            # "raw") because it's the input to this project's single most
            # safety-critical check (executor.py's verify_demo_account()):
            # MT5's ACCOUNT_TRADE_MODE_REAL/DEMO/CONTEST integer enum.
            "trade_mode": d.get("trade_mode"),
            "raw": d,
        }

    def get_live_tick(self, symbol: str) -> dict[str, Any] | None:
        """A genuine live bid/ask for `symbol`, called from this same
        long-lived, already-connected session — NOT a substitute for a
        separate one-off `mt5.initialize()` from a different process, which
        was verified live to return a stale cached tick instead of a fresh
        one (a real investigation this session: symbol_info_tick() can
        return the last-known tick if the calling session hasn't kept the
        symbol actively selected in Market Watch; this collector's own
        ongoing candle sync already does that for `symbol` continuously, so
        calling it from here is safe in a way a fresh ad-hoc script is not).
        Exists to close the gap between this system's coarsest live number
        (an M5 candle close, up to ~10 minutes stale by the time it's
        synced) and what a trader actually sees on their own terminal.
        """
        tick = self._mt5.symbol_info_tick(symbol)
        if tick is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("symbol_info_tick returned None", extra={"mt5_error": message, "symbol": symbol})
            return None
        d = tick._asdict()
        return {
            "symbol": symbol,
            "bid": d.get("bid"),
            "ask": d.get("ask"),
            # Same broker-local-mislabeled-as-UTC quantity deal/position
            # times are (see _mt5_time_to_utc's own docstring) — corrected
            # the same way for consistency, even though callers currently
            # only use bid/ask, not this field.
            "time": _mt5_time_to_utc(d.get("time"), self._config.mt5_broker_timezone),
        }

    def get_open_positions(self) -> list[dict[str, Any]]:
        positions = self._mt5.positions_get()
        if positions is None:
            code, message = self._mt5.last_error()
            if code != 1:  # 1 == RES_S_OK; None can also just mean "zero positions"
                logger.warning("positions_get returned None", extra={"mt5_error": message})
            return []

        result = []
        for p in positions:
            d = p._asdict()
            side = "BUY" if d.get("type") == self._mt5.POSITION_TYPE_BUY else (
                "SELL" if d.get("type") == self._mt5.POSITION_TYPE_SELL else f"UNKNOWN({d.get('type')})"
            )
            result.append({
                "ticket": d.get("ticket"),
                "symbol": d.get("symbol"),
                "side": side,
                "volume": d.get("volume"),
                "price_open": d.get("price_open"),
                "price_current": d.get("price_current"),
                "sl": d.get("sl"),
                "tp": d.get("tp"),
                "swap": d.get("swap"),
                "profit": d.get("profit"),
                "opened_at": _mt5_time_to_utc(d.get("time"), self._config.mt5_broker_timezone),
                "comment": d.get("comment"),
                "raw": d,
            })
        return result

    def get_recent_deals(self, days: int) -> list[dict[str, Any]]:
        """Trading deals only (BUY/SELL) from the last `days` days.

        Convenience wrapper over get_deals_since() for the console printout
        (Phase 1); the actual sync loop (Phase 2) calls get_deals_since()
        directly with a server-supplied cursor.
        """
        date_from = datetime.now(tz=timezone.utc) - timedelta(days=days)
        return self.get_deals_since(date_from)

    def get_deals_since(self, date_from: datetime) -> list[dict[str, Any]]:
        """Trading deals only (BUY/SELL) from `date_from` to now.

        Excludes balance/credit/commission/correction bookkeeping entries,
        which share the same history_deals_get() call but are not trades.
        Note: a single closed position produces at least two deals (entry
        and exit) — this is a raw listing, not yet paired into round-trip
        trades. Pairing is deferred to Phase 3 analytics, not solved here
        (see the Phase 1 MT5 verification notes).
        """
        date_to = datetime.now(tz=timezone.utc)

        # Unix timestamps, not datetime objects — verified live against a
        # Wine-hosted terminal (DEPLOYMENT_SINGLE_VPS.md): history_deals_get()
        # silently returns an empty result for a datetime-object range (both
        # tz-aware and naive) covering deals that demonstrably exist, while
        # the exact same window as epoch-second integers returns them
        # correctly. copy_rates_range() (get_candles() below) does NOT share
        # this bug and keeps taking datetime objects — this is specific to
        # history_deals_get()'s own argument handling under Wine, not a
        # blanket "MT5 + Wine can't take datetimes" issue.
        #
        # On top of that, history_deals_get() filters against each deal's
        # RAW epoch — broker-local wall-clock digits mislabeled as UTC, same
        # quantity _mt5_time_to_utc() below corrects for on the way out —
        # not true UTC. A precise real-UTC "now" upper bound silently
        # excludes any deal from roughly the last `mt5_broker_timezone` UTC
        # offset (e.g. ~3h for EEST), because that deal's raw timestamp
        # still looks like it's in the future relative to a true-UTC cutoff.
        # _utc_to_mt5_epoch() converts each bound the same "fake UTC" way
        # before comparing, verified live to actually return deals a plain
        # UTC epoch silently dropped.
        deals = self._mt5.history_deals_get(
            _utc_to_mt5_epoch(date_from, self._config.mt5_broker_timezone),
            _utc_to_mt5_epoch(date_to, self._config.mt5_broker_timezone),
        )
        if deals is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("history_deals_get returned None", extra={"mt5_error": message})
            return []

        result = []
        for deal in deals:
            d = deal._asdict()
            deal_type_raw = d.get("type")
            if deal_type_raw == self._mt5.DEAL_TYPE_BUY:
                deal_type = "BUY"
            elif deal_type_raw == self._mt5.DEAL_TYPE_SELL:
                deal_type = "SELL"
            else:
                continue  # balance/credit/commission/correction/etc — not a trade

            entry_raw = d.get("entry")
            entry_map = {
                self._mt5.DEAL_ENTRY_IN: "IN",
                self._mt5.DEAL_ENTRY_OUT: "OUT",
                self._mt5.DEAL_ENTRY_INOUT: "INOUT",
                self._mt5.DEAL_ENTRY_OUT_BY: "OUT_BY",
            }
            entry = entry_map.get(entry_raw, "IN")

            result.append({
                "ticket": d.get("ticket"),
                "position_id": d.get("position_id"),
                "order": d.get("order"),
                "symbol": d.get("symbol"),
                "deal_type": deal_type,
                "entry": entry,
                "volume": d.get("volume"),
                "price": d.get("price"),
                "commission": d.get("commission"),
                "swap": d.get("swap"),
                "profit": d.get("profit"),
                "closed_at": _mt5_time_to_utc(d.get("time"), self._config.mt5_broker_timezone),
                "comment": d.get("comment"),
                "raw": d,
            })
        return result

    def get_candles(self, symbol: str, timeframe: str, date_from: datetime, date_to: datetime) -> list[dict[str, Any]]:
        """Historical chart reconstruction phase — closed OHLC candles only.

        Uses `copy_rates_range`, which can include the CURRENTLY FORMING bar
        if `date_to` is now or later — that bar is deliberately excluded here
        (its high/low/close will keep changing until it closes), so a caller
        never has to know MT5's own semantics to avoid storing a bar that
        isn't done yet.
        """
        timeframe_by_name = self._timeframe_constants()
        mt5_timeframe = timeframe_by_name.get(timeframe)
        if mt5_timeframe is None:
            raise ValueError(f"Unsupported timeframe {timeframe!r} — must be one of {sorted(timeframe_by_name)}")

        rates = self._mt5.copy_rates_range(symbol, mt5_timeframe, date_from, date_to)
        if rates is None:
            code, message = self._mt5.last_error()
            if code != 1:
                logger.warning("copy_rates_range returned None", extra={
                    "symbol": symbol, "timeframe": timeframe, "mt5_error": message,
                })
            return []

        now = datetime.now(tz=timezone.utc)
        bar_duration = CANDLE_DURATION_BY_TIMEFRAME[timeframe]
        result = []
        for r in rates:
            open_time = datetime.fromtimestamp(int(r["time"]), tz=timezone.utc)
            if open_time + bar_duration > now:
                continue  # still forming — hasn't reached its own close time yet
            result.append({
                "open_time": open_time.isoformat(),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": float(r["tick_volume"]) if r["tick_volume"] is not None else None,
            })
        return result

    # Historical chart reconstruction phase — maps this project's own
    # timeframe strings (config.py's CANDLE_TIMEFRAMES, also the backend's
    # CandleTimeframe enum) to MetaTrader5's TIMEFRAME_* constants.
    # Deliberately not a 1:1 of every timeframe MT5 supports — see
    # config.py's _VALID_CANDLE_TIMEFRAMES comment for why the set stays
    # small. An instance method, not a module-level constant, because it
    # reads self._mt5 — only resolved once connect() has succeeded (native
    # module or bridge proxy, whichever is active).
    def _timeframe_constants(self) -> dict[str, int]:
        return {
            "M5": self._mt5.TIMEFRAME_M5,
            "M15": self._mt5.TIMEFRAME_M15,
            "H1": self._mt5.TIMEFRAME_H1,
            "M30": self._mt5.TIMEFRAME_M30,
            "H4": self._mt5.TIMEFRAME_H4,
            "D1": self._mt5.TIMEFRAME_D1,
            "W1": self._mt5.TIMEFRAME_W1,
            "MN1": self._mt5.TIMEFRAME_MN1,
        }


def _mt5_time_to_utc(epoch_seconds: int | None, broker_timezone: str) -> str | None:
    """Converts a position/deal `time` field to a true UTC ISO timestamp.

    MT5 reports these fields as an epoch integer computed from the broker/
    trade-server's own wall-clock components, not true UTC (unlike candle
    OHLC bar times, which genuinely are UTC — this function is deliberately
    only used for position/deal timestamps, never candles). Naively decoding
    the epoch as UTC (`datetime.fromtimestamp(epoch, tz=utc)`) reproduces
    those broker-local wall-clock digits, mislabeled as UTC. The fix:
    decode the epoch the same naive way to recover those wall-clock digits,
    then RE-interpret them as being in `broker_timezone` (resolving whichever
    of that zone's UTC offsets — e.g. EET's EET/EEST — actually applies on
    that date) and convert properly to true UTC.
    """
    if epoch_seconds is None:
        return None
    broker_wall_clock = datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).replace(tzinfo=None)
    broker_aware = broker_wall_clock.replace(tzinfo=ZoneInfo(broker_timezone))
    return broker_aware.astimezone(timezone.utc).isoformat()


def _utc_to_mt5_epoch(dt_utc: datetime, broker_timezone: str) -> int:
    """Inverse of `_mt5_time_to_utc()` — converts a true-UTC datetime into
    the "fake epoch" history_deals_get()'s date_from/date_to expect.

    Verified live (DEPLOYMENT_SINGLE_VPS.md): a precise real-UTC `datetime.now()`
    epoch as date_to silently excludes deals from roughly the last
    broker-UTC-offset hours, because the broker server compares against
    each deal's raw epoch — broker-local wall-clock digits mislabeled as
    UTC, not true UTC (same quantity `_mt5_time_to_utc()` decodes on the
    way out). This produces that same mislabeled quantity for a query
    bound: take the broker-local wall-clock digits for this instant, then
    encode THOSE digits as if they were UTC.
    """
    broker_local = dt_utc.astimezone(ZoneInfo(broker_timezone))
    naive_wall_clock = broker_local.replace(tzinfo=None)
    return int(naive_wall_clock.replace(tzinfo=timezone.utc).timestamp())
