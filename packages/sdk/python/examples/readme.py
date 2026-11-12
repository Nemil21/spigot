import os
from spigot_sdk import SpigotClient
spigot = SpigotClient(api_key=os.environ.get("SPIGOT_KEY"), base_url=os.environ.get("SPIGOT_URL"))
page = spigot.records.search("bluebonnet", "listings", {"bedrooms[gte]": 3, "price_usd[lt]": 2000})
print(f"{len(page['records'])} listings, charged ${page['charged']['priceMicros'] / 1e6:.4f}")
