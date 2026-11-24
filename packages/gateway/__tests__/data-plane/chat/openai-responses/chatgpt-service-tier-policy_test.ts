import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildChatGPTUpstreamRecord, requestApp, setupAppTest, sseOpenAIResponsesResponse, warmModelsForTest } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { ServiceTierPolicy } from '@floway-dev/provider';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const sol = 'gpt-6.2-sol';
const astra = 'gpt-6.2-astra';
const priority = { id: 'priority', name: 'Fast', description: 'Fast responses' };
const ultrafast = { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest responses' };
const future = { id: 'vendor/Turbo', name: 'Turbo', description: 'Preview only' };

const models = [
  { slug: sol, service_tiers: [priority, ultrafast] },
  { slug: astra, service_tiers: [priority] },
  { slug: 'future-model', service_tiers: [future] },
  { slug: 'legacy', additional_speed_tiers: ['fast'] },
  { slug: 'empty', service_tiers: [], additional_speed_tiers: ['fast'] },
  { slug: 'gpt-5.5' },
].map(model => ({ ...model, display_name: model.slug, context_window: 272000 }));

const setup = async (plan: string, policy: ServiceTierPolicy | null) => {
  const { repo, apiKey, copilotUpstream } = await setupAppTest();
  await repo.upstreams.delete(copilotUpstream.id);
  await saveUpstreamForTest(repo.upstreams, buildChatGPTUpstreamRecord({
    config: { accounts: [{ email: 'codex@example.invalid', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: plan }] },
    serviceTierPolicy: policy,
  }));
  return { repo, headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' } };
};

const upstreamTierError = JSON.stringify({ error: { message: 'Ultrafast is unavailable on this account', param: 'service_tier', code: 'unsupported_value' } });

const chatgptFetch = (sent: Record<string, unknown>[]) => async (request: Request) => {
  const url = new URL(request.url);
  if (url.hostname === 'raw.githubusercontent.com') return new Response(null, { status: 404 });
  if (url.pathname === '/backend-api/codex/models') return jsonResponse({ models });
  expect(url.pathname).toBe('/backend-api/codex/responses');
  const body = await request.json() as Record<string, unknown>;
  sent.push(body);
  if (body.model === astra && body.service_tier === 'ultrafast') {
    return new Response(upstreamTierError, { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'upstream-tier-error' } });
  }
  return sseOpenAIResponsesResponse({
    id: 'resp_policy', object: 'response', model: body.model, status: 'completed', output: [],
    error: null, incomplete_details: null, usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
  });
};

const generate = async (headers: HeadersInit, model: string, service_tier?: string, compact = false) =>
  await requestApp(compact ? '/v1/responses/compact' : '/v1/responses', {
    method: 'POST', headers, body: JSON.stringify({ model, input: 'local policy test', service_tier }),
  });

const cases: {
  name: string;
  model: string;
  plan?: string;
  policy?: ServiceTierPolicy;
  listed: typeof priority[];
  requested?: string;
  rejects?: 'gateway' | 'upstream';
}[] = [
  { name: 'Sol Fast on a free plan', model: sol, plan: 'free', listed: [priority, ultrafast], requested: 'priority' },
  { name: 'Sol Ultrafast', model: sol, listed: [priority, ultrafast], requested: 'ultrafast' },
  { name: 'Astra Fast', model: astra, listed: [priority], requested: 'priority' },
  { name: 'Astra pricing does not grant Ultrafast', model: astra, listed: [priority], requested: 'ultrafast', rejects: 'upstream' },
  { name: 'new model and tier on an unknown plan', model: 'future-model', plan: 'future', listed: [future], requested: future.id },
  { name: 'legacy Fast maps to priority', model: 'legacy', listed: [{ id: 'priority', name: 'Fast', description: '' }], requested: 'priority' },
  { name: 'empty service_tiers supersedes legacy Fast', model: 'empty', listed: [], requested: 'priority' },
  { name: 'no tier fields on a paid plan', model: 'gpt-5.5', listed: [], requested: 'priority' },
  { name: 'no request tier is injected', model: sol, listed: [priority, ultrafast] },
  { name: 'explicit off overrides Sol', model: sol, policy: { enabled: false, tiers: ['ultrafast'] }, listed: [], requested: 'ultrafast', rejects: 'gateway' },
  { name: 'manual allowlist without advertising an unavailable tier', model: astra, policy: { enabled: true, tiers: ['ultrafast'] }, listed: [], requested: 'ultrafast', rejects: 'upstream' },
  { name: 'manual allowlist excludes the inherited tier', model: astra, policy: { enabled: true, tiers: ['ultrafast'] }, listed: [], requested: 'priority', rejects: 'gateway' },
];

test.each(cases)('ChatGPT catalog, upstream request and telemetry: $name', async ({ model, plan = 'plus', policy, listed, requested, rejects }) => {
  const { repo, headers } = await setup(plan, policy ?? null);
  const sent: Record<string, unknown>[] = [];
  await withMockedFetch(chatgptFetch(sent), async () => {
    await warmModelsForTest();
    const response = await requestApp('/azure-api.codex/models', { headers: { ...headers, 'user-agent': 'codex_cli_rs/0.169.0' } });
    expect(response.status).toBe(200);
    const catalog = await response.json() as { models: { slug: string }[] };
    const row = catalog.models.find(entry => entry.slug === model);
    const generated = await generate(headers, model, requested);
    const body = await generated.text();
    expect(generated.status, body).toBe(rejects === undefined ? 200 : 400);
    await flushBackground();
    if (rejects === 'gateway') {
      expect(sent).toEqual([]);
      expect(JSON.parse(body)).toMatchObject({ error: { param: 'service_tier', code: 'unsupported_value' } });
      expect(await repo.performance.listAll()).toEqual([]);
    } else {
      expect(sent).toHaveLength(1);
      expect(sent[0]).toHaveProperty('model', model);
      if (requested === undefined) expect(sent[0]).not.toHaveProperty('service_tier');
      else expect(sent[0]).toHaveProperty('service_tier', requested);
      if (rejects === 'upstream') {
        expect(generated.headers.get('x-request-id')).toBe('upstream-tier-error');
        expect(body).toBe(upstreamTierError);
      }
      expect((await repo.performance.listAll()).map(r => r.requestedServiceTier)).toEqual([requested]);
    }
    expect(row).toMatchObject({ service_tiers: listed, additional_speed_tiers: listed.some(tier => tier.id === 'priority') ? ['fast'] : [] });
    expect((await repo.upstreams.getById('up_chatgpt'))?.serviceTierPolicy).toEqual(policy ?? null);
  });
});

test('ChatGPT alias fallback preserves the same tier after an upstream rejects it', async () => {
  const { repo, headers } = await setup('plus', null);
  await repo.modelAliases.insert({
    id: 'alias_policy', name: 'retry-ultrafast', kind: 'chat', selection: 'first-available',
    targets: [astra, sol].map(target_model_id => ({ target_model_id, rules: { serviceTier: 'ultrafast' } })),
    displayName: null, visibleInModelsList: true, announcedMetadata: null, sortOrder: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const sent: Record<string, unknown>[] = [];
  await withMockedFetch(chatgptFetch(sent), async () => {
    await warmModelsForTest();
    const response = await generate(headers, 'retry-ultrafast');
    expect(response.status, await response.text()).toBe(200);
    await flushBackground();
  });
  expect(sent.map(body => body.model)).toEqual([astra, sol]);
  expect(sent.map(body => body.service_tier)).toEqual(['ultrafast', 'ultrafast']);
});

test('ChatGPT compact rejects a disallowed tier before calling the provider', async () => {
  const { repo, headers } = await setup('plus', { enabled: false, tiers: [] });
  const sent: Record<string, unknown>[] = [];
  await withMockedFetch(chatgptFetch(sent), async () => {
    await warmModelsForTest();
    const response = await generate(headers, sol, 'priority', true);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { param: 'service_tier', code: 'unsupported_value' } });
    await flushBackground();
  });
  expect(sent).toEqual([]);
  expect(await repo.performance.listAll()).toEqual([]);
});
