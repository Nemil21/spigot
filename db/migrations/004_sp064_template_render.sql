-- SP-064: Playwright render for JS-heavy templates (features/03 §Logic 9).
-- `html` (default): the crawler stores the fetched HTML as the snapshot. `browser`: the template's
-- sample pages had little text and a lot of `<script>`, so its pages are rendered through headless
-- Chromium (apps/api/src/crawl/render.ts) and the snapshot is the rendered DOM. Only set while
-- `CRAWL_RENDER=browser`; the demo site is server-rendered and stays `html`.
-- `render_since`: when the template switched to `browser`. A page fetched (status 200) at or after
-- it holds a rendered snapshot, so re-running the switch only renders the pages still missing one.
ALTER TABLE templates
  ADD COLUMN render text NOT NULL DEFAULT 'html' CHECK (render IN ('html', 'browser')),
  ADD COLUMN render_since timestamptz,
  ADD CONSTRAINT templates_render_since CHECK ((render = 'browser') = (render_since IS NOT NULL));
