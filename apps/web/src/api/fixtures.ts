/**
 * Fixture mode (`VITE_FIXTURES=1`, SP-024a). A `GET /api/sites/s1/bots?days=7` resolves from the
 * first file that exists, query string ignored:
 *
 *   1. src/fixtures/api/sites/s1/bots.json   (exact path)
 *   2. src/fixtures/api/sites/_/bots.json    (`_` matches any one segment, e.g. an id)
 *
 * No match → the request goes to the network as usual. Each screen ticket adds files for its own
 * endpoints and edits nothing shared. Only GETs are served; mutations always hit the API.
 */
export type FixtureLoader = () => Promise<unknown>;
export type FixtureMap = Readonly<Record<string, FixtureLoader>>;

/** `/api/sites/s1/bots?x=1` → `api/sites/s1/bots` (no leading slash, query and trailing slash dropped). */
export function fixtureKey(path: string): string {
  return (path.split(/[?#]/)[0] ?? '').replace(/^\/+|\/+$/g, '');
}

/** Candidate keys for a path, most specific first. */
export function fixtureCandidates(path: string): string[] {
  const segments = fixtureKey(path).split('/');
  if (segments.length === 1 && segments[0] === '') return [];
  const out = new Set<string>([segments.join('/')]);
  // Then every combination with `_` wildcards, fewest wildcards first, leftmost kept literal longest.
  const n = segments.length;
  const masks = Array.from({ length: 2 ** n }, (_, m) => m).filter((m) => m !== 0);
  masks.sort((a, b) => popcount(a) - popcount(b) || a - b);
  for (const m of masks) {
    out.add(segments.map((s, i) => (m & (1 << (n - 1 - i)) ? '_' : s)).join('/'));
  }
  return [...out];
}

function popcount(x: number): number {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
}

/** Normalises `import.meta.glob` keys (`../fixtures/api/x.json`) to fixture keys (`api/x`). */
export function fixtureMapFromGlob(glob: Record<string, FixtureLoader>): FixtureMap {
  const map: Record<string, FixtureLoader> = {};
  for (const [file, load] of Object.entries(glob)) {
    const key = file.replace(/^.*?\/fixtures\//, '').replace(/\.json$/, '');
    map[key] = load;
  }
  return map;
}

export function findFixture(map: FixtureMap, path: string): FixtureLoader | undefined {
  for (const key of fixtureCandidates(path)) {
    const hit = map[key];
    if (hit) return hit;
  }
  return undefined;
}

export function fixturesEnabled(): boolean {
  return import.meta.env.VITE_FIXTURES === '1';
}

/**
 * The fixture files, lazily loaded. In a normal build the branch is constant-false, so no fixture
 * ships in the bundle.
 */
export const bundledFixtures: FixtureMap =
  import.meta.env.VITE_FIXTURES === '1'
    ? fixtureMapFromGlob(
        import.meta.glob<unknown>('../fixtures/**/*.json', { import: 'default' }) as Record<
          string,
          FixtureLoader
        >,
      )
    : {};
