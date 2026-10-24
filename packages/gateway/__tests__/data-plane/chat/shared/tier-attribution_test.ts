import { afterEach, expect, test, vi } from 'vitest';

import { initRepo } from '../../../../src/repo/index.ts';
import { SqlRepo } from '../../../../src/repo/sql.ts';
import { createSqliteTestDb } from '../../../repo/test-sqlite.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest, sseResponse, testAdminUser, warmModelsForTest } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const MODEL = 'gpt-6-astra';
const ALIAS = 'gpt-6-astra-fast';
const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

const responseResult = (overrides: Partial<OpenAIResponsesResultEx> = {}): OpenAIResponsesResultEx => ({
  id: 'resp_tier', object: 'response', model: MODEL, status: 'completed',
  output: [{ type: 'message', id: 'msg_tier', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'local result', annotations: [] }] }],
  error: null, incomplete_details: null, usage,
  ...overrides,
});

const setup = async () => {
  vi.stubGlobal('fetch', () => { throw new Error('External network is forbidden in tier attribution tests'); });
  const fixture = await setupAppTest();
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  await repo.users.save(testAdminUser);
  const apiKey = { ...fixture.apiKey, userId: testAdminUser.id };
  await repo.apiKeys.save(apiKey);
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://tier.example.test', authStyle: 'none', ingressHeadersRules: [],
      endpoints: { openaiResponses: {} }, modelsFetch: { enabled: false },
      models: [{ upstreamModelId: MODEL, publicModelId: MODEL, kind: 'chat', endpoints: { openaiResponses: {} } }],
    },
  }));
  await repo.modelAliases.insert({
    id: 'alias_tier', name: ALIAS, kind: 'chat', selection: 'first-available',
    targets: [{ target_model_id: MODEL, rules: { serviceTier: 'priority' } }],
    displayName: null, visibleInModelsList: true, announcedMetadata: null, sortOrder: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await warmModelsForTest();
  expect((await repo.upstreams.getById('up_custom'))?.modelsCache?.lastError).toBeNull();
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey.key };
  return { db, repo, headers };
};

afterEach(async () => {
  await flushBackground();
  vi.unstubAllGlobals();
});

for (const stream of [false, true]) {
  for (const translated of [false, true]) {
    test.each([undefined, 'default', 'priority'])(`alias priority → raw %s → SQLite and overview (stream=${stream}, translated=${translated})`, async reportedTier => {
      const { db, headers } = await setup();
      const outgoing: unknown[] = [];
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe('https://tier.example.test/v1/responses');
        outgoing.push(await request.json());
        return sseResponse([{
          event: 'response.completed', data: {
            type: 'response.completed', response: responseResult(reportedTier === undefined ? {} : { service_tier: reportedTier }),
          },
        }]);
      });
      const response = await requestApp(translated ? '/v1/chat/completions' : '/v1/responses', {
        method: 'POST', headers,
        body: JSON.stringify({ model: ALIAS, stream, ...(translated ? { messages: [{ role: 'user', content: 'local test' }] } : { input: 'local test' }) }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain('local result');
      await flushBackground();
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]).toMatchObject({ model: MODEL, service_tier: 'priority', stream: true });
      expect((await db.prepare('SELECT model, requested_service_tier, service_tier, requests FROM performance_summary').all()).results).toEqual([
        { model: MODEL, requested_service_tier: 'priority', service_tier: reportedTier ?? '', requests: 1 },
      ]);
      const query = new URLSearchParams({
        start: new Date(Date.now() - 3_600_000).toISOString().slice(0, 13),
        end: new Date(Date.now() + 3_600_000).toISOString().slice(0, 13),
        group_by: 'requestedServiceTier', filter_service_tier: reportedTier ?? '',
      });
      const overview = await requestApp(`/api/performance/overview?${query}`, { headers });
      expect(overview.status).toBe(200);
      const data = await overview.json();
      expect(data.dimensionValues).toMatchObject({ requestedServiceTiers: ['priority'], serviceTiers: [reportedTier ?? ''] });
      expect(data.axes.none[0].requests).toBe(1);
      expect(data.series.map((series: { group: string }) => series.group)).toEqual(['priority']);
    });
  }
}

