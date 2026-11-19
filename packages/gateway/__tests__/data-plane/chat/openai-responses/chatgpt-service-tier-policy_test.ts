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

const chatgptFetch = (sent: Record<string, unknown>[], rejectModel?: string) => async (request: Request) => {
  const url = new URL(request.url);
  if (url.hostname === 'raw.githubusercontent.com') return new Response(null, { status: 404 });
  if (url.pathname === '/backend-api/codex/models') return jsonResponse({ models });
  expect(url.pathname).toBe('/backend-api/codex/responses');
  const body = await request.json() as Record<string, unknown>;
  sent.push(body);
  if (rejectModel !== undefined && body.model === rejectModel) return new Response('Temporarily unavailable', { status: 503 });
  return sseOpenAIResponsesResponse({
    id: 'resp_policy', object: 'response', model: body.model, status: 'completed', output: [],
    error: null, incomplete_details: null, usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
  });
};

const generate = async (headers: HeadersInit, model: string, service_tier?: string) => {
  const result = await requestApp('/v1/responses', {
    method: 'POST', headers, body: JSON.stringify({ model, input: 'local policy test', service_tier }),
  });
  expect(result.status, await result.text()).toBe(200);
  await flushBackground();
};

const cases: {
  name: string;
  model: string;
  plan?: string;
  policy?: ServiceTierPolicy;
  listed: typeof priority[];
  requested?: string;
  forwarded?: string;
}[] = [
  { name: 'Sol Fast on a free plan', model: sol, plan: 'free', listed: [priority, ultrafast], requested: 'priority', forwarded: 'priority' },
  { name: 'Sol Ultrafast', model: sol, listed: [priority, ultrafast], requested: 'ultrafast', forwarded: 'ultrafast' },
  { name: 'Astra Fast', model: astra, listed: [priority], requested: 'priority', forwarded: 'priority' },
  { name: 'Astra pricing does not grant Ultrafast', model: astra, listed: [priority], requested: 'ultrafast' },
  { name: 'new model and tier on an unknown plan', model: 'future-model', plan: 'future', listed: [future], requested: future.id, forwarded: future.id },
  { name: 'legacy Fast maps to priority', model: 'legacy', listed: [{ id: 'priority', name: 'Fast', description: '' }], requested: 'priority', forwarded: 'priority' },
  { name: 'empty service_tiers supersedes legacy Fast', model: 'empty', listed: [], requested: 'priority' },
  { name: 'no tier fields on a paid plan', model: 'gpt-5.5', listed: [], requested: 'priority' },
  { name: 'no request tier is injected', model: sol, listed: [priority, ultrafast] },
  { name: 'explicit off overrides Sol', model: sol, policy: { enabled: false, tiers: ['ultrafast'] }, listed: [], requested: 'ultrafast' },
  { name: 'manual allowlist replaces inheritance without advertising an unavailable tier', model: astra, policy: { enabled: true, tiers: ['ultrafast'] }, listed: [], requested: 'ultrafast', forwarded: 'ultrafast' },
  { name: 'manual allowlist excludes the inherited tier', model: astra, policy: { enabled: true, tiers: ['ultrafast'] }, listed: [], requested: 'priority' },
];

test.each(cases)('ChatGPT catalog, upstream request and telemetry: $name', async ({ model, plan = 'plus', policy, listed, requested, forwarded }) => {
  const { repo, headers } = await setup(plan, policy ?? null);
  const sent: Record<string, unknown>[] = [];
  await withMockedFetch(chatgptFetch(sent), async () => {
    await warmModelsForTest();
    const response = await requestApp('/models', { headers: { ...headers, 'user-agent': 'codex_cli_rs/0.169.0' } });
    expect(response.status).toBe(200);
    const catalog = await response.json() as { models: { slug: string }[] };
    const row = catalog.models.find(entry => entry.slug === model);
    await generate(headers, model, requested);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveProperty('model', model);
    if (forwarded === undefined) expect(sent[0]).not.toHaveProperty('service_tier');
    else expect(sent[0]).toHaveProperty('service_tier', forwarded);
    expect(row).toMatchObject({ service_tiers: listed, additional_speed_tiers: listed.some(tier => tier.id === 'priority') ? ['fast'] : [] });
    expect((await repo.performance.listAll()).map(r => r.requestedServiceTier)).toEqual([forwarded]);
    expect((await repo.upstreams.getById('up_chatgpt'))?.serviceTierPolicy).toEqual(policy ?? null);
  });
});

test('ChatGPT alias fallback re-evaluates the pinned tier against each target model', async () => {
  const { repo, headers } = await setup('plus', null);
  await repo.modelAliases.insert({
    id: 'alias_policy', name: 'retry-ultrafast', kind: 'chat', selection: 'first-available',
    targets: [astra, sol].map(target_model_id => ({ target_model_id, rules: { serviceTier: 'ultrafast' } })),
    displayName: null, visibleInModelsList: true, announcedMetadata: null, sortOrder: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const sent: Record<string, unknown>[] = [];
  await withMockedFetch(chatgptFetch(sent, astra), async () => {
    await warmModelsForTest();
    await generate(headers, 'retry-ultrafast');
  });
  expect(sent.map(body => body.model)).toEqual([astra, sol]);
  expect(sent[0]).not.toHaveProperty('service_tier');
  expect(sent[1]).toHaveProperty('service_tier', 'ultrafast');
});
