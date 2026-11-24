// Each helper applies rules in the selected target protocol. A fixed service
// tier permits an equivalent request tier and rejects a conflicting one.

import { expect, test } from 'vitest';

import { applyRulesToUpstreamGeminiGenerateContent, applyRulesToUpstreamAnthropicMessages, applyRulesToUpstreamOpenAIResponses } from '../../../../src/data-plane/chat/shared/alias-rules.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const resPayload = (overrides: Partial<OpenAIResponsesPayloadEx> = {}): OpenAIResponsesPayloadEx => ({
  model: 'gpt-5.4',
  input: 'hi',
  ...overrides,
});

const msgPayload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'claude-opus-4-7',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

test('responses: alias rules retain reasoning.context and the equivalent service tier', () => {
  const body = resPayload({
    reasoning: { effort: 'low', summary: 'auto', context: 'future_mode' },
    service_tier: 'fast',
    text: { verbosity: 'high' },
  });
  applyRulesToUpstreamOpenAIResponses(body, {
    reasoning: { effort: 'xhigh', summary: 'detailed' },
    verbosity: 'low',
    serviceTier: 'priority',
  });
  assertEquals(body.reasoning, { effort: 'xhigh', summary: 'detailed', context: 'future_mode' });
  assertEquals(body.text?.verbosity, 'low');
  assertEquals(body.service_tier, 'fast');
});

test('messages: summary updates display without changing enabled thinking', () => {
  const body = msgPayload();
  body.thinking = { type: 'enabled', budget_tokens: 2048 };
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { summary: 'concise' } });
  assertEquals(body.thinking, { type: 'enabled', budget_tokens: 2048, display: 'summarized' });
});

test('messages: adaptive=true strips a client-set budget_tokens from body.thinking', () => {
  const body = msgPayload();
  body.thinking = { type: 'enabled', budget_tokens: 5000 };
  applyRulesToUpstreamAnthropicMessages(body, { reasoning: { adaptive: true } });
  assertEquals(body.thinking?.type, 'adaptive');
  // The prior client budget must not leak into the adaptive block — adaptive
  // auto-determines the budget and a sibling budget_tokens violates the
  // rules-are-authoritative contract.
  assertEquals((body.thinking as { budget_tokens?: number }).budget_tokens, undefined);
});

test.each([
  { request: { service_tier: 'flex' }, alias: 'fast', field: 'service_tier' },
  { request: { speed: 'fast' }, alias: 'flex', field: 'speed' },
])('messages: an alias conflicting with $field rejects the candidate', ({ request, alias }) => {
  const body = msgPayload(request);
  expect(() => applyRulesToUpstreamAnthropicMessages(body, { serviceTier: alias })).toThrow('The model alias requires service tier');
  assertEquals(body, msgPayload(request));
});

test('messages: equivalent speed preserves the independent scheduling tier', () => {
  const body = msgPayload({ speed: 'fast', service_tier: 'auto' });
  applyRulesToUpstreamAnthropicMessages(body, { serviceTier: 'priority' });
  assertEquals(body.speed, 'fast');
  assertEquals(body.service_tier, 'auto');
});

const geminiPayload = (overrides: Partial<GeminiGenerateContentPayload> = {}): GeminiGenerateContentPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  ...overrides,
});

test('gemini: none disables thinking through a zero budget because there is no level for it', () => {
  const body = geminiPayload({ generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } });
  applyRulesToUpstreamGeminiGenerateContent(body, { reasoning: { effort: 'none' } });
  assertEquals(body.generationConfig?.thinkingConfig, { thinkingBudget: 0 });
});

test('gemini: a budget replaces a client-stated level rather than joining it', () => {
  const body = geminiPayload({ generationConfig: { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } } });
  applyRulesToUpstreamGeminiGenerateContent(body, { reasoning: { budget_tokens: 2048 } });
  assertEquals(body.generationConfig?.thinkingConfig, { includeThoughts: true, thinkingBudget: 2048 });
});

test('gemini: a known effort takes the uppercase wire level while a vendor-specific one travels verbatim', () => {
  const known = geminiPayload();
  applyRulesToUpstreamGeminiGenerateContent(known, { reasoning: { effort: 'xhigh' } });
  assertEquals(known.generationConfig?.thinkingConfig, { thinkingLevel: 'XHIGH' });
  const body = geminiPayload();
  applyRulesToUpstreamGeminiGenerateContent(body, {
    reasoning: { effort: 'turbo', adaptive: true, summary: 'detailed' },
    verbosity: 'low',
  });
  assertEquals(body.generationConfig?.thinkingConfig, { thinkingLevel: 'turbo' });
});

test('gemini: the fast serviceTier alias takes the priority spelling the wire accepts', () => {
  const body = geminiPayload();
  applyRulesToUpstreamGeminiGenerateContent(body, { serviceTier: 'fast' });
  assertEquals(body.serviceTier, 'priority');
});