test.each([
  { terminal: undefined, withUsage: true, expected: 'priority' },
  { terminal: undefined, withUsage: false, expected: 'priority' },
  { terminal: 'default', withUsage: true, expected: 'default' },
  { terminal: null, withUsage: true, expected: '' },
  { terminal: '', withUsage: true, expected: '' },
])('raw lifecycle tier independent of usage: $terminal / $withUsage', async ({ terminal, withUsage, expected }) => {
  const { db, headers } = await setup();
  vi.stubGlobal('fetch', () => Promise.resolve(sseResponse([
    { event: 'response.created', data: { type: 'response.created', response: responseResult({ status: 'in_progress', output: [], usage: undefined, service_tier: 'priority' }) } },
    { event: 'response.completed', data: { type: 'response.completed', response: responseResult({ usage: withUsage ? usage : undefined, ...(terminal === undefined ? {} : { service_tier: terminal }) }) } },
  ])));
  const response = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: ALIAS, input: 'local test' }) });
  expect(response.status, await response.text()).toBe(200);
  await flushBackground();
  expect((await db.prepare('SELECT requested_service_tier, service_tier, requests FROM performance_summary').all()).results).toEqual([
    { requested_service_tier: 'priority', service_tier: expected, requests: 1 },
  ]);
});

test.each(['fetch', 'stream'] as const)('failed %s preserves the owning request and observed response tier', async failure => {
  const { db, headers } = await setup();
  vi.stubGlobal('fetch', () => {
    if (failure === 'fetch') throw new Error('Local upstream dispatch failure');
    return Promise.resolve(new Response(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: responseResult({ status: 'in_progress', output: [], usage: undefined, service_tier: 'priority' }) })}\n\nevent: response.in_progress\ndata: {broken-json\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  });
  const response = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: ALIAS, input: 'local test' }) });
  expect(response.status, await response.text()).toBe(502);
  await flushBackground();
  expect((await db.prepare('SELECT requested_service_tier, service_tier, requests, errors_no_output FROM performance_summary').all()).results).toEqual([
    { requested_service_tier: 'priority', service_tier: failure === 'stream' ? 'priority' : '', requests: 1, errors_no_output: 1 },
  ]);
});

test('alias failover starts fresh request/report coordinates and records one final request', async () => {
  const { db, repo, headers } = await setup();
  await repo.modelAliases.insert({
    id: 'alias_retry', name: 'retry-tier', kind: 'chat', selection: 'first-available',
    targets: [
      { target_model_id: MODEL, rules: { serviceTier: 'priority' } },
      { target_model_id: MODEL, rules: { serviceTier: 'default' } },
    ],
    displayName: null, visibleInModelsList: true, announcedMetadata: null, sortOrder: 2,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const requested: unknown[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Request(input, init).json() as { service_tier?: string };
    requested.push(body.service_tier);
    if (body.service_tier === 'priority') return new Response('Local rate limit', { status: 429 });
    return sseResponse([{ data: { type: 'response.completed', response: responseResult() } }]);
  });
  const response = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'retry-tier', input: 'local test' }) });
  expect(response.status, await response.text()).toBe(200);
  await flushBackground();
  expect(requested).toEqual(['priority', 'default']);
  expect((await db.prepare('SELECT requested_service_tier, service_tier, requests FROM performance_summary').all()).results).toEqual([
    { requested_service_tier: 'default', service_tier: '', requests: 1 },
  ]);
});

test('one real model stays separated by alias request intent, including unknown and open strings', async () => {
  const { db, repo, headers } = await setup();
  await repo.modelAliases.insert({
    id: 'alias_custom', name: 'custom-tier', kind: 'chat', selection: 'first-available',
    targets: [{ target_model_id: MODEL, rules: { serviceTier: 'vendor/custom' } }],
    displayName: null, visibleInModelsList: true, announcedMetadata: null, sortOrder: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const requested: unknown[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requested.push((await request.json() as { service_tier?: string }).service_tier);
    return sseResponse([{ data: { type: 'response.completed', response: responseResult() } }]);
  });
  for (const model of [ALIAS, 'custom-tier', MODEL]) {
    const response = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model, input: 'local test' }) });
    expect(response.status, await response.text()).toBe(200);
    await flushBackground();
  }
  expect(requested).toEqual(['priority', 'vendor/custom', undefined]);
  expect((await db.prepare('SELECT model, requested_service_tier, service_tier, requests FROM performance_summary ORDER BY requested_service_tier').all()).results).toEqual([
    { model: MODEL, requested_service_tier: '', service_tier: '', requests: 1 },
    { model: MODEL, requested_service_tier: 'priority', service_tier: '', requests: 1 },
    { model: MODEL, requested_service_tier: 'vendor/custom', service_tier: '', requests: 1 },
  ]);
});
