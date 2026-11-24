import { test } from 'vitest';

import { createCustomProvider } from '../src/provider.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, noopAnthropicMessagesUpstreamCallOptions, noopUpstreamCallOptions, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

interface BuildOptions {
  ingressHeadersRules?: { key: string; value: string | null }[];
  modelsFetchEnabled?: boolean;
  models?: UpstreamModelConfig[];
}

const buildCustomUpstream = (options: BuildOptions = {}): UpstreamRecord => ({
  id: 'up_custom',
  kind: 'custom',
  name: 'Custom Provider',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  serviceTierPolicy: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    apiKey: 'sk-test',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: options.ingressHeadersRules ?? [],
    modelsFetch: { enabled: options.modelsFetchEnabled ?? true, authStyle: 'bearer' },
    models: options.models ?? [],
  },
});

test('getProvidedModels returns only manual models and never fetches when modelsFetch is disabled', async () => {
  const record = buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [
      {
        upstreamModelId: 'manual-only',
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
        display_name: 'Manual Only',
        chat: { image_detail_original: true },
      },
    ],
  });
  const instance = createCustomProvider(record);

  let fetchCalls = 0;
  await withMockedFetch(
    () => {
      fetchCalls++;
      return jsonResponse({ object: 'list', data: [{ id: 'should-not-appear' }] });
    },
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'manual-only');
      assertEquals(models[0].upstreamModelId, 'manual-only');
      assertEquals(models[0].opaqueBlobCompatibilityScope, { bindToUpstream: true });
      assertEquals(models[0].chat, { image_detail_original: true });
    },
  );
  assertEquals(fetchCalls, 0);
});

test('custom discovery preserves tier declarations on discovered and manually named models', async () => {
  const provider = createCustomProvider(buildCustomUpstream({
    models: [{ upstreamModelId: 'manual', kind: 'chat', endpoints: { openaiResponses: {} } }],
  }));
  const models = await withMockedFetch(
    () => jsonResponse({
      data: [
        { id: 'manual', service_tiers: ['priority'] },
        { id: 'discovered', service_tiers: ['vendor/Turbo'] },
        { id: 'empty', service_tiers: [] },
        { id: 'unknown' },
      ],
    }),
    () => provider.instance.getProvidedModels(directFetcher),
  );
  const declared = (id: string) => provider.modelServiceTiers!(models.find(model => model.id === id)!, 'openaiResponses');
  assertEquals(declared('manual'), [{ id: 'priority' }]);
  assertEquals(declared('discovered'), [{ id: 'vendor/Turbo' }]);
  assertEquals(declared('empty'), []);
  assertEquals(declared('unknown'), undefined);
  const { serviceTiers: _, ...legacy } = models[0];
  assertEquals(provider.modelServiceTiers!(legacy, 'openaiResponses'), undefined);
});

test('A manual model whose upstreamModelId matches an auto-fetched id overrides the auto entry', async () => {
  const manualPricing: ModelPricing = { entries: [{ rates: { input_tokens: '1', output_tokens: '2' } }] };
  const record = buildCustomUpstream({
    models: [
      {
        upstreamModelId: 'shared-id',
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
        display_name: 'Manual Override',
        pricing: manualPricing,
      },
    ],
  });
  const instance = createCustomProvider(record);

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [
        { id: 'shared-id', display_name: 'Auto Version', pricing: { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] } },
        { id: 'auto-only' },
      ],
    }),
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(models.map(m => m.id), ['shared-id', 'auto-only']);
      assertEquals(models[0].display_name, 'Manual Override');
      assertEquals(models[0].pricing, manualPricing);
    },
  );
});

test('a manual model without explicit pricing inherits pricing from its shadowed auto row', async () => {
  const inheritedPricing: ModelPricing = { entries: [{ rates: { input_tokens: '3', output_tokens: '12' } }] };
  const instance = createCustomProvider(buildCustomUpstream({
    models: [{ upstreamModelId: 'shared-id', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
  }));

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{ id: 'shared-id', pricing: inheritedPricing }],
    }),
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(models.length, 1);
      assertEquals(models[0]?.id, 'shared-id');
      assertEquals(models[0]?.pricing, inheritedPricing);
    },
  );
});

test('auto-fetched rerank models stay out of the routable provider catalog', async () => {
  const instance = createCustomProvider(buildCustomUpstream());
  const models = await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'auto-reranker', kind: 'rerank' }, { id: 'chat-model', kind: 'chat' }] }),
    async () => await instance.instance.getProvidedModels(directFetcher),
  );
  assertEquals(models.map(model => model.id), ['chat-model']);
});

