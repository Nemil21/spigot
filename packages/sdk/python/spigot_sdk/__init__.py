"""Client for Spigot's buyer ``/v1`` API (``openapi.yaml``). Standard library only.

    spigot = SpigotClient(api_key=os.environ["SPIGOT_KEY"])
    page = spigot.records.search("bluebonnet", "listings", {"bedrooms[gte]": 3})

Responses are the API's JSON as dicts (camelCase keys, money in integer micros of USD). Paid calls
add ``callId`` (for claims) and ``replay`` (a stored response replayed for the same idempotency
key). Non-2xx responses raise ``SpigotError`` with the API's error ``code``; a 402 carries
``top_up_url``.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping, Optional

__all__ = ["SpigotClient", "SpigotError", "DEFAULT_BASE_URL"]

DEFAULT_BASE_URL = "https://spigot.onrender.com"

Json = Dict[str, Any]


class SpigotError(Exception):
    """A non-2xx response from the API."""

    def __init__(self, status: int, body: Json, headers: Mapping[str, str]):
        error = body.get("error") or {}
        super().__init__(error.get("message") or f"HTTP {status}")
        self.status = status
        self.body = body
        self.headers = headers
        self.code: str = error.get("code") or f"HTTP_{status}"
        self.details: Optional[Json] = error.get("details")
        self.top_up_url: Optional[str] = body.get("topUpUrl") or (body.get("pay") or {}).get("topUpUrl")


def _dataset_path(site: str, dataset: str) -> str:
    q = urllib.parse.quote
    return f"/v1/{q(site, safe='')}/datasets/{q(dataset, safe='')}"


def _query_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (list, tuple)):
        return ",".join(str(x) for x in v)
    return str(v)


class SpigotClient:
    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, timeout: float = 30.0):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self._api_key = api_key or None
        self._timeout = timeout
        self.catalog = _Catalog(self)
        self.datasets = _Datasets(self)
        self.records = _Records(self)
        self.changes = _Changes(self)
        self.balance = _Balance(self)
        self.topups = _Topups(self)
        self.claims = _Claims(self)

    def _request(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
    ) -> "tuple[Json, Mapping[str, str]]":
        url = self.base_url + path
        params = {k: _query_value(v) for k, v in (query or {}).items() if v is not None}
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json", "User-Agent": "spigot-sdk-python/0.1.0"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as res:
                return _parse(res.read(), res.status), res.headers
        except urllib.error.HTTPError as e:
            raise SpigotError(e.code, _parse(e.read(), e.code), e.headers) from None

    def _json(self, method: str, path: str, **kw: Any) -> Json:
        return self._request(method, path, **kw)[0]

    def _paid(self, path: str, query: Mapping[str, Any], max_price_micros: Optional[int], idempotency_key: Optional[str]) -> Json:
        body, headers = self._request(
            "GET", path, query={**query, "max_price_micros": max_price_micros}, idempotency_key=idempotency_key
        )
        body["callId"] = headers.get("Spigot-Call-Id")
        body["replay"] = headers.get("Spigot-Replay") == "true"
        return body


def _parse(raw: bytes, status: int) -> Json:
    text = raw.decode("utf-8", "replace")
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        return {"error": {"code": f"HTTP_{status}", "message": text[:500]}}


class _Catalog:
    def __init__(self, c: SpigotClient):
        self._c = c

    def list(self) -> Json:
        """What is for sale (free)."""
        return self._c._json("GET", "/v1/catalog")


class _Datasets:
    def __init__(self, c: SpigotClient):
        self._c = c

    def describe(self, site: str, dataset: str) -> Json:
        """Fields (and which filter ops each takes), pricing and freshness (free)."""
        return self._c._json("GET", _dataset_path(site, dataset))


class _Records:
    def __init__(self, c: SpigotClient):
        self._c = c

    def quote(self, site: str, dataset: str, filters: Optional[Mapping[str, Any]] = None, *, limit: Optional[int] = None,
              sort: Optional[str] = None, cursor: Optional[str] = None) -> Json:
        """Price a query without running it (free; needs a key)."""
        query = {**(filters or {}), "limit": limit, "sort": sort, "cursor": cursor}
        return self._c._json("GET", _dataset_path(site, dataset) + "/quote", query=query)

    def search(self, site: str, dataset: str, filters: Optional[Mapping[str, Any]] = None, *, limit: Optional[int] = None,
               sort: Optional[str] = None, cursor: Optional[str] = None, max_price_micros: Optional[int] = None,
               idempotency_key: Optional[str] = None) -> Json:
        """Search records; charges records x perRecordMicros (zero results cost nothing)."""
        query = {**(filters or {}), "limit": limit, "sort": sort, "cursor": cursor}
        return self._c._paid(_dataset_path(site, dataset) + "/records", query, max_price_micros, idempotency_key)

    def get(self, site: str, dataset: str, key: str, *, max_price_micros: Optional[int] = None,
            idempotency_key: Optional[str] = None) -> Json:
        """One record by key (charged as one record)."""
        path = _dataset_path(site, dataset) + "/records/" + urllib.parse.quote(key, safe="")
        return self._c._paid(path, {}, max_price_micros, idempotency_key)


class _Changes:
    def __init__(self, c: SpigotClient):
        self._c = c

    def list(self, site: str, dataset: str, *, since: Optional[str] = None, limit: Optional[int] = None,
             include_record: bool = False, max_price_micros: Optional[int] = None,
             idempotency_key: Optional[str] = None) -> Json:
        """The change feed; charges changes x perChangeMicros. ``since="0"`` is full history."""
        query = {"since": since, "limit": limit, "include": "record" if include_record else None}
        return self._c._paid(_dataset_path(site, dataset) + "/changes", query, max_price_micros, idempotency_key)


class _Balance:
    def __init__(self, c: SpigotClient):
        self._c = c

    def get(self) -> Json:
        return self._c._json("GET", "/v1/balance")


class _Topups:
    def __init__(self, c: SpigotClient):
        self._c = c

    def create(self, amount_cents: int, *, idempotency_key: Optional[str] = None) -> Json:
        """Start a PayPal top-up (500-50,000 cents); open ``approveUrl`` to approve."""
        return self._c._json("POST", "/v1/topups", body={"amountCents": amount_cents}, idempotency_key=idempotency_key)


class _Claims:
    def __init__(self, c: SpigotClient):
        self._c = c

    def create(self, call_id: str, record_key: str, reason: str, note: Optional[str] = None) -> Json:
        """Report a bad record from a paid call (``callId`` from that call's result)."""
        body: Json = {"callId": call_id, "recordKey": record_key, "reason": reason}
        if note is not None:
            body["note"] = note
        return self._c._json("POST", "/v1/claims", body=body)
