import { expect, test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { buildCustomUpstreamRecord } from '../test-utils/app.ts';

const policy = { enabled: true, tiers: ['priority', 'vendor/Tier'] };

test('Floway SQL policy round-trips and participates in optimistic edit checks', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  const initial = await repo.insertAtEndForModels(buildCustomUpstreamRecord());
  expect(initial?.serviceTierPolicy).toBeNull();
  if (!initial) throw new Error('Insert failed');
  const enabled = await repo.replaceForModels({ previous: initial, upstream: { ...initial, serviceTierPolicy: policy } });
  expect(enabled?.serviceTierPolicy).toEqual(policy);
  expect(enabled?.configVersion).toBe(initial.configVersion);
  expect(await repo.replaceForModels({ previous: initial, upstream: { ...initial, name: 'Stale' } })).toBeNull();
  const reloaded = await repo.getById(initial.id);
  expect(reloaded?.serviceTierPolicy).toEqual(policy);
  if (!reloaded) throw new Error('Reload failed');
  expect((await repo.replaceForModels({ previous: reloaded, upstream: { ...reloaded, serviceTierPolicy: { ...policy, enabled: false } } }))?.serviceTierPolicy).toEqual({ ...policy, enabled: false });
  expect((await repo.insertForModels(buildCustomUpstreamRecord({ id: 'up_import', serviceTierPolicy: policy })))?.serviceTierPolicy).toEqual(policy);
  expect((await repo.list()).map(row => row.serviceTierPolicy)).toEqual([{ ...policy, enabled: false }, policy]);
});

test.each(['{broken', '{"enabled":true,"tiers":[]}'])('Floway SQL exposes malformed policy with its original error chain: %s', async raw => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await repo.insertForModels(buildCustomUpstreamRecord());
  await db.prepare('UPDATE upstreams SET service_tier_policy = ?').bind(raw).run();
  await expect(repo.list()).rejects.toMatchObject({ cause: expect.any(Error) });
});
