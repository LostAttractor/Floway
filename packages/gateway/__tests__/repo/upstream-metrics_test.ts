import { describe, expect, it } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { UpstreamMetricRecord } from '../../src/repo/types.ts';

const point = (timestamp: number, value: number, key = '["remaining","premium_interactions"]'): UpstreamMetricRecord => ({ upstreamId: 'up-1', key, timestamp, value });

for (const [name, create] of [
  ['SQL', async () => new SqlRepo(await createSqliteTestDb())],
  ['memory', async () => new InMemoryRepo()],
] as const) {
  describe(`${name} upstream metrics gauges`, () => {
    it('restores complete gauge snapshots and clears them for replacement imports', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.set(point(70_000, 20));
      await repo.set(point(1_000, 20));
      await repo.set(point(70_000, 30));
      await repo.record(point(20_000, 25));
      expect(await repo.listAll()).toEqual([point(1_000, 20), point(70_000, 30)]);
      await repo.deleteAll();
      expect(await repo.query('up-1', 0, 90_000)).toEqual([]);
    });

    it('coalesces changes to the latest observation per minute and preserves resets', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(20_000, 25));
      await repo.record(point(30_000, 26));
      await repo.record(point(60_000, 0));
      expect(await repo.query('up-1', 0, 90_000)).toEqual([point(30_000, 26), point(60_000, 0)]);
    });

    it('skips unchanged values and delayed observations without merging metric identities', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(61_000, 20));
      await repo.record(point(121_000, 30));
      await repo.record(point(80_000, 25));
      await repo.record(point(121_000, 40, '["remaining","future_metric"]'));
      await repo.record({ ...point(121_000, 90), upstreamId: 'up-2' });
      const records = await repo.listAll();
      expect(await repo.query('up-1', 0, 180_000)).toHaveLength(3);
      expect(records).toHaveLength(4);
      expect(records.filter(record => record.upstreamId === 'up-1' && record.key === '["remaining","premium_interactions"]')).toEqual([point(1_000, 20), point(121_000, 30)]);
    });

    it('retains a changed value when two observations share a capture timestamp', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(1_000, 25));
      expect(await repo.query('up-1', 0, 60_000)).toEqual([point(1_000, 25)]);
    });

    it('returns one baseline per identity and uses an exclusive end', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(61_000, 30));
      await repo.record(point(121_000, 40));
      await repo.record(point(181_000, 50));
      expect(await repo.query('up-1', 100_000, 181_000)).toEqual([point(61_000, 30), point(121_000, 40)]);
      expect(await repo.query('up-1', 200_000, 300_000)).toEqual([point(181_000, 50)]);
    });
  });
}

it('shares coalescing and deduplication across independent SQL repository instances', async () => {
  const db = await createSqliteTestDb();
  const first = new SqlRepo(db).upstreamMetrics;
  const second = new SqlRepo(db).upstreamMetrics;
  await Promise.all([first.record(point(1_000, 20)), second.record(point(20_000, 30))]);
  await first.record(point(10_000, 25));
  expect(await second.query('up-1', 0, 60_000)).toEqual([point(20_000, 30)]);
});

it('declares JSON metric keys and enforces arrays in SQLite', async () => {
  const db = await createSqliteTestDb();
  const { results } = await db.prepare('PRAGMA table_info(upstream_metrics)').all<{ name: string; type: string }>();
  expect(results.find(column => column.name === 'metric_key')!.type).toBe('JSON');
  const repo = new SqlRepo(db).upstreamMetrics;
  for (const key of ['plain_key', '{}', '42', 'null', '"string"']) await expect(repo.set(point(1_000, 20, key))).rejects.toThrow();
  await repo.set(point(1_000, 20));
  expect(await repo.listAll()).toEqual([point(1_000, 20)]);
});
