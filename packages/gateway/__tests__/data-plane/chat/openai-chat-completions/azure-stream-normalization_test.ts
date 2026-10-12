import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { respondOpenAIChatCompletions } from '../../../../src/data-plane/chat/openai-chat-completions/respond.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { directFetcher, eventResult, type UpstreamRecord } from '@floway-dev/provider';
import { azureProviderModule } from '@floway-dev/provider-azure';
import { noopUpstreamCallOptions, sseResponse, testTelemetryModelIdentity, withMockedFetch } from '@floway-dev/test-utils';

const azureRecord: UpstreamRecord = {
  id: 'azure-stream-test',
  kind: 'azure',
  name: 'Azure stream test',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'test-key',
    models: [{
      upstreamModelId: 'gpt-deployment',
      publicModelId: 'gpt-public',
      endpoints: { openaiChatCompletions: {} },
    }],
  },
};

const azureChunks = [
  {
    id: '', object: '', created: 0, model: '', choices: [], usage: null,
    prompt_filter_results: [{ prompt_index: 0, content_filter_results: { hate: { filtered: false, severity: 'safe' } } }],
  },
  {
    id: 'chatcmpl-azure', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'gpt-deployment', usage: null,
    choices: [{ index: 0, delta: { content: 'A' }, finish_reason: null }],
  },
  {
    id: '', object: '', created: 0, model: '', usage: null,
    choices: [{ index: 0, finish_reason: null, content_filter_results: { hate: { filtered: false, severity: 'safe' } } }],
  },
  {
    id: 'chatcmpl-azure', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'gpt-deployment', usage: null,
    choices: [{ index: 0, delta: { content: 'B' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-azure', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'gpt-deployment', usage: null,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  {
    id: '', object: '', created: 0, model: '', usage: null,
    choices: [{ index: 0, finish_reason: null, content_filter_results: { hate: { filtered: true, severity: 'high' } } }],
  },
  {
    id: 'chatcmpl-azure', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'gpt-deployment',
    choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  },
];

test('Azure ChatCompletions normalization preserves extensions in native SSE output', async () => {
  const body = `${azureChunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  const provider = azureProviderModule.create(azureRecord);
  const [model] = await provider.instance.getProvidedModels(directFetcher);
  let responseText = '';

  await withMockedFetch(
    () => sseResponse(body),
    async () => {
      const result = await provider.instance.callOpenAIChatCompletions(model, { messages: [{ role: 'user', content: 'question' }] }, undefined, noopUpstreamCallOptions());
      if (!result.ok) throw new Error('Expected Azure ChatCompletions stream response');

      const app = new Hono().get('/', c => respondOpenAIChatCompletions(
        c,
        eventResult(result.events, testTelemetryModelIdentity),
        true,
        {},
        mockChatGatewayCtx({ wantsStream: true }),
      ));
      responseText = await (await app.request('/')).text();
    },
  );

  const events = responseText
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice('data: '.length)) as Record<string, any>);
  const promptAnnotationEvent = events.find(event => event.prompt_filter_results !== undefined);
  const filterAnnotationChoices = events.flatMap(event => event.choices ?? []).filter(choice => choice.content_filter_results !== undefined);

  expect(promptAnnotationEvent?.prompt_filter_results).toEqual(azureChunks[0].prompt_filter_results);
  expect(filterAnnotationChoices).toHaveLength(2);
  expect(filterAnnotationChoices.map(choice => choice.delta)).toEqual([{}, {}]);
  expect(events.every(event => event.id === 'chatcmpl-azure'
    && event.object === 'chat.completion.chunk'
    && event.created === 1_700_000_000
    && event.model === 'gpt-deployment')).toBe(true);
  expect(responseText).toContain('data: [DONE]');
  expect(responseText).not.toContain('event: error');
});
