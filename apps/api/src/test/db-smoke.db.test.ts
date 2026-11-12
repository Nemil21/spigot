import pg from 'pg';
import { describe, expect, it } from 'vitest';

// Proves the `db` vitest project and CI's Postgres service are wired up (SP-001a). Real DB tests
// are `*.db.test.ts` files next to their code and run against TEST_DATABASE_URL.
describe('test database', () => {
  it('is reachable at TEST_DATABASE_URL', async () => {
    const url = process.env.TEST_DATABASE_URL;
    expect(url, 'set TEST_DATABASE_URL (npm run dev:db prints it)').toBeTruthy();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query<{ v: number }>('select 1 as v');
      expect(rows).toEqual([{ v: 1 }]);
    } finally {
      await client.end();
    }
  });
});
