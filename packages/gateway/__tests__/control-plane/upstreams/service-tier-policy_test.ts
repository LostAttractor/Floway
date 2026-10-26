import { afterEach, expect, test, vi } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';

const policy = { enabled: true, tiers: ['priority', 'default', 'vendor/Tier'] };
const createBody = {
  kind: 'custom', name: 'Floway local tier policy', hue: 210,
  config: { baseUrl: 'https://tier.invalid', authStyle: 'none', endpoints: { openaiResponses: {} }, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] },
};

const setup = async () => {
  vi.stubGlobal('fetch', () => { throw new Error('External network is forbidden in policy tests'); });
  const fixture = await setupAppTest();
  return { ...fixture, headers: { 'content-type': 'application/json', 'x-floway-session': fixture.adminSession } };
};

afterEach(async () => {
  await flushBackground();
  vi.unstubAllGlobals();
});

test('Floway policy defaults off and PATCH preserves, disables, and clears it explicitly', async () => {
  const { repo, headers } = await setup();
  const created = await requestApp('/api/upstreams', { method: 'POST', headers, body: JSON.stringify(createBody) });
  expect(created.status, await created.clone().text()).toBe(201);
  const record = await created.json();
  expect(record.service_tier_policy).toBeNull();
  for (const [patch, expected] of [
    [{ service_tier_policy: policy }, policy],
    [{ name: 'Floway renamed' }, policy],
    [{ service_tier_policy: { ...policy, enabled: false } }, { ...policy, enabled: false }],
    [{ service_tier_policy: null }, null],
  ] as const) {
    const response = await requestApp(`/api/upstreams/${record.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).service_tier_policy).toEqual(expected);
    expect((await repo.upstreams.getById(record.id))?.serviceTierPolicy).toEqual(expected);
  }
});

test.each([{}, { enabled: true, tiers: [] }, { enabled: true, tiers: ['priority', 'priority'] }, { enabled: false, tiers: [' '] }])('Floway rejects invalid policy without saving it: %j', async service_tier_policy => {
  const { headers, repo } = await setup();
  const before = await repo.upstreams.list();
  const response = await requestApp('/api/upstreams', { method: 'POST', headers, body: JSON.stringify({ ...createBody, service_tier_policy }) });
  expect(response.status).toBe(400);
  expect(await repo.upstreams.list()).toEqual(before);
});

test('Floway v27 backup round-trips policy while v25/v26 missing policy restores disabled', async () => {
  const { headers, repo } = await setup();
  const created = await requestApp('/api/upstreams', { method: 'POST', headers, body: JSON.stringify({ ...createBody, service_tier_policy: policy }) });
  expect(created.status, await created.clone().text()).toBe(201);
  const record = await created.json();
  const exported = await requestApp('/api/export?include_performance=true', { headers });
  expect(exported.status).toBe(200);
  const backup = await exported.json();
  expect(backup.version).toBe(27);
  expect(backup.data.upstreams.find((row: { id: string }) => row.id === record.id).service_tier_policy).toEqual(policy);
  for (const version of [27, 26, 25]) {
    const data = structuredClone(backup.data);
    if (version !== 27) for (const row of data.upstreams) delete row.service_tier_policy;
    const restored = await requestApp('/api/import', { method: 'POST', headers, body: JSON.stringify({ version, mode: 'merge', data }) });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await repo.upstreams.getById(record.id))?.serviceTierPolicy).toEqual(version === 27 ? policy : null);
  }
});
