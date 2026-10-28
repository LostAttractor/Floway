import { test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('/api/performance/overview groups response tiers and preserves explicit empty-tier filters', async () => {
  const { repo, apiKey } = await setupAppTest();
  const sample = {
    hour: '2026-04-30T10', keyId: apiKey.id, model: 'model', upstream: 'upstream',
    operation: 'chat' as const, runtimeLocation: 'LOCAL', tpotUs: 500, success: true,
  };
  const customTier = ' Pri\"雪 ';
  await repo.performance.recordSample({ ...sample, ttftMs: 25 });
  await repo.performance.recordSample({ ...sample, ttftMs: 250, serviceTier: 'priority' });
  await repo.performance.recordSample({ ...sample, ttftMs: 600, serviceTier: customTier });
  const path = '/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=serviceTier';
  for (const [query, groups] of [
    ['', ['', customTier, 'priority']],
    ['&filter_service_tier=', ['']],
    ['&filter_service_tier=priority', ['priority']],
    [`&filter_service_tier=&filter_service_tier=${encodeURIComponent(customTier)}`, ['', customTier]],
  ] as const) {
    const response = await requestApp(`${path}${query}`, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.series.map((row: { group: string }) => row.group).sort(), [...groups].sort());
    assertEquals(body.axes.serviceTier.map((row: { group: string }) => row.group).sort(), [...groups].sort());
    assertEquals(body.dimensionValues.serviceTiers.sort(), ['', customTier, 'priority'].sort());
    assertEquals(body.axes.none[0].requests, groups.length);
  }
});

test('/api/performance/overview cross-filters requested and reported tiers without losing explicit empty values', async () => {
  const { repo, apiKey } = await setupAppTest();
  const sample = {
    hour: '2026-04-30T10', keyId: apiKey.id, model: 'model', upstream: 'upstream',
    operation: 'chat' as const, runtimeLocation: 'LOCAL', ttftMs: 250, tpotUs: 500, success: true,
  };
  const customTier = ' Request"雪 ';
  await repo.performance.recordSample(sample);
  await repo.performance.recordSample({ ...sample, requestedServiceTier: 'priority' });
  await repo.performance.recordSample({ ...sample, requestedServiceTier: 'priority', serviceTier: 'default' });
  await repo.performance.recordSample({ ...sample, requestedServiceTier: customTier, serviceTier: 'default' });
  const path = '/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00';
  for (const [query, groups, requests] of [
    ['&group_by=requestedServiceTier', ['', customTier, 'priority'], 4],
    ['&group_by=requestedServiceTier&filter_requested_service_tier=', [''], 1],
    ['&group_by=requestedServiceTier&filter_service_tier=', ['', 'priority'], 2],
    ['&group_by=requestedServiceTier&filter_service_tier=default', [customTier, 'priority'], 2],
    ['&group_by=serviceTier&filter_requested_service_tier=priority', ['', 'default'], 2],
    ['&group_by=serviceTier&filter_requested_service_tier=priority&filter_service_tier=default', ['default'], 1],
    [`&group_by=requestedServiceTier&filter_requested_service_tier=&filter_requested_service_tier=${encodeURIComponent(customTier)}`, ['', customTier], 2],
  ] as const) {
    const response = await requestApp(`${path}${query}`, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.series.map((row: { group: string }) => row.group).sort(), [...groups].sort());
    assertEquals(body.dimensionValues.requestedServiceTiers.sort(), ['', customTier, 'priority'].sort());
    assertEquals(body.dimensionValues.serviceTiers, ['', 'default']);
    assertEquals(body.axes.none[0].requests, requests);
  }
});

test('/api/performance/overview accepts only model × requested tier comparisons', async () => {
  const { apiKey } = await setupAppTest();
  const path = '/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00';
  for (const group of ['', '&group_by=model']) {
    const response = await requestApp(`${path}&compare_by=requestedServiceTier${group}`, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 200);
    assertEquals((await response.json()).comparison, { by: 'requestedServiceTier', groups: [], rows: [] });
  }
  for (const query of ['compare_by=serviceTier', 'compare_by=invalid', ...['upstream', 'requestedServiceTier', 'serviceTier', 'keyId', 'userId', 'operation', 'runtimeLocation'].map(group => `compare_by=requestedServiceTier&group_by=${group}`)]) {
    const response = await requestApp(`${path}&${query}`, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 400);
  }
});

test('/api/performance/overview keeps only the none axis global for a non-admin', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'copilot:1', name: 'Self visible' }));
  await repo.apiKeys.save({
    id: 'key_admin_owned',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  });

  const sample = {
    hour: '2026-04-30T10',
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat' as const,
    runtimeLocation: 'LOCAL',
    ttftMs: 100,
    tpotUs: 500,
    success: true,
  };
  await repo.performance.recordSample({ ...sample, keyId: apiKey.id });
  await repo.performance.recordSample({ ...sample, keyId: 'key_admin_owned', requestedServiceTier: 'hidden', serviceTier: 'hidden' });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.none[0].requests, 2);
  // Resource and user breakdowns remain scoped to visible cells.
  assertEquals(body.axes.model.length, 1);
  assertEquals(body.axes.model[0].requests, 1);
  assertEquals(body.axes.userId.map((row: { group: string; requests: number }) => [row.group, row.requests]), [['2', 1]]);
  assertEquals(body.users.map((user: { id: number }) => user.id), [2]);
  assertEquals(body.dimensionValues.userIds, [2]);
  assertEquals(body.upstreams, [{ id: 'copilot:1', name: 'Self visible', hue: 210 }]);
  assertEquals(body.dimensionValues.requestedServiceTiers, ['']);
  assertEquals(body.dimensionValues.serviceTiers, ['']);
  const compared = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&compare_by=requestedServiceTier', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(compared.status, 200);
  const comparison = await compared.json();
  assertEquals(comparison.axes, body.axes);
  assertEquals(comparison.axes.none[0].requests, 2);
  assertEquals(comparison.comparison.groups, [{ id: JSON.stringify(['gpt-5', '']), model: 'gpt-5', tier: '' }]);
  assertEquals(comparison.comparison.rows.map((row: { group: string; requests: number }) => [row.group, row.requests]), [[JSON.stringify(['gpt-5', '']), 1]]);
  assertEquals(comparison.series.map((row: { group: string; requests: number }) => [row.group, row.requests]), [[JSON.stringify(['gpt-5', '']), 1]]);
  for (const filter of ['filter_requested_service_tier', 'filter_service_tier']) {
    const filtered = await requestApp(`/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&${filter}=`, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(filtered.status, 200);
    const filteredBody = await filtered.json();
    assertEquals(filteredBody.axes.none[0].requests, 1);
    assertEquals(filteredBody.axes.userId.map((row: { group: string }) => row.group), ['2']);
  }
});

