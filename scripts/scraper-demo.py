#!/usr/bin/env python3
"""Video beat 1:15 (features/12): a plain scraper hits Bluebonnet Rentals and gets a 402.

    python scripts/scraper-demo.py http://localhost:4100            # first 3 listings in the sitemap
    python scripts/scraper-demo.py http://localhost:4100 /listings/a /listings/b

Default `requests` User-Agent on purpose: no browser UA variant (features/12 "Honest limits").
Needs `pip install requests` and the demo site running with spigot-gate on.
"""
import re
import sys

import requests

site = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:4100"
paths = sys.argv[2:5] or re.findall(r"<loc>[^<]*?(/listings/[^<]+)</loc>", requests.get(f"{site}/sitemap.xml", timeout=10).text)[:3]

missed = 0
for path in paths:
    r = requests.get(site + path, timeout=10)
    print(f"GET {path}  ({r.request.headers['User-Agent']})")
    if r.status_code != 402:
        print(f"  {r.status_code} {r.reason}: expected 402. Is the gate on (SPIGOT_API_BASE, SPIGOT_GATE_KEY) and the dataset live?\n")
        missed += 1
        continue
    body = r.json()
    print(f"  402 Payment Required  {body['error']['message']}")
    for ds in body["datasets"][:1]:
        # micros per record = dollars per 1,000 x 1,000; same "$1.50" / "$1.555" as the gate's D04 page.
        price = f"{ds['perRecordMicros'] / 1000:,.3f}".removesuffix("0")
        print(f"  Price  ${price} per 1,000 {ds['slug']}, paid from a {body['pay']['provider']}-funded balance")
        print(f"  API    {ds['endpoint']}")
    print(f"  MCP    {body['pay']['mcp']}\n")
sys.exit(1 if missed or not paths else 0)
