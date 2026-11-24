import { expect, test, vi } from 'vitest';

import { geminiGenerateContentAttempt } from '../../../../src/data-plane/chat/gemini-generate-content/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ModelEndpoints } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { decodeResponseBody, type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderInstance, type ProviderStreamResult, type ServiceTierPolicy, type UpstreamCallOptions } from '@floway-dev/provider';
import { assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_gemini_attempt_test';

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<GeminiGenerateContentPayload> = {}): GeminiGenerateContentPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  ...overrides,
});

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  serviceTierPolicy?: ServiceTierPolicy | null;
  callGeminiGenerateContent?: ProviderInstance['callGeminiGenerateContent'];
  callOpenAIResponses?: ProviderInstance['callOpenAIResponses'];
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<ProviderCallResult>;
  callGeminiGenerateContentCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callGeminiGenerateContent: overrides.callGeminiGenerateContent,
    callOpenAIResponses: overrides.callOpenAIResponses,
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
    callGeminiGenerateContentCountTokens: overrides.callGeminiGenerateContentCountTokens,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, serviceTierPolicy: overrides.serviceTierPolicy ?? null, modelsCache: null, instance: provider,
    },
    model: stubInternalModel(overrides.endpoints ? { endpoints: overrides.endpoints } : {}, upstream),
    fetcher: directFetcher,
  };
};

test('Gemini GenerateContent preserves the requested tier when translating to OpenAI Responses', async () => {
  installRepo();
  const callOpenAIResponses = vi.fn<ProviderInstance['callOpenAIResponses']>(async (_model, body) => {
    assertEquals(body.service_tier, 'vendor/priority');
    return { action: 'generate', ok: false, http: new Response('Unsupported tier', { status: 400 }), modelKey: 'k' };
  });
  const result = await geminiGenerateContentAttempt.generate({
    payload: makePayload({ serviceTier: 'vendor/priority' }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIResponses, endpoints: { openaiResponses: {} } }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
  assertEquals(result.performance?.requestedServiceTier, 'vendor/priority');
});

test('countTokens translates Gemini generateContent to Anthropic Messages count_tokens and reshapes to totalTokens envelope', async () => {
  installRepo();
  let upstreamBody: Record<string, unknown> | undefined;
  let callOptions: AnthropicMessagesUpstreamCallOptions | undefined;
  const callAnthropicMessagesCountTokens = vi.fn(async (_model, body, _signal, opts): Promise<ProviderCallResult> => {
    upstreamBody = body as Record<string, unknown>;
    callOptions = opts;
    return {
      http: new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
      modelKey: 'k',
    };
  });
  const result = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload({ systemInstruction: { parts: [{ text: 'system' }] } }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessagesCountTokens }),
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols' }),
  });

  assertEquals(result.type, 'plain');
  if (result.type !== 'plain') throw new Error('unreachable');
  assertEquals(result.http.status, 200);
  const body = JSON.parse(decodeResponseBody(result.body));
  assertEquals(body, { totalTokens: 42 });
  assertEquals(callOptions?.anthropicBeta, []);
  assertEquals(callOptions?.headers.has('anthropic-beta'), false);
  // The Anthropic Messages count_tokens body should never carry the translation-time
  // `stream: true` flag — that field belongs to the streaming path only.
  if (upstreamBody === undefined) throw new Error('upstreamBody not captured');
  assertEquals('stream' in upstreamBody, false);
});

test('countTokens accepts the upstream total_tokens dialect and refuses unknown shapes with a 502', async () => {
  installRepo();
  const totalTokensResp = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async () => ({
        http: new Response(JSON.stringify({ total_tokens: 19 }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
        modelKey: 'k',
      }),
    }),
    headers: new Headers(),
  });
  assertEquals(totalTokensResp.type, 'plain');
  if (totalTokensResp.type !== 'plain') throw new Error('unreachable');
  assertEquals(JSON.parse(decodeResponseBody(totalTokensResp.body)), { totalTokens: 19 });

  const unexpectedResp = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async () => ({
        http: new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
        modelKey: 'k',
      }),
    }),
    headers: new Headers(),
  });
  assertEquals(unexpectedResp.type, 'plain');
  if (unexpectedResp.type !== 'plain') throw new Error('unreachable');
  assertEquals(unexpectedResp.http.status, 502);
  const body = JSON.parse(decodeResponseBody(unexpectedResp.body));
  assertEquals(body.error.status, 'UNAVAILABLE');
});

