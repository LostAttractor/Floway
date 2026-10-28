import { expect, test } from 'vitest';

import { openaiResponsesAttempt } from '../../../../src/data-plane/chat/openai-responses/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { buildCopilotUpstreamRecord } from '../../../test-utils/app.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { initProviderRepo, type ServiceTierPolicy } from '@floway-dev/provider';
import { clearInProcessCopilotTokenCache, copilotProviderModule } from '@floway-dev/provider-copilot';
import { sseResponse, stubModelCandidate, withMockedFetch } from '@floway-dev/test-utils';

const modelId = 'gpt-5.6-sol';
const fastModelId = `${modelId}-fast`;

const cases: { name: string; policy: ServiceTierPolicy | null; model: string; expectedModel: string; requestedServiceTier?: string }[] = [
  { name: 'missing policy', policy: null, model: modelId, expectedModel: modelId },
  { name: 'disabled policy', policy: { enabled: false, tiers: ['priority'] }, model: modelId, expectedModel: modelId },
  { name: 'unlisted tier', policy: { enabled: true, tiers: ['default'] }, model: modelId, expectedModel: modelId },
  { name: 'allowed priority', policy: { enabled: true, tiers: ['priority'] }, model: modelId, expectedModel: fastModelId, requestedServiceTier: 'priority' },
  { name: 'explicit raw variant', policy: null, model: fastModelId, expectedModel: fastModelId },
];

test.each(cases)('Floway native attempt applies policy before Copilot variant selection: $name', async ({ policy, model, expectedModel, requestedServiceTier }) => {
  const upstream = buildCopilotUpstreamRecord({
    token: 'ghu_test',
    user: { id: 1, login: 'tester', name: null, avatar_url: 'https://example.test/avatar.png' },
  }, {
    serviceTierPolicy: policy,
    state: {
      knownModels: null,
      copilotToken: {
        token: 'copilot-token',
        expiresAt: Date.now() + 3_600_000,
        baseUrl: 'https://copilot.example.test',
      },
    },
  });
  initRepo(new InMemoryRepo());
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: { getById: async () => upstream, saveState: async () => {} },
  }));
  clearInProcessCopilotTokenCache();
  const provider = copilotProviderModule.create(upstream);
  const candidate = {
    ...stubModelCandidate({
      provider,
      model: { id: model, endpoints: { openaiResponses: {} } },
      providerData: { rawModels: [modelId, fastModelId].map(id => ({ id, supported_endpoints: ['/responses'] })) },
    }),
    rules: { serviceTier: 'priority' },
  };
  const sent: unknown[] = [];
  const background: Promise<unknown>[] = [];
  const ctx = mockChatGatewayCtx({ backgroundScheduler: promise => { background.push(promise); } });

  await withMockedFetch(async request => {
    expect(request.url).toBe('https://copilot.example.test/responses');
    sent.push(await request.json());
    return sseResponse(`event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_policy', object: 'response', model: expectedModel, status: 'completed', output: [], error: null, incomplete_details: null },
    })}\n\n`);
  }, async () => {
    const result = await openaiResponsesAttempt.generate({
      payload: { model, input: [{ type: 'message', role: 'user', content: 'local policy test' }] },
      ctx,
      candidate,
      headers: new Headers(),
    });
    if (result.type !== 'events') throw new Error(`Expected Copilot events, received ${result.type}`);
    const frames = await Array.fromAsync(result.events);
    expect(frames.some(frame => frame.type === 'event' && frame.event.type === 'response.completed')).toBe(true);
    const metadata = await result.finalMetadata;
    expect(metadata?.modelIdentity.modelKey).toBe(expectedModel);
    expect(metadata?.performance?.requestedServiceTier).toBe(requestedServiceTier);
    expect(metadata?.performance).not.toHaveProperty('serviceTier');
    await Promise.all(background);
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ model: expectedModel, stream: true });
  expect(sent[0]).not.toHaveProperty('service_tier');
  expect(candidate.rules.serviceTier).toBe('priority');
});
