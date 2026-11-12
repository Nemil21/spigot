// W13 terms `/c/:site/terms` (features/16 §Catalog page: "contract terms for factual data; no
// resale; attribution optional"; SP-033). The URL every 402 body carries as `terms` and every
// dataset schema as `license`.
import type { CatalogPageLinks } from './catalog.html.js';
import { clip, html, page } from './layout.js';

export function renderTermsPage(site: { name: string }, links: CatalogPageLinks): string {
  const name = clip(site.name);
  const body = html`<h1>Data terms: ${name}</h1>
    <p class="sub">
      These terms apply to data bought from ${name} through Spigot (the
      <a href="${links.catalogUrl}">catalog</a>, the <code>/v1</code> API and the MCP server).
    </p>
    <h2>1. What you get</h2>
    <p>
      Factual records extracted from ${name}'s public pages and sold by the site owner through
      Spigot. These terms are a contract between you and the seller; they do not claim copyright in
      facts.
    </p>
    <h2>2. Paying</h2>
    <p>
      Calls are paid from a prepaid balance you top up with PayPal. Each call is charged per record
      returned, at the price shown in the catalog and the call's quote, never above your
      <code>max_price_micros</code>. Free calls (catalog, schema, quote) are never charged. A call
      that fails is not charged, and retrying with the same <code>Idempotency-Key</code> is not
      charged twice.
    </p>
    <h2>3. What you may do</h2>
    <ul>
      <li>Use the records in your own products, analysis, agents and models.</li>
      <li>Show individual records, or facts derived from them, to your own users.</li>
    </ul>
    <h2>4. What you may not do</h2>
    <ul>
      <li>
        <strong>No resale.</strong> Don't sell, license or publish the records, in bulk or as a
        dataset, to third parties.
      </li>
      <li>Don't use the records to contact people listed in them for unsolicited marketing.</li>
      <li>Don't share your API key or route other parties' calls through it.</li>
    </ul>
    <h2>5. Attribution</h2>
    <p>Optional. If you credit the source, "Data from ${name} via Spigot" is enough.</p>
    <h2>6. No warranty</h2>
    <p>
      Records are provided as extracted from the site at crawl time, with freshness shown in the
      catalog. Neither Spigot nor the site owner guarantees accuracy or completeness.
    </p>
    <footer><a href="${links.catalogUrl}">Back to the ${name} catalog</a></footer>`;
  return page({ title: `Data terms: ${name}`, body, home: links.home });
}
