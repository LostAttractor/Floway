import { expect, it, vi } from 'vitest';

import { createUpstreamUsageRecorder } from '../../src/upstream-usage/recorder.ts';
import { InMemoryRepo } from '../repo/memory.ts';

it('propagates the original storage failure and retries an unchanged observation', async () => {
  const repo = new InMemoryRepo();
  const error = new Error('Database unavailable');
  const persist = vi.spyOn(repo.upstreamUsageMetrics, 'record').mockRejectedValueOnce(error);
  const record = createUpstreamUsageRecorder(repo);
  await expect(record('up-1', '["quota","premium_interactions"]', 20, 1_000)).rejects.toBe(error);
  await record('up-1', '["quota","premium_interactions"]', 20, 1_000);
  expect(persist).toHaveBeenCalledTimes(2);
  expect(await repo.upstreamUsageMetrics.query(0, 2_000)).toMatchObject([{ upstreamId: 'up-1', value: 20 }]);
});

it('records upstream identities without fetching display metadata', async () => {
  const repo = new InMemoryRepo();
  const lookup = vi.spyOn(repo.upstreams, 'getById');
  const persist = vi.spyOn(repo.upstreamUsageMetrics, 'record');
  await createUpstreamUsageRecorder(repo)('gone', '["quota","premium_interactions"]', 20, 1_000);
  expect(persist).toHaveBeenCalledWith({ upstreamId: 'gone', key: '["quota","premium_interactions"]', value: 20, timestamp: 1_000 });
  expect(lookup).not.toHaveBeenCalled();
});

it('rejects invalid observations at the recording boundary', async () => {
  const record = createUpstreamUsageRecorder(new InMemoryRepo());
  for (const [key, value, timestamp] of [['[]', NaN, 1_000], ['[]', Infinity, 1_000], ['[]', 20, -1], ['[]', 20, 0.5]] as const) {
    await expect(record('up-1', key, value, timestamp)).rejects.toThrow(TypeError);
  }
});

it('canonicalizes JSON array keys and rejects scalars and objects', async () => {
  const repo = new InMemoryRepo();
  const record = createUpstreamUsageRecorder(repo);
  await record('up-1', '[ "quota", "name_with_underscores" ]', 20, 1_000);
  expect(await repo.upstreamUsageMetrics.query(0, 2_000)).toEqual([{ upstreamId: 'up-1', key: '["quota","name_with_underscores"]', value: 20, timestamp: 1_000 }]);
  for (const key of ['', 'plain_key', '{}', '"scalar"', '42', 'null']) await expect(record('up-1', key, 20, 1_000)).rejects.toThrow();
});