test('generate dispatches natively when the candidate speaks Gemini generateContent', async () => {
  installRepo();
  let upstreamBody: unknown;
  const callGeminiGenerateContent = vi.fn(async (_model, body): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>> => {
    upstreamBody = body;
    return {
      ok: true,
      events: (async function* () {
        yield eventFrame<GeminiGenerateContentStreamEvent>({
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        });
      })(),
      modelKey: 'k',
      http: { status: 200, headers: new Headers({ 'x-goog-request-id': 'req_1' }) },
    };
  });
  const payload = makePayload({
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'lookup' }] }],
    safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
    contents: [{ role: 'user', parts: [{ text: 'hi' }, { fileData: { fileUri: 'gs://bucket/file.pdf' } }] }],
  });

  const result = await geminiGenerateContentAttempt.generate({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ endpoints: { geminiGenerateContent: {} }, callGeminiGenerateContent }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.http?.headers.get('x-goog-request-id'), 'req_1');
  // The native path must hand the upstream the client's payload unchanged: a
  // translated target strips file parts, non-function tool groups and safety
  // settings, none of which applies here.
  assertEquals(upstreamBody, payload);
  const events = await Array.fromAsync(result.events);
  assertEquals(events.length, 1);
  const metadata = await result.finalMetadata;
  assertEquals(metadata?.performance, result.performance);
  assertEquals(result.performance?.operation, 'chat');
  assertEquals(result.performance?.keyId, API_KEY_ID);
  assertEquals(metadata?.billableUsage, { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  assertEquals(callGeminiGenerateContent.mock.calls.length, 1);
});

test.each([
  [null, true],
  [{ enabled: false, tiers: ['future-tier'] }, false],
  [{ enabled: true, tiers: ['other'] }, false],
  [{ enabled: true, tiers: ['future-tier'] }, true],
] as const)('native Gemini calls check tier policy %j before dispatch', async (policy, allowed) => {
  installRepo();
  const bodies: unknown[] = [];
  const candidate = makeCandidate({
    endpoints: { geminiGenerateContent: {} },
    serviceTierPolicy: policy === null ? null : { ...policy, tiers: [...policy.tiers] },
    callGeminiGenerateContent: async (_model, body) => {
      bodies.push(body);
      return { ok: false, http: new Response('busy', { status: 503 }), modelKey: 'k' };
    },
    callGeminiGenerateContentCountTokens: async (_model, body) => {
      bodies.push(body);
      return { http: Response.json({ totalTokens: 7 }), modelKey: 'k' };
    },
  });
  const payload = makePayload({ serviceTier: 'future-tier' });
  const ctx = makeGatewayCtx();
  const args = { payload, ctx, candidate, headers: new Headers() };
  if (!allowed) {
    await expect(geminiGenerateContentAttempt.generate(args)).rejects.toMatchObject({ param: 'serviceTier' });
    await expect(geminiGenerateContentAttempt.countTokens(args)).rejects.toMatchObject({ param: 'serviceTier' });
    assertEquals(bodies, []);
    assertEquals(ctx.attempt.telemetry, undefined);
    return;
  }
  const result = await geminiGenerateContentAttempt.generate(args);
  assertEquals(result.type, 'api-error');
  assertEquals(result.performance?.requestedServiceTier, 'future-tier');
  assertEquals(result.performance?.operation, 'chat');
  assertEquals(ctx.attempt.telemetry, result.performance);
  await geminiGenerateContentAttempt.countTokens({ payload, ctx: makeGatewayCtx(), candidate, headers: new Headers() });
  assertEquals(bodies, [payload, payload]);
  assertEquals(payload.serviceTier, 'future-tier');
});

test('countTokens runs the same shape cleanup chain generate does, and skips it natively', async () => {
  installRepo();
  let translatedBody: Record<string, unknown> | undefined;
  let nativeBody: Record<string, unknown> | undefined;

  const payload = makePayload({
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'lookup' }] }],
    safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
    contents: [{ role: 'user', parts: [{ text: 'hi' }, { fileData: { fileUri: 'gs://bucket/f.pdf' } }] }],
  });

  await geminiGenerateContentAttempt.countTokens({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async (_model, body) => {
        translatedBody = body as Record<string, unknown>;
        return { http: Response.json({ input_tokens: 1 }), modelKey: 'k' };
      },
    }),
    headers: new Headers(),
  });

  await geminiGenerateContentAttempt.countTokens({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
      callGeminiGenerateContentCountTokens: async (_model, body) => {
        nativeBody = body as Record<string, unknown>;
        return { http: Response.json({ totalTokens: 1 }), modelKey: 'k' };
      },
    }),
    headers: new Headers(),
  });

  // A translated target cannot express these fields, so the shared cleanup
  // removes them; a native upstream receives the payload as shaped.
  assertEquals(translatedBody?.safetySettings, undefined);
  assertEquals(nativeBody?.safetySettings, payload.safetySettings);
  assertEquals(nativeBody?.contents, payload.contents);
  assertEquals(nativeBody?.tools, payload.tools);
});
