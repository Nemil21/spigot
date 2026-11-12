import { SpigotClient } from '@spigot/sdk';
const { SPIGOT_KEY, SPIGOT_URL } = process.env;
const spigot = new SpigotClient({ apiKey: SPIGOT_KEY, baseUrl: SPIGOT_URL });
const filters = { 'bedrooms[gte]': 3, 'price_usd[lt]': 2000 };
const { records, charged } = await spigot.records.search('bluebonnet', 'listings', filters);
console.log(`${records.length} listings, charged $${(charged.priceMicros / 1e6).toFixed(4)}`);