test('callRerank uses the model target protocol, raw model id, and canonical path', async () => {
  const instance = createCustomProvider(buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [{
      upstreamModelId: 'raw-reranker',
      publicModelId: 'public-reranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }],
  }));
  const [model] = await instance.instance.getProvidedModels(directFetcher);
  assertExists(model);
  let requestUrl: string | undefined;
  let requestBody: unknown;
  await withMockedFetch(
    async request => {
      requestUrl = request.url;
      requestBody = await request.json();
      return jsonResponse({ results: [] });
    },
    async () => {
      const result = await instance.instance.callRerank(
        model,
        parseRerankRequest('cohere-v1', { model: 'public-reranker', query: 'query', documents: ['one'], top_n: 1 }).request,
        undefined,
        noopUpstreamCallOptions(),
      );
      assertEquals(result.target, { protocol: 'cohere-v2' });
      assertEquals(result.modelKey, 'raw-reranker');
    },
  );
  assertEquals(requestUrl, 'https://custom.example.com/v2/rerank');
  assertEquals(requestBody, { model: 'raw-reranker', query: 'query', documents: ['one'], top_n: 1 });
});

test('Custom provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const provider = createCustomProvider(buildCustomUpstream()).instance;
  const bodies: Record<string, Record<string, unknown>> = {};
  const betas: Record<string, string | null> = {};

  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'echo', object: 'model' }] });
      }

      bodies[path] = (await request.json()) as Record<string, unknown>;
      betas[path] = request.headers.get('anthropic-beta');
      if (path === '/v1/chat/completions' || path === '/v1/responses' || path === '/v1/messages') {
        return sseResponse();
      }
      if (path === '/v1/messages/count_tokens') return jsonResponse({ input_tokens: 1 });
      if (path === '/v1/embeddings') return jsonResponse({ object: 'list', data: [], model: 'echo' });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels(directFetcher);
      assertExists(model);
      const opts = noopUpstreamCallOptions();
      const anthropicMessagesOpts = noopAnthropicMessagesUpstreamCallOptions({ anthropicBeta: ['context-1m', 'advanced-tool-use'] });
      await provider.callOpenAIChatCompletions(model, { messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await provider.callOpenAIResponses(model, { input: [] }, 'generate', undefined, opts);
      await provider.callAnthropicMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, anthropicMessagesOpts);
      await provider.callAnthropicMessagesCountTokens(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, anthropicMessagesOpts);
      await provider.callOpenAIEmbeddings(model, { input: 'hi' }, undefined, opts);
    },
  );

  assertEquals(bodies['/v1/chat/completions'].stream, true);
  assertEquals(bodies['/v1/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/v1/embeddings'], false);
  assertEquals(betas['/v1/messages'], 'context-1m,advanced-tool-use');
  assertEquals(betas['/v1/messages/count_tokens'], 'context-1m,advanced-tool-use');
  assertEquals(betas['/v1/chat/completions'], null);
});

test.each(['generate', 'compact'] as const)('Custom %s preserves response service_tier without token usage', async action => {
  const provider = createCustomProvider(buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [{ upstreamModelId: 'raw-model', kind: 'chat', endpoints: { openaiResponses: {} } }],
  })).instance;
  const [model] = await provider.getProvidedModels(directFetcher);
  for (const service_tier of [undefined, null, 'default', 'priority', 'future_tier']) {
    const raw = { id: 'resp_tier', object: action === 'compact' ? 'response.compaction' : 'response', model: 'raw-model', status: 'completed', output: [], error: null, incomplete_details: null, service_tier };
    await withMockedFetch(
      request => {
        assertEquals(new URL(request.url).pathname.endsWith(action === 'compact' ? '/responses/compact' : '/responses'), true);
        return Promise.resolve(action === 'compact'
          ? new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } })
          : new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: raw })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
      },
      async () => {
        const result = await provider.callOpenAIResponses(model, { input: [], service_tier: 'flex' }, action, undefined, noopUpstreamCallOptions());
        if (!result.ok) throw new Error('expected successful response');
        const response = result.action === 'generate'
          ? await collectOpenAIResponsesProtocolEventsToResult(result.events)
          : result.result;
        assertEquals(response.service_tier, service_tier);
      },
    );
  }
});
