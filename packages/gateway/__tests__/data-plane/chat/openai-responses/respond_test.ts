import { Hono } from 'hono';
import { beforeEach, expect, test } from 'vitest';

import { respondOpenAIResponses, respondOpenAIResponsesFailure } from '../../../../src/data-plane/chat/openai-responses/respond.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER } from '../../../../src/data-plane/chat/openai-responses/response-headers.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, parseOpenAIResponsesStream, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { eventResult, internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

beforeEach(() => { initRepo(new InMemoryRepo()); });

const internalFailure = () => {
  const cause = new TypeError('nested'); cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause }); failure.stack = 'Error: broken\n  at render';
  return failure;
};

const fields = { name: 'Error', stack: 'Error: broken\n  at render', cause: { name: 'TypeError', message: 'nested', stack: 'TypeError: nested\n  at nested' } };

const successfulFrames = async function* () {
  const response = {
    id: 'resp_test',
    object: 'response' as const,
    model: 'm',
    status: 'completed' as const,
    output: [],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', response: { ...response, status: 'in_progress' } });
  yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.completed', response });
};

test.each([false, true])('Responses success declares historical reasoning accounting when stream=%s', async wantsStream => {
  const upstreamHeaders = new Headers({ 'x-reasoning-included': 'upstream-value', 'x-native': 'trace' });
  const app = new Hono().get('/', c => respondOpenAIResponses(
    c,
    eventResult(successfulFrames(), testTelemetryModelIdentity, { headers: upstreamHeaders }),
    wantsStream,
    mockChatGatewayCtx(),
    { model: 'm', input: [] },
  ));
  const response = await app.request('/');
  expect(response.status).toBe(200);
  expect(response.headers.get(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER)).toBe('true');
  expect(response.headers.get('x-native')).toBe('trace');
  await response.body?.cancel();
});

test('Responses HTTP internal errors keep status and native error fields while namespacing diagnostics', async () => {
  const response = respondOpenAIResponsesFailure(internalErrorResult(503, toInternalDebugError(internalFailure(), 'anthropicMessages')), mockChatGatewayCtx());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { type: 'internal_error', message: 'broken', provider_specific_fields: { ...fields, target_api: 'anthropicMessages' } } });
  const minimal = respondOpenAIResponsesFailure(internalErrorResult(502, { type: 'internal_error', name: 'Error', message: 'minimal' }), mockChatGatewayCtx());
  expect(await minimal.json()).toEqual({ error: { type: 'internal_error', message: 'minimal', provider_specific_fields: { name: 'Error' } } });
});

test('Responses SSE standalone error and failed response carry identical complete diagnostics', async () => {
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', response: { id: 'upstream', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } });
    throw internalFailure();
  };
  const app = new Hono().get('/', c => respondOpenAIResponses(c, eventResult(frames(), testTelemetryModelIdentity), true, mockChatGatewayCtx(), { model: 'm', input: [] }));
  const response = await app.request('/');
  expect(response.status).toBe(200);
  const wire = await response.text();
  const parsed = [];
  for await (const frame of parseOpenAIResponsesStream(new Response(wire).body!)) if (frame.type === 'event') parsed.push(frame.event);
  const error = parsed.find(event => event.type === 'error');
  const failed = parsed.find(event => event.type === 'response.failed');
  expect(error).toEqual({ type: 'error', sequence_number: 1, error: { code: 'internal_error', message: 'broken', provider_specific_fields: fields } });
  expect(failed).toBeDefined();
  if (failed?.type !== 'response.failed') throw new Error('Missing failed response');
  expect(failed.response.status).toBe('failed');
  expect(failed.response.error).toEqual((error as { error: unknown }).error);
  const terminalOnly = await collectOpenAIResponsesProtocolEventsToResult((async function* () { yield eventFrame(failed); })());
  expect(terminalOnly.error).toEqual(failed.response.error);
  await expect(collectOpenAIResponsesProtocolEventsToResult(parseOpenAIResponsesStream(new Response(wire).body!))).rejects.toThrow('Upstream SSE error');
});

test('Responses collect failures preserve nested causes in the HTTP error namespace', async () => {
  const app = new Hono().get('/', c => respondOpenAIResponses(c, eventResult((async function* () { throw internalFailure(); })(), testTelemetryModelIdentity), false, mockChatGatewayCtx(), { model: 'm', input: [] }));
  const response = await app.request('/');
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: { type: 'internal_error', message: 'broken', provider_specific_fields: fields } });
});

test('Responses native upstream HTTP error is forwarded without diagnostic restructuring', async () => {
  const raw = '{"error":{"message":"native","stack":"provider-owned","custom":true}}';
  const response = respondOpenAIResponsesFailure({ type: 'api-error', source: 'upstream', status: 429, headers: new Headers({ 'content-type': 'application/json', 'x-native': 'trace' }), body: new TextEncoder().encode(raw) }, mockChatGatewayCtx());
  expect(response.status).toBe(429);
  expect(response.headers.get('x-native')).toBe('trace');
  expect(response.headers.get(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER)).toBeNull();
  expect(await response.text()).toBe(raw);
});
