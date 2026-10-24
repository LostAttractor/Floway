import { expect, test } from 'vitest';

import { eventResult } from '../src/result.ts';
import { streamingProviderCall, type ProviderStreamParser } from '../src/streaming.ts';
import { observeServiceTier, type ResponseTelemetry } from '../src/telemetry.ts';
import { anthropicMessagesServiceTier, parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';

const observe = async (parser: ProviderStreamParser<unknown>, events: readonly unknown[]) => {
  const wire = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const result = await streamingProviderCall(Promise.resolve(new Response(wire, {
    headers: { 'content-type': 'text/event-stream' },
  })), parser, 'model', undefined);
  if (!result.ok) throw new Error('Expected a parsed upstream stream');
  const observed: (string | undefined)[] = [];
  for await (const _frame of result.events) observed.push(result.responseTelemetry.serviceTier);
  return observed;
};

test.each([
  ['default', 'default'],
  ['standard', 'standard'],
  ['vendor/custom', 'vendor/custom'],
  [null, undefined],
  ['', undefined],
] as const)('raw Responses observations preserve absence and explicitly replace with %s', async (tier, expected) => {
  expect(await observe(parseOpenAIResponsesStream, [
    { type: 'response.created', response: { service_tier: 'priority' } },
    { type: 'response.in_progress', response: {} },
    { type: 'response.in_progress', response: { service_tier: tier } },
  ])).toEqual(['priority', 'priority', expected]);
});

test('raw Chat Completions tier does not require token usage', async () => {
  expect(await observe(parseOpenAIChatCompletionsStream, [
    { choices: [], service_tier: 'priority' },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
    { choices: [], service_tier: 'default' },
    { choices: [], service_tier: null },
  ])).toEqual(['priority', 'priority', 'default', undefined]);
});

test('raw Messages speed survives usage-only deltas and explicit standard/null replaces it', async () => {
  expect(await observe(parseAnthropicMessagesStream, [
    { type: 'message_start', message: { usage: { speed: 'fast', service_tier: 'standard' } } },
    { type: 'message_delta', usage: { output_tokens: 2 } },
    { type: 'message_delta', usage: { speed: 'standard' } },
    { type: 'message_delta', usage: { speed: null } },
  ])).toEqual(['fast', 'fast', 'standard', undefined]);
  expect(await observe(parseAnthropicMessagesStream, [
    { type: 'message_start', message: { usage: { service_tier: 'priority' } } },
    { type: 'message_delta', usage: { service_tier: '' } },
  ])).toEqual(['priority', undefined]);
});

test('Messages request intent preserves open speed and service tier strings', () => {
  expect(anthropicMessagesServiceTier({ speed: 'vendor-fast', service_tier: 'auto' })).toBe('vendor-fast');
  expect(anthropicMessagesServiceTier({ service_tier: 'standard_only' })).toBe('standard_only');
  expect(anthropicMessagesServiceTier({ speed: null, service_tier: 'auto' })).toBeNull();
});

test('raw observation state is per call and retains the last observation on parser failure', async () => {
  const failure = new Error('broken upstream frame');
  const result = await streamingProviderCall(Promise.resolve(new Response('wire', {
    headers: { 'content-type': 'text/event-stream' },
  })), async function* (_body, options) {
    options?.onServiceTier?.('priority');
    yield { type: 'event', event: { type: 'observed' } } as const;
    throw failure;
  }, 'model', undefined);
  if (!result.ok) throw new Error('Expected stream');
  await expect(Array.fromAsync(result.events)).rejects.toBe(failure);
  expect(result.responseTelemetry).toEqual({ serviceTier: 'priority' });
  expect(await observe(parseOpenAIChatCompletionsStream, [{ choices: [] }])).toEqual([undefined]);
});

test('observation rejects invalid wire values and event adapters preserve state identity', () => {
  const telemetry: ResponseTelemetry = {};
  expect(() => observeServiceTier(telemetry, 123 as unknown as string)).toThrow(TypeError);
  const result = eventResult((async function* () {})(), { model: 'model', modelKey: 'model', upstream: 'upstream', pricing: null }, { responseTelemetry: telemetry });
  expect(result.responseTelemetry).toBe(telemetry);
  observeServiceTier(telemetry, 'priority');
  expect(result.responseTelemetry?.serviceTier).toBe('priority');
});
