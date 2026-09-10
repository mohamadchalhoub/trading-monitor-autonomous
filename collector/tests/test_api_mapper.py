from app.api_mapper import build_candles_payload, build_snapshot_payload, build_trades_payload


def test_snapshot_payload_shape():
    payload = build_snapshot_payload(
        account_id="acct-1",
        account={"balance": 3000.0, "equity": 2990.0, "margin": 10.0,
                  "margin_free": 2980.0, "margin_level": 29900.0, "profit": -10.0},
        positions=[{
            "ticket": 555, "symbol": "XAUUSD", "side": "BUY", "volume": 0.5,
            "price_open": 2400.0, "price_current": 2410.0, "sl": 2380.0, "tp": 0.0,
            "profit": 50.0, "swap": -1.2, "opened_at": "2026-08-28T10:00:00+00:00",
            "raw": {"comment": "test"},
        }],
        mt5_connected=True,
        last_error=None,
        collector_version="0.2.0",
    )
    assert payload["accountId"] == "acct-1"
    assert payload["balance"] == 3000.0
    assert payload["terminal"] == {"connected": True}
    assert len(payload["positions"]) == 1

    pos = payload["positions"][0]
    assert pos["externalPositionId"] == "555"
    assert pos["openPrice"] == 2400.0
    assert pos["stopLoss"] == 2380.0
    assert "takeProfit" not in pos  # tp was 0.0 — "not set", must be omitted not sent as 0


def test_snapshot_payload_includes_last_error_when_present():
    payload = build_snapshot_payload(
        account_id="acct-1", account=None, positions=[],
        mt5_connected=False, last_error="IPC timeout", collector_version="0.2.0",
    )
    assert payload["terminal"] == {"connected": False, "lastError": "IPC timeout"}


def test_trades_payload_shape():
    payload = build_trades_payload("acct-1", [{
        "ticket": 999, "position_id": 500, "order": 501, "symbol": "EURUSD",
        "deal_type": "SELL", "entry": "OUT", "volume": 0.1, "price": 1.095,
        "commission": -0.5, "swap": 0.0, "profit": -12.5,
        "closed_at": "2026-08-28T11:00:00+00:00", "comment": "tp", "raw": {},
    }])
    assert payload["accountId"] == "acct-1"
    deal = payload["deals"][0]
    assert deal["externalTradeId"] == "999"
    assert deal["positionId"] == "500"
    assert deal["side"] == "SELL"
    assert deal["dealEntry"] == "OUT"


def test_candles_payload_shape():
    payload = build_candles_payload("EURUSD", "M5", [
        {"open_time": "2026-01-01T00:00:00+00:00", "open": 1.1, "high": 1.11, "low": 1.09, "close": 1.105, "volume": 120.0},
    ])
    assert payload == {
        "symbol": "EURUSD",
        "timeframe": "M5",
        "candles": [
            {"openTime": "2026-01-01T00:00:00+00:00", "open": 1.1, "high": 1.11, "low": 1.09, "close": 1.105, "volume": 120.0},
        ],
    }


def test_candles_payload_omits_volume_when_none():
    payload = build_candles_payload("EURUSD", "H1", [
        {"open_time": "2026-01-01T00:00:00+00:00", "open": 1.1, "high": 1.11, "low": 1.09, "close": 1.105, "volume": None},
    ])
    assert "volume" not in payload["candles"][0]


def test_candles_payload_handles_empty_list():
    payload = build_candles_payload("EURUSD", "M15", [])
    assert payload["candles"] == []
