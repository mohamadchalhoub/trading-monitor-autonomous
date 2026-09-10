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
