"""Historical chart reconstruction phase — the first tests for mt5_client.py.

Every other method in this module talks to a live MT5 terminal (Windows
IPC) and has only ever been verified manually against one (see
PROJECT_STATUS.md). `get_candles` is different: its logic (mapping our
timeframe strings, filtering out the still-forming bar) is pure and worth
covering deterministically — `mt5.copy_rates_range`/`mt5.last_error` are
monkeypatched, no live terminal involved.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import mt5_client as mt5_client_module
from app.mt5_client import Mt5Client, _mt5_time_to_utc


class _FakeConfig:
    mt5_timeout_ms = 60_000
    mt5_terminal_path = None
    has_explicit_credentials = False
    mt5_broker_timezone = "EET"


def _rate(open_time: datetime, o: float, h: float, l: float, c: float, tick_volume: float = 10.0) -> dict:
    return {
        "time": int(open_time.timestamp()),
        "open": o, "high": h, "low": l, "close": c,
        "tick_volume": tick_volume,
    }


def test_get_candles_excludes_the_still_forming_bar(monkeypatch):
    now = datetime.now(tz=timezone.utc).replace(microsecond=0)
    closed_bar_open = now - timedelta(minutes=10)
    forming_bar_open = now - timedelta(minutes=2)  # opened 2 min ago, M5 bar not closed yet

    monkeypatch.setattr(
        mt5_client_module.mt5,
        "copy_rates_range",
        lambda symbol, timeframe, date_from, date_to: [
            _rate(closed_bar_open, 1.1, 1.11, 1.09, 1.105),
            _rate(forming_bar_open, 1.105, 1.106, 1.104, 1.1055),
        ],
    )

    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "M5", now - timedelta(hours=1), now)

    assert len(result) == 1
    assert result[0]["open_time"] == closed_bar_open.isoformat()
    assert result[0]["open"] == 1.1
    assert result[0]["high"] == 1.11
    assert result[0]["low"] == 1.09
    assert result[0]["close"] == 1.105
    assert result[0]["volume"] == 10.0


def test_get_candles_maps_every_closed_bar(monkeypatch):
    now = datetime.now(tz=timezone.utc).replace(microsecond=0)
    bars = [now - timedelta(hours=h) for h in (3, 2, 1)]
    monkeypatch.setattr(
        mt5_client_module.mt5,
        "copy_rates_range",
        lambda symbol, timeframe, date_from, date_to: [_rate(b, 1.0, 1.0, 1.0, 1.0) for b in bars],
    )

    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "H1", now - timedelta(hours=4), now)
    assert len(result) == 3
    assert [r["open_time"] for r in result] == [b.isoformat() for b in bars]


def test_get_candles_returns_empty_list_when_mt5_returns_none(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "copy_rates_range", lambda *a, **k: None)
    monkeypatch.setattr(mt5_client_module.mt5, "last_error", lambda: (1, "RES_S_OK"))

    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "M15", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []


def test_get_candles_rejects_an_unsupported_timeframe():
    client = Mt5Client(_FakeConfig())
    with pytest.raises(ValueError, match="Unsupported timeframe"):
        client.get_candles("EURUSD", "W2", datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))


@pytest.mark.parametrize("timeframe", ["M30", "H4", "D1"])
def test_get_candles_accepts_the_technical_analysis_timeframes(monkeypatch, timeframe):
    # Technical-analysis phase (support/resistance, Ichimoku, Fibonacci) —
    # these three were added alongside the original M5/M15/H1; confirms each
    # maps to a real MT5 TIMEFRAME_* constant rather than raising.
    monkeypatch.setattr(mt5_client_module.mt5, "copy_rates_range", lambda *a, **k: [])
    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", timeframe, datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []


@pytest.mark.parametrize("timeframe", ["W1", "MN1"])
def test_get_candles_accepts_the_weekly_monthly_timeframes(monkeypatch, timeframe):
    # Ichimoku breakout alerts on W1/MN1 — confirms each maps to a real MT5
    # TIMEFRAME_* constant (TIMEFRAME_W1/TIMEFRAME_MN1) rather than raising.
    monkeypatch.setattr(mt5_client_module.mt5, "copy_rates_range", lambda *a, **k: [])
    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", timeframe, datetime.now(tz=timezone.utc), datetime.now(tz=timezone.utc))
    assert result == []


def test_mt5_time_to_utc_returns_none_for_none():
    assert _mt5_time_to_utc(None, "EET") is None


def test_mt5_time_to_utc_corrects_the_real_live_discrepancy_found_this_session():
    # The exact real epoch a live open position reported (raw.time), which
    # naively decoded as UTC read 2026-09-09T01:16:54 — 2h44m ahead of the
    # real UTC time at that moment. Re-interpreting those wall-clock digits
    # as EEST (summer — Sept 9 is within EU DST) and converting properly
    # lands on 2026-09-08T22:16:54Z, within a plausible ~15 minutes of the
    # real UTC time observed live — the fix this test guards against regressing.
    assert _mt5_time_to_utc(1788916614, "EET") == "2026-09-08T22:16:54+00:00"


def test_mt5_time_to_utc_uses_winter_offset_across_a_dst_boundary():
    # Proves this is genuinely DST-aware (EET=+2 winter, EEST=+3 summer), not
    # a hardcoded fixed offset — January is outside EU summer time.
    winter_epoch = int(datetime(2026, 1, 15, 10, 0, 0, tzinfo=timezone.utc).timestamp())
    assert _mt5_time_to_utc(winter_epoch, "EET") == "2026-01-15T08:00:00+00:00"


def test_mt5_time_to_utc_uses_summer_offset_across_a_dst_boundary():
    summer_epoch = int(datetime(2026, 7, 15, 10, 0, 0, tzinfo=timezone.utc).timestamp())
    assert _mt5_time_to_utc(summer_epoch, "EET") == "2026-07-15T07:00:00+00:00"


def test_get_candles_handles_missing_tick_volume(monkeypatch):
    now = datetime.now(tz=timezone.utc).replace(microsecond=0)
    bar_open = now - timedelta(hours=2)
    monkeypatch.setattr(
        mt5_client_module.mt5,
        "copy_rates_range",
        lambda *a, **k: [_rate(bar_open, 1.0, 1.0, 1.0, 1.0, tick_volume=None)],
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_candles("EURUSD", "H1", now - timedelta(hours=3), now)
    assert result[0]["volume"] is None


class _FakeSymbolInfo:
    def __init__(self, **kwargs):
        self._d = kwargs

    def _asdict(self):
        return self._d


def test_get_symbol_info_maps_broker_fields_for_gold(monkeypatch):
    monkeypatch.setattr(
        mt5_client_module.mt5,
        "symbol_info",
        lambda symbol: _FakeSymbolInfo(
            volume_min=0.01, volume_max=50.0, volume_step=0.01,
            digits=2, point=0.01, trade_contract_size=100.0, currency_profit="USD",
        ),
    )
    client = Mt5Client(_FakeConfig())
    result = client.get_symbol_info("XAUUSD")
    assert result == {
        "symbol": "XAUUSD",
        "volume_min": 0.01,
        "volume_max": 50.0,
        "volume_step": 0.01,
        "digits": 2,
        "point": 0.01,
        "contract_size": 100.0,
        "profit_currency": "USD",
    }


def test_get_symbol_info_returns_none_when_mt5_does_not_know_the_symbol(monkeypatch):
    monkeypatch.setattr(mt5_client_module.mt5, "symbol_info", lambda symbol: None)
    monkeypatch.setattr(mt5_client_module.mt5, "last_error", lambda: (4301, "unknown symbol"))
    client = Mt5Client(_FakeConfig())
    assert client.get_symbol_info("NOT_A_REAL_SYMBOL") is None
