"""HTTP client for the backend's /collector/* endpoints.

Every call is a single attempt — no internal retry loop. The runner's own
poll cycle is the retry mechanism: a failed push this cycle is superseded
by a fresh, idempotent push next cycle, so a second retry layer here would
just add complexity without adding safety.
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from app.config import Config

logger = logging.getLogger("collector.api_client")


class ApiClientError(Exception):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class ApiClient:
    def __init__(self, config: Config) -> None:
        self._base_url = config.collector_api_base_url.rstrip("/")
        self._timeout = config.collector_api_timeout_seconds
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {config.collector_api_key}",
            "Content-Type": "application/json",
        })

    def post_snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/snapshot", payload)

    def post_trades(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/trades", payload)

    def get_cursor(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/cursor/{account_id}")

    def get_heartbeat(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/heartbeat/{account_id}")

    # Historical chart reconstruction phase — candles carry no account_id
    # (backend's HistoricalCandle model: symbol/timeframe data, shared
    # across every account/collector).
    def post_candles(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/candles", payload)

    def get_latest_candle_time(self, symbol: str, timeframe: str) -> dict[str, Any]:
        return self._get(f"/collector/candles/latest?symbol={symbol}&timeframe={timeframe}")

    # Gold historical-data-collection project — ticks carry no account_id,
    # same "shared market data" posture as candles above.
    def post_ticks(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/ticks", payload)

    def get_ticks_coverage(self, symbol: str) -> dict[str, Any]:
        return self._get(f"/collector/ticks/coverage?symbol={symbol}")

    # The backfill-intervals ledger — upsert is keyed server-side on
    # source+symbol+dataType+timeframe+rangeStart+rangeEnd (this client
    # sends whichever of those fields the caller supplies; it never
    # computes or guesses the key itself).
    def upsert_backfill_interval(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/backfill-intervals", payload)

    def get_backfill_intervals(
        self,
        symbol: str,
        data_type: str,
        timeframe: str | None = None,
        statuses: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        query = f"symbol={symbol}&dataType={data_type}"
        if timeframe is not None:
            query += f"&timeframe={timeframe}"
        if statuses:
            query += f"&status={','.join(statuses)}"
        # _get's own return type is whatever the endpoint actually returns
        # (a dict for most routes, an array here) — see its own body.
        return self._get(f"/collector/backfill-intervals?{query}")  # type: ignore[return-value]

    def get_storage_health(self) -> dict[str, Any]:
        return self._get("/collector/storage-health")

    # trend-breakout strategy (v3) — EXISTING route; the DTO now also
    # accepts the new, fully-optional instrument-verification fields (see
    # api_mapper.py's build_symbol_metadata_payload) but this wrapper's own
    # shape (a single-attempt POST, same as every other push here) is
    # unchanged.
    def post_symbol_metadata(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/collector/symbol-metadata", payload)

    # Autonomous demo trading (v2), Phase 6 — the ONE reverse-direction pair
    # in this client: every other method here pushes data the collector
    # already has; these two are the collector asking the backend "is there
    # anything approved for me to execute" and then reporting back what
    # happened. Still the collector acting as an HTTP CLIENT of the backend
    # (a GET/POST it initiates on its own poll cycle) — the backend never
    # calls out to the collector.
    def get_pending_order(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/autonomous/pending-order")

    def post_execution_result(self, account_id: str, decision_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/autonomous/pending-order/{decision_id}/result", result)

    # Gold (XAUUSD) execution — its OWN route, deliberately separate from
    # the EURUSD pair above (backend's GoldExecutionController), never the
    # same URL with a symbol parameter, so the two strategies' wire
    # contracts can never be confused at the HTTP layer either.
    def get_pending_gold_order(self, account_id: str) -> dict[str, Any]:
        return self._get(f"/collector/{account_id}/gold-execution/pending-order")

    def post_gold_execution_result(self, account_id: str, decision_id: str, result: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/collector/{account_id}/gold-execution/pending-order/{decision_id}/result", result)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            resp = self._session.post(url, json=payload, timeout=self._timeout)
        except requests.RequestException as exc:
            raise ApiClientError(f"POST {path} failed: {exc}") from None

        if resp.status_code >= 400:
            raise ApiClientError(
                f"POST {path} returned {resp.status_code}: {_safe_body(resp)}",
                status_code=resp.status_code,
            )
        return resp.json()

    def _get(self, path: str) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            resp = self._session.get(url, timeout=self._timeout)
        except requests.RequestException as exc:
            raise ApiClientError(f"GET {path} failed: {exc}") from None

        if resp.status_code >= 400:
            raise ApiClientError(
                f"GET {path} returned {resp.status_code}: {_safe_body(resp)}",
                status_code=resp.status_code,
            )
        return resp.json()


def _safe_body(resp: requests.Response) -> str:
    # Never let a response body containing an echoed Authorization header
    # or similar reach a log line untruncated.
    text = resp.text[:500]
    return text
