import { describe, expect, it } from 'vitest';
import { robotsPathsFromGated, robotsTxt } from './robots.js';

describe('robots helper', () => {
  it('lists Google-Extended and the AI crawler tokens', () => {
    const txt = robotsTxt({
      disallow: ['/listings/'],
      catalogUrl: 'https://spigot.onrender.com/c/bluebonnet',
    });
    expect(txt).toContain('User-agent: Google-Extended\n');
    expect(txt).toContain('User-agent: GPTBot\n');
    expect(txt).toContain('User-agent: Applebot-Extended\n');
    expect(txt).not.toMatch(/User-agent: (Googlebot|Applebot|Bingbot)\n/);
    expect(txt).toContain('Disallow: /listings/\n');
    expect(txt.startsWith('# This site')).toBe(true);
  });

  it('emits an empty Disallow when nothing is gated', () => {
    expect(robotsTxt({ disallow: [], tokens: ['GPTBot'] })).toBe('User-agent: GPTBot\nDisallow:\n');
  });

  it('converts literal anchored gate regexes to path prefixes', () => {
    expect(
      robotsPathsFromGated([
        '^/listings/',
        '^\\/agents\\/',
        '^/open-houses/',
        '^/listings/',
        '/x$',
        '^/a/[0-9]+',
      ]),
    ).toEqual(['/listings/', '/agents/', '/open-houses/']);
  });
});
