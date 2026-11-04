import { expect, test } from 'vitest';

import { openaiResponsesAttempt } from '../../../../src/data-plane/chat/openai-responses/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { buildCodexUpstreamRecord } from '../../../test-utils/app.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { initProviderRepo, type ServiceTierPolicy } from '@floway-dev/provider';
import { assertCodexUpstreamState, codexProviderModule } from '@floway-dev/provider-codex';
import { sseResponse, stubModelCandidate, withMockedFetch } from '@floway-dev/test-utils';

const cases: {
  name: string;
  plan: string;
  policy: ServiceTierPolicy | null;
  requested?: string;
  aliasTier?: string;
  tokenPlan?: string;
  quotaPlan?: string;
  expected?: string;
}[] = [
  { name: 'paid default', plan: 'plus', policy: null, requested: 'priority', expected: 'priority' },
  { name: 'free default', plan: 'free', policy: null, requested: 'priority' },
  { name: 'unknown default', plan: 'future', policy: null, requested: 'priority' },
  { name: 'explicit off', plan: 'pro', policy: { enabled: false, tiers: ['priority'] }, requested: 'priority' },
  { name: 'explicit open-string override', plan: 'future', policy: { enabled: true, tiers: ['vendor/Tier'] }, requested: 'vendor/Tier', expected: 'vendor/Tier' },
  { name: 'unlisted tier', plan: 'pro', policy: null, requested: 'flex' },
  { name: 'missing tier is not injected', plan: 'pro', policy: null },
  { name: 'alias tier uses the same default', plan: 'pro', policy: null, aliasTier: 'priority', expected: 'priority' },
  { name: 'new token overrides imported plan', plan: 'pro', tokenPlan: 'free', policy: null, requested: 'priority' },
  { name: 'newest quota overrides token', plan: 'free', tokenPlan: 'free', quotaPlan: 'plus', policy: null, requested: 'priority', expected: 'priority' },
];

test.each(cases)('Floway native attempt resolves Codex service tier policy: $name', async ({ plan, policy, requested, aliasTier, tokenPlan, quotaPlan, expected }) => {
  const upstream = buildCodexUpstreamRecord({
    config: { accounts: [{ email: 'codex@example.invalid', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: plan }] },
    serviceTierPolicy: policy,
  });
  assertCodexUpstreamState(upstream.state);
  const account = upstream.state.accounts[0]!;
  if (tokenPlan !== undefined) account.accessToken = { ...account.accessToken!, planType: tokenPlan, planObservedAt: '2026-11-01T00:00:00Z' };
  if (quotaPlan !== undefined) account.quotaSnapshot = {
    codex: { fetchedAt: Date.parse('2026-11-02T00:00:00Z'), data: { plan_type: quotaPlan, observed_at: '2026-11-02T00:00:00Z' } },
  };
  initRepo(new InMemoryRepo());
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: { getById: async () => upstream, saveState: async () => {} },
  }));
  const candidate = {
    ...stubModelCandidate({
      provider: codexProviderModule.create(upstream),
      model: { id: 'gpt-5.4', endpoints: { openaiResponses: {} } },
    }),
    rules: aliasTier === undefined ? {} : { serviceTier: aliasTier },
  };
  const sent: Record<string, unknown>[] = [];
  const background: Promise<unknown>[] = [];
  const ctx = mockChatGatewayCtx({ backgroundScheduler: promise => { background.push(promise); } });

  await withMockedFetch(async request => {
    expect(new URL(request.url).pathname).toBe('/backend-api/codex/responses');
    sent.push(await request.json() as Record<string, unknown>);
    return sseResponse(`event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_policy', object: 'response', model: 'gpt-5.4', status: 'completed', output: [], error: null, incomplete_details: null },
    })}\n\n`);
  }, async () => {
    const result = await openaiResponsesAttempt.generate({
      payload: { model: 'gpt-5.4', input: [{ type: 'message', role: 'user', content: 'local policy test' }], ...(requested === undefined ? {} : { service_tier: requested }) },
      ctx,
      candidate,
      headers: new Headers(),
    });
    if (result.type !== 'events') throw new Error(`Expected Codex events, received ${result.type}`);
    const frames = await Array.fromAsync(result.events);
    expect(frames.some(frame => frame.type === 'event' && frame.event.type === 'response.completed')).toBe(true);
    expect((await result.finalMetadata)?.performance?.requestedServiceTier).toBe(expected);
    await Promise.all(background);
  });

  expect(sent).toHaveLength(1);
  if (expected === undefined) expect(sent[0]).not.toHaveProperty('service_tier');
  else expect(sent[0]).toHaveProperty('service_tier', expected);
  expect(upstream.serviceTierPolicy).toEqual(policy);
});
