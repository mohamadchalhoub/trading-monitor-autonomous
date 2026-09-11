"""Pure translation from mt5_client's internal dict shape to the wire
format the backend's collector-ingress DTOs expect. No MT5 dependency —
testable with plain dicts, same as formatting.py.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


# MetaTrader5's own ACCOUNT_TRADE_MODE_* enum, hardcoded rather than
# imported — this module is deliberately MT5-independent (see the module
# docstring), and this mapping is a documented fact about MT5's own stable
# wire format, not something that needs a live import to know. Autonomous
# demo trading (v2) — the single most safety-critical field this collector
# pushes (AUTONOMOUS_DEMO_TRADING_PLAN.md §1).
_TRADE_MODE_LABELS = {0: "REAL", 1: "DEMO", 2: "CONTEST"}


def _trade_mode_label(trade_mode: int | None) -> str | None:
    if trade_mode is None:
        return None
    return _TRADE_MODE_LABELS.get(trade_mode)


def build_snapshot_payload(
    account_id: str,
    account: dict[str, Any] | None,
    positions: list[dict[str, Any]],
    mt5_connected: bool | None,
    last_error: str | None,
    collector_version: str,
    live_tick: dict[str, Any] | None = None,
) -> dict[str, Any]:
    account = account or {}
    payload = {
        "accountId": account_id,
        "capturedAt": datetime.now(tz=timezone.utc).isoformat(),
        "balance": account.get("balance", 0),
        "equity": account.get("equity", 0),
        "margin": account.get("margin", 0),
        "freeMargin": account.get("margin_free", 0),
        "marginLevel": account.get("margin_level"),
        "profit": account.get("profit", 0),
        "tradeMode": _trade_mode_label(account.get("trade_mode")),
        "terminal": {
            "connected": bool(mt5_connected),
            **({"lastError": last_error} if last_error else {}),
        },
        "collectorVersion": collector_version,
        "positions": [_position_payload(p) for p in positions],
    }
    # Global market data (not account-scoped) piggybacked onto this same,
    # already-frequent (10s) push rather than a new endpoint/poll loop —
    # the backend stores it keyed by symbol alone, same pattern
    # historical_candles already uses for shared market data.
    if live_tick is not None and live_tick.get("bid") is not None and live_tick.get("ask") is not None:
        payload["liveTick"] = {
            "symbol": live_tick["symbol"],
            "bid": live_tick["bid"],
            "ask": live_tick["ask"],
            "tickAt": live_tick["time"],
        }
    return payload


def _position_payload(p: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "externalPositionId": str(p["ticket"]),
        "symbol": p["symbol"],
        "side": p["side"],
        "volume": p["volume"],
        "openPrice": p["price_open"],
        "currentPrice": p.get("price_current"),
        "profit": p.get("profit", 0),
        "swap": p.get("swap", 0),
        "openedAt": p["opened_at"],
        "raw": p.get("raw"),
    }
    if p.get("sl"):
        payload["stopLoss"] = p["sl"]
    if p.get("tp"):
        payload["takeProfit"] = p["tp"]
    return payload


def build_trades_payload(account_id: str, deals: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "accountId": account_id,
        "deals": [_deal_payload(d) for d in deals],
    }


def _deal_payload(d: dict[str, Any]) -> dict[str, Any]:
    return {
        "externalTradeId": str(d["ticket"]),
        "positionId": str(d["position_id"]) if d.get("position_id") else None,
        "orderId": str(d["order"]) if d.get("order") else None,
        "symbol": d["symbol"],
        "side": d["deal_type"],
        "dealEntry": d["entry"],
        "volume": d["volume"],
        "price": d["price"],
        "commission": d.get("commission", 0),
        "swap": d.get("swap", 0),
        "profit": d.get("profit", 0),
        "executedAt": d["closed_at"],
        "comment": d.get("comment"),
        "raw": d.get("raw"),
    }


# Historical chart reconstruction phase — no account_id (candles are
# symbol/timeframe data, see api_client.py's post_candles).
def build_candles_payload(symbol: str, timeframe: str, candles: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "candles": [
            {
                "openTime": c["open_time"],
                "open": c["open"],
                "high": c["high"],
                "low": c["low"],
                "close": c["close"],
                **({"volume": c["volume"]} if c.get("volume") is not None else {}),
            }
            for c in candles
        ],
    }
