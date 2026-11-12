import type { Listing } from './data/types.js';

export const IN_STOCK = 'https://schema.org/InStock';
export const SOLD_OUT = 'https://schema.org/SoldOut';

/**
 * schema.org Apartment + Offer for a listing page. Paths the extractor relies on:
 * `$.offers.price`, `$.offers.availability`, `$.numberOfRooms`, `$.floorSize.value`, `$.address.*`.
 * `available_from` and `pets_allowed` are deliberately absent (HTML only, features/01).
 *
 * The node is multi-typed `["Apartment", "Product"]`: schema.org only allows `offers` on
 * Product/Service/Event-like types, not on Apartment, so plain `Apartment` + `offers` fails
 * validation. Consumers should read `@type` as `string | string[]`.
 */
export function listingJsonLd(listing: Listing, url: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': ['Apartment', 'Product'],
    '@id': url,
    url,
    name: listing.title,
    description: listing.description,
    numberOfRooms: listing.bedrooms,
    numberOfBedrooms: listing.bedrooms,
    numberOfBathroomsTotal: listing.bathrooms,
    floorSize: { '@type': 'QuantitativeValue', value: listing.sqft, unitCode: 'FTK', unitText: 'sq ft' },
    address: {
      '@type': 'PostalAddress',
      streetAddress: listing.street_address,
      addressLocality: listing.city,
      addressRegion: listing.state,
      postalCode: listing.postal_code,
      addressCountry: 'US',
    },
    containedInPlace: { '@type': 'Place', name: listing.neighbourhood },
    offers: {
      '@type': 'Offer',
      price: listing.price_usd,
      priceCurrency: 'USD',
      availability: listing.status === 'leased' ? SOLD_OUT : IN_STOCK,
      url,
    },
  };
}

/** Serialise for a <script type="application/ld+json"> block; `<` is escaped so no `</script>` breakout. */
export function jsonLdScript(obj: unknown): string {
  return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}