test('/api/performance/overview narrows an administrator to their own keys under group_by=keyId too', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_admin',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  });

  const sample = {
    hour: '2026-04-30T10',
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat' as const,
    runtimeLocation: 'LOCAL',
    ttftMs: 100,
    tpotUs: 500,
    success: true,
  };
  await repo.performance.recordSample({ ...sample, keyId: apiKey.id });
  await repo.performance.recordSample({ ...sample, keyId: 'key_admin' });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=keyId', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.series.map((r: { group: string }) => r.group), ['key_admin']);
  assertEquals(body.axes.keyId.map((r: { group: string }) => r.group), ['key_admin']);
  assertEquals(body.dimensionValues.keyIds, ['key_admin']);
  assertEquals(body.keys, [{
    id: 'key_admin',
    name: 'Admin owned',
    createdAt: '2026-04-30T00:00:00.000Z',
  }]);
  // By API Key means "my data" for administrators as well: the other user's
  // row is out of scope, so every cross-cutting axis counts one request.
  assertEquals(body.axes.model[0].requests, 1);
  assertEquals(body.axes.userId.map((r: { group: string; requests: number }) => [r.group, r.requests]), [['1', 1]]);
});

test('/api/performance/overview attributes soft-deleted keys to their original owner', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  // Latency sample on apiKey, then soft-delete the key. The aggregator must
  // still resolve the row to apiKey.userId rather than the synthetic userId 0
  // it falls back to when the key→user lookup misses.
  await repo.performance.recordSample({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat',
    runtimeLocation: 'LOCAL',
    ttftMs: 100,
    tpotUs: 500,
    success: true,
  });
  await repo.apiKeys.softDelete(apiKey.id);

  const response = await requestApp(
    '/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00',
    { headers: { 'x-floway-session': adminSession } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  const groups = body.axes.userId.map((r: { group: string; requests: number }) => [r.group, r.requests]);
  assertEquals(groups, [[String(apiKey.userId), 1]]);
});

test('/api/performance/overview merges calendar bucket histograms before calculating percentiles', async () => {
  const { repo, apiKey } = await setupAppTest();
  const sample = {
    keyId: apiKey.id, model: 'gpt-5', upstream: 'copilot:1', operation: 'chat' as const,
    runtimeLocation: 'LOCAL', tpotUs: 500, success: true,
  };
  for (let index = 0; index < 90; index++) await repo.performance.recordSample({ ...sample, hour: '2026-04-30T10', ttftMs: 100 });
  for (let index = 0; index < 10; index++) await repo.performance.recordSample({ ...sample, hour: '2026-05-01T02', ttftMs: 300 });
  for (const hour of ['2026-04-30T09', '2026-05-03T16']) await repo.performance.recordSample({ ...sample, hour, ttftMs: 10_000 });

  for (const [bucket, key] of [['week', '2026-04-27'], ['2d', '2026-04-30']] as const) {
    const response = await requestApp(`/api/performance/overview?start=2026-04-30T10&end=2026-05-03T16&bucket=${bucket}&timezone=Asia%2FSingapore`, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.series.length, 1);
    assertEquals(body.series[0].bucket, key);
    assertEquals(body.series[0].requests, 100);
    assertEquals(body.series[0].ttftMsP95, 200 + 100 * 5 / 11);
  }
});

test('telemetry overviews reject invalid or reversed custom timestamps', async () => {
  const { apiKey } = await setupAppTest();
  for (const endpoint of ['performance', 'token-usage']) {
    for (const query of [
      'start=2026-04-31T00&end=2026-05-02T00',
      'start=2026-05-02T00&end=2026-05-01T00',
      'start=2026-05-01T00&end=2026-05-02T00&bucket=0d',
    ]) {
      const response = await requestApp(`/api/${endpoint}/overview?${query}`, { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 400);
    }
  }
});
