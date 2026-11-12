"""Drives the Python client through each scenario against the `/v1` stub in
apps/api/src/sdk/sdk-readme.test.ts, which runs this file and asserts on its output (one JSON
object) and on the requests the stub received. Needs SPIGOT_URL, SPIGOT_KEY and SPIGOT_HTML_KEY.
"""

import json
import os

from spigot_sdk import SpigotClient, SpigotError

URL = os.environ["SPIGOT_URL"]
client = SpigotClient(api_key=os.environ["SPIGOT_KEY"], base_url=URL)


def error(call):
    """What `call` raised, as plain data (or why it didn't raise a SpigotError)."""
    try:
        call()
    except SpigotError as e:
        return {"status": e.status, "code": e.code, "message": str(e), "top_up_url": e.top_up_url}
    except Exception as e:  # noqa: BLE001 - report the wrong exception type to the test
        return {"unexpected": type(e).__name__, "message": str(e)}
    return {"unexpected": "no exception"}


def paid(page):
    return {"callId": page["callId"], "replay": page["replay"], "charged": page["charged"]}


out = {
    "search": paid(
        client.records.search(
            "bluebonnet",
            "listings",
            {"city[in]": ["Austin", "Waco"]},
            limit=2,
            max_price_micros=100000,
            idempotency_key="once-1",
        )
    ),
    "replay": paid(client.records.search("bluebonnet", "listings", idempotency_key="retry-1")),
    "short402": error(lambda: client.records.search("bluebonnet", "listings", max_price_micros=1)),
    "keyless402": error(lambda: SpigotClient(base_url=URL).records.search("bluebonnet", "listings")),
    "nonJson": error(lambda: SpigotClient(api_key=os.environ["SPIGOT_HTML_KEY"], base_url=URL).balance.get()),
    "notFound": error(lambda: client.records.get("blue bonnet", "list/ings", "a/b?c")),
    "changes": client.changes.list("bluebonnet", "listings", since="0", include_record=True)["next"],
    "claim": client.claims.create("6f1c7a52-8d1e-4f39-9a0e-2b7d6c1e9f00", "l-3", "STALE", note="py")["status"],
    "topup": client.topups.create(1000, idempotency_key="top-1")["approveUrl"],
}
print(json.dumps(out))
