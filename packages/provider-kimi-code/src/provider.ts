import { assertKimiCodeUpstreamRecord } from './config.ts';
import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { kimiCodeFetch } from './fetch.ts';
import { selectKimiCodeModel } from './model-selection.ts';
import { fetchKimiCodeModels } from './models.ts';
import { scheduleKimiCodeProbes, runKimiCodeScheduledTask } from './probe.ts';
import { kimiCodeChatSpeedParser, kimiCodeMessagesSpeedParser, kimiCodeMessagesWireBody, kimiCodeResponsesSpeedParser } from './speed.ts';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { headersForAnthropicMessagesCall, jsonRequestBody, resolveEffectiveFlags, ServiceTierRequestError, streamingProviderCall, type HttpHeaderLines, type Provider, type ProviderInstance, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';

const fastModeRequired = (model: ProviderModel, field: 'service_tier' | 'speed') =>
  new ServiceTierRequestError(field, `'${model.id}' is only available with fast mode selected; set \`${field}: "${field === 'speed' ? 'fast' : FAST_SERVICE_TIER}"\`.`);

const selectOpenAIModel = (model: ProviderModel, tier: string | null | undefined) => {
  const fast = isFastServiceTier(tier);
  const selection = selectKimiCodeModel(model, fast);
  if (selection !== undefined) return selection;
  if (!fast) throw fastModeRequired(model, 'service_tier');
  throw new ServiceTierRequestError('service_tier', `'${model.id}' does not support service_tier ${JSON.stringify(tier)}.`);
};

const selectMessagesModel = (model: ProviderModel, speed: unknown) => {
  // Anthropic generally rejects fast requests on unsupported models.
  // https://platform.claude.com/docs/en/build-with-claude/fast-mode
  const selection = selectKimiCodeModel(model, speed === 'fast');
  if (selection !== undefined) return selection;
  if (speed !== 'fast') throw fastModeRequired(model, 'speed');
  throw new ServiceTierRequestError('speed', `'${model.id}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.`);
};

export const createKimiCodeProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertKimiCodeUpstreamRecord(record);
  const enabledFlags = resolveEffectiveFlags([KIMI_CODE_DEFAULT_FLAGS, record.flagOverrides]);

  // Forward thinking and effort unchanged. Observed responses echo the id that
  // was requested, so neither this layer nor the caller can tell which model
  // actually served a request the service routed differently; the documented
  // disabled-thinking behaviour for K3 and K2.7 Code Highspeed makes that a real
  // possibility rather than a hypothetical. Model-scoped restrictions would
  // instead present a request-dependent upstream rule as a gateway limit.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  const call = async (path: string, modelId: string, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: HttpHeaderLines, opts: UpstreamCallOptions, probes: boolean) => {
    const response = await kimiCodeFetch(config, path,
      { method: 'POST', body: jsonRequestBody({ ...body, model: modelId }), signal },
      { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall });
    // Quota exhaustion (429) and plan restrictions (403) warrant a current read.
    // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
    if (probes) scheduleKimiCodeProbes(record, config, opts.fetcher, opts.waitUntil, response.status === 429 || response.status === 403);
    return response;
  };

  const streaming = <T>(path: string, modelId: string, body: Record<string, unknown>, signal: AbortSignal | undefined, headers: HttpHeaderLines, parser: ProviderStreamParser<T>, opts: UpstreamCallOptions) =>
    streamingProviderCall(call(path, modelId, { ...body, stream: true }, signal, headers, opts, true), parser, modelId, signal);

  const unsupported = (method: string) => () => Promise.reject(new Error(`Kimi Code provider does not implement ${method}`));

  // Fixed coding-service endpoints; the catalog contains conversational models,
  // so unrelated Open Platform capabilities are not inferred from model names.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  const instance: ProviderInstance = {
    getProvidedModels: fetcher => fetchKimiCodeModels(config, fetcher, enabledFlags),
    runScheduledTask: options => runKimiCodeScheduledTask(record, options),
    callOpenAIChatCompletions: async (model, body, signal, opts) => {
      const { modelId, lane } = selectOpenAIModel(model, body.service_tier);
      return await streaming('/chat/completions', modelId, lane === 'fast' ? { ...body, service_tier: FAST_SERVICE_TIER } : body, signal, [...opts.headers], lane === 'fast' ? kimiCodeChatSpeedParser : parseOpenAIChatCompletionsStream, opts);
    },
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      if (action === 'compact') throw new Error('Kimi Code does not expose a native Responses compaction endpoint');
      const { modelId, lane } = selectOpenAIModel(model, body.service_tier);
      const result = await streaming('/responses', modelId, lane === 'fast' ? { ...body, service_tier: FAST_SERVICE_TIER } : body, signal, [...opts.headers], lane === 'fast' ? kimiCodeResponsesSpeedParser : parseOpenAIResponsesStream, opts);
      return { ...result, action: 'generate' };
    },
    callAnthropicMessages: async (model, body, signal, opts) => {
      const { modelId } = selectMessagesModel(model, body.speed);
      return await streaming('/messages', modelId, kimiCodeMessagesWireBody(body), signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), body.speed === 'fast' || body.speed === 'standard' ? kimiCodeMessagesSpeedParser(body.speed === 'fast' ? 'fast' : 'standard') : parseAnthropicMessagesStream, opts);
    },
    callAnthropicMessagesCountTokens: async (model, body, signal, opts) => {
      const { modelId } = selectMessagesModel(model, body.speed);
      return {
        http: await call('/messages/count_tokens', modelId, kimiCodeMessagesWireBody(body), signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), opts, false),
        modelKey: modelId,
      };
    },
    callAlphaSearch: unsupported('callAlphaSearch'),
    callGeminiGenerateContent: unsupported('callGeminiGenerateContent'),
    callGeminiGenerateContentCountTokens: unsupported('callGeminiGenerateContentCountTokens'),
    callOpenAICompletions: unsupported('callOpenAICompletions'),
    callOpenAIEmbeddings: unsupported('callOpenAIEmbeddings'),
    callOpenAIImagesGenerations: unsupported('callOpenAIImagesGenerations'),
    callOpenAIImagesEdits: unsupported('callOpenAIImagesEdits'),
    callOpenAIAudioTranscriptions: unsupported('callOpenAIAudioTranscriptions'),
    callRerank: unsupported('callRerank'),
    callDecision: unsupported('callDecision'),
  };
  return {
    upstreamId: record.id,
    kind: 'kimi-code',
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelServiceTiers: (model, target) =>
      target !== 'geminiGenerateContent' && selectKimiCodeModel(model, true) !== undefined
        ? [{ id: target === 'anthropicMessages' ? 'fast' : FAST_SERVICE_TIER, name: 'Fast', description: '' }]
        : [],
    serviceTierPolicy: record.serviceTierPolicy,
    modelsCache: record.modelsCache,
    instance,
  };
};
