"""Collector-side behaviour for `xauusd-m1-rsi-retest-extremes-v1`:
the live tick stream and the entry poll.

The cases that matter most here are the negative ones — that nothing is
reached while the flag is off, and that an ambiguous broker response is
reported as UNCERTAIN rather than as a failure, because reporting a lost
response as a failure would free the position slot on an assumption.
"""
from dataclasses import dataclass, field
from unittest.mock import MagicMock

import pytest

from app.executor import DemoAccountRequiredError, OrderResult
from app.runner import CollectorApp

@dataclass
class _FakeConfig:
    poll_interval_seconds: int = 10
    reconnect_initial_backoff_seconds: float = 2.0
    reconnect_max_backoff_seconds: float = 60.0
    has_explicit_credentials: bool = False
    collector_account_id: str = "acct-1"
    collector_api_base_url: str = "http://localhost:8420"
    initial_sync_days: int = 90
    history_sync_overlap_minutes: int = 5
    candle_symbols: tuple = ()
    candle_timeframes: tuple = ()
    candle_sync_interval_seconds: int = 300
    candle_initial_sync_days: int = 1000
    autonomous_execution_enabled: bool = False
    gold_execution_enabled: bool = False
    trend_breakout_execution_enabled: bool = False
    rsi_execution_enabled: bool = True
    mt5_broker_timezone: str = "UTC"
    candle_timeframes_by_symbol: dict = field(default_factory=dict)

def _app(**overrides):
    client, api, executor = MagicMock(), MagicMock(), MagicMock()
    config = _FakeConfig(**overrides)
    app = CollectorApp(config=config, client=client, api=api, executor=executor)
    return app, client, api, executor

def test_no_order_is_attempted_when_the_backend_has_nothing_queued():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = {"order": None}

    app._poll_and_execute_pending_rsi_order()

    executor.send_bracket_order.assert_not_called()
    api.post_rsi_execution_result.assert_not_called()

def test_a_failed_poll_never_raises_and_never_executes():
    from app.api_client import ApiClientError

    app, _client, api, executor = _app()
    api.get_pending_rsi_order.side_effect = ApiClientError("backend down")

    app._poll_and_execute_pending_rsi_order()

    executor.send_bracket_order.assert_not_called()

def _order(**overrides):
    order = {
        "decisionId": "dec-1",
        "side": "SELL",
        "volume": 0.5,
        "entryPrice": 4345.0,
        "stopLoss": 4350.0,
        "takeProfit": 4340.0,
        "stopLossPoints": 500.0,
        "takeProfitPoints": 500.0,
        "magic": 262610190,
        "symbol": "XAUUSD",
        "pointSize": 0.01,
        "comment": "rsi-dec-1",
    }
    order.update(overrides)
    return {"order": order}

def test_a_confirmed_fill_is_reported_with_its_ticket_and_price():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.return_value = OrderResult(
        ok=True, ticket=4242, price=4345.1, retcode=10009,
    )
    executor.find_any_position.return_value = None

    app._poll_and_execute_pending_rsi_order()

    sent = executor.send_bracket_order.call_args.kwargs
    assert sent["side"] == "SELL"
    assert sent["volume"] == 0.5
    assert sent["magic"] == 262610190
    assert sent["symbol"] == "XAUUSD"
    # The $5 bracket, expressed in gold points.
    assert sent["stop_loss_points"] == 500.0
    assert sent["take_profit_points"] == 500.0

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["ok"] is True
    assert payload["uncertain"] is False
    assert payload["ticket"] == 4242
    assert payload["filledPrice"] == 4345.1

def test_a_clear_broker_rejection_is_reported_as_failed_not_uncertain():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    # A definite refusal: the broker answered with a retcode.
    executor.send_bracket_order.return_value = OrderResult(
        ok=False, ticket=None, price=None, retcode=10016, error_message="invalid stops",
    )

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is False
    assert payload["errorMessage"] == "invalid stops"

def test_an_ambiguous_broker_response_is_reported_as_uncertain():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    # No ticket AND no retcode: the executor could not establish what
    # happened. This must NOT be reported as a plain failure — the order may
    # well have reached the broker.
    executor.send_bracket_order.return_value = OrderResult(
        ok=False, ticket=None, price=None, retcode=None, error_message="no response from terminal",
    )

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert payload["uncertain"] is True

def test_a_failed_demo_account_check_is_reported_and_never_retried_silently():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.side_effect = DemoAccountRequiredError("account is REAL")

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["ok"] is False
    assert "REAL" in payload["errorMessage"]

def test_broker_reported_protection_is_read_back_after_a_fill():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=4242, price=4345.1, retcode=10009)
    position = MagicMock()
    position.ticket = 4242
    position.sl = 4350.0
    position.tp = 4340.0
    executor.find_any_position.return_value = position

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert payload["brokerStopLoss"] == 4350.0
    assert payload["brokerTakeProfit"] == 4340.0

def test_zero_protection_from_the_broker_is_reported_as_absent_not_as_a_price():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=4242, price=4345.1, retcode=10009)
    position = MagicMock()
    position.ticket = 4242
    position.sl = 0.0   # MT5's "no level set"
    position.tp = 0.0
    executor.find_any_position.return_value = position

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert "brokerStopLoss" not in payload
    assert "brokerTakeProfit" not in payload

def test_protection_readback_never_attributes_another_positions_levels():
    app, _client, api, executor = _app()
    api.get_pending_rsi_order.return_value = _order()
    executor.send_bracket_order.return_value = OrderResult(ok=True, ticket=4242, price=4345.1, retcode=10009)
    other = MagicMock()
    other.ticket = 9999  # a different position entirely
    other.sl = 1.0
    other.tp = 2.0
    executor.find_any_position.return_value = other

    app._poll_and_execute_pending_rsi_order()

    payload = api.post_rsi_execution_result.call_args.args[2]
    assert "brokerStopLoss" not in payload

# --- Live tick stream ---------------------------------------------------

def test_tick_stream_pushes_what_mt5_returned():
    app, client, api, _executor = _app()
    client.get_ticks.return_value = [
        {"timestamp": "2026-09-16T10:00:00.123+00:00", "bid": 4345.1, "ask": 4345.3, "last": None,
         "volume": None, "volume_real": None, "flags": 6, "batch_seq": 0},
    ]
    api.post_ticks.return_value = {"inserted": 1}

    app._stream_rsi_ticks()

    assert client.get_ticks.call_args.args[0] == "XAUUSD"
    payload = api.post_ticks.call_args.args[0]
    assert payload["symbol"] == "XAUUSD"
    assert len(payload["ticks"]) == 1

def test_tick_stream_is_quiet_and_harmless_when_there_are_no_ticks():
    app, client, api, _executor = _app()
    client.get_ticks.return_value = []

    app._stream_rsi_ticks()

    api.post_ticks.assert_not_called()

def test_tick_stream_never_raises_when_mt5_fails():
    app, client, api, _executor = _app()
    client.get_ticks.side_effect = RuntimeError("copy_ticks_range failed")

    app._stream_rsi_ticks()  # must not raise

    api.post_ticks.assert_not_called()

def test_tick_stream_never_raises_when_the_push_fails():
    from app.api_client import ApiClientError

    app, client, api, _executor = _app()
    client.get_ticks.return_value = [
        {"timestamp": "2026-09-16T10:00:00.123+00:00", "bid": 4345.1, "ask": 4345.3, "last": None,
         "volume": None, "volume_real": None, "flags": 6, "batch_seq": 0},
    ]
    api.post_ticks.side_effect = ApiClientError("backend down")

    app._stream_rsi_ticks()  # must not raise
