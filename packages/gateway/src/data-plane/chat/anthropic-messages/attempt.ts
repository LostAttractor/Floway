import { anthropicMessagesInterceptors, anthropicMessagesCountTokensInterceptors } from './interceptors/index.ts';
import type { AnthropicMessagesInvocation } from './interceptors/types.ts';
import { createAnthropicMessagesBillableUsageReader } from './usage.ts';
import { startChatPerformance } from '../../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerStreamResultToExecuteResult } from '../shared/provider-stream-result.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { captureFromDump, traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { anthropicMessagesServiceTier, type AnthropicMessagesPayload, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ModelCandidate, ExecuteResult, AnthropicMessagesUpstreamCallOptions, PlainResult } from '@floway-dev/provider';
import { applyServiceTierPolicy, providerModelOf } from '@floway-dev/provider';
import { routeAnthropicMessages } from '@floway-dev/translate/anthropic-messages';

// `/v1/messages` generate prefers a native Anthropic Messages target, then the
// translated OpenAI Responses path, then the translated OpenAI Chat Completions path.
export const anthropicMessagesGenerateTarget = chatTargetPicker(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions']);

// `count_tokens` has no translation path — only a native Anthropic Messages target
// satisfies the operation.
export const anthropicMessagesCountTokensTarget = chatTargetPicker(['anthropicMessages']);

export interface AnthropicMessagesAttemptArgs {
  readonly payload: AnthropicMessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
  readonly anthropicBeta: readonly string[];
}

const buildAnthropicMessagesUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: ChatGatewayCtx,
  headers: Headers,
  anthropicBeta: readonly string[],
): AnthropicMessagesUpstreamCallOptions => ({
  ...buildUpstreamCallOptions(candidate, ctx, headers),
  anthropicBeta,
});

export const anthropicMessagesAttempt = {
  generate: async (args: AnthropicMessagesAttemptArgs): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders, anthropicBeta } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    headers.delete('anthropic-beta');
    const targetApi = anthropicMessagesGenerateTarget.pick(candidate.model.endpoints);
    const invocation: AnthropicMessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    return await runInterceptors(invocation, ctx, anthropicMessagesInterceptors, async () => {
      if (targetApi === 'anthropicMessages') {
        if (candidate.rules !== undefined) applyRulesToUpstreamAnthropicMessages(invocation.payload, candidate.rules);
        const { model: _model, ...nativeBody } = invocation.payload;
        const body = applyServiceTierPolicy(nativeBody, ['speed', 'service_tier'], candidate.provider.serviceTierPolicy);
        const context = startChatPerformance(ctx, candidate, anthropicMessagesServiceTier(body));
        const providerResult = await candidate.provider.instance.callAnthropicMessages(
          providerModelOf(candidate),
          body,
          ctx.abortSignal,
          buildAnthropicMessagesUpstreamCallOptions(candidate, ctx, invocation.headers, anthropicBeta),
        );
        return await providerStreamResultToExecuteResult(providerResult, candidate, targetApi, ctx, context, createAnthropicMessagesBillableUsageReader());
      }
      if (targetApi === 'openaiResponses') {
        return await traverseTranslation(
          invocation.payload,
          p => routeAnthropicMessages(p).viaOpenAIResponses({ model: candidate.model.id, sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
          translated => openaiResponsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
          captureFromDump(ctx.dump, targetApi),
        );
      }
      if (targetApi === 'openaiChatCompletions') {
        return await traverseTranslation(
          invocation.payload,
          p => routeAnthropicMessages(p).viaOpenAIChatCompletions({ model: candidate.model.id, sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
          translated => openaiChatCompletionsAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
          captureFromDump(ctx.dump, targetApi),
        );
      }
      throw new Error(`anthropicMessagesAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },

  countTokens: async (args: AnthropicMessagesAttemptArgs): Promise<PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders, anthropicBeta } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    headers.delete('anthropic-beta');
    // `pick` here is contractually total — serve filtered with
    // `anthropicMessagesCountTokensTarget.canServe`, so a non-anthropic-messages candidate is
    // a contract breach.
    const targetApi = anthropicMessagesCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: AnthropicMessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    const response = await runInterceptors(invocation, ctx, anthropicMessagesCountTokensInterceptors, async () => {
      if (candidate.rules !== undefined) applyRulesToUpstreamAnthropicMessages(invocation.payload, candidate.rules);
      const { model: _model, ...nativeBody } = invocation.payload;
      const body = applyServiceTierPolicy(nativeBody, ['speed', 'service_tier'], candidate.provider.serviceTierPolicy);
      const { response } = await candidate.provider.instance.callAnthropicMessagesCountTokens(
        providerModelOf(candidate),
        body,
        ctx.abortSignal,
        buildAnthropicMessagesUpstreamCallOptions(candidate, ctx, invocation.headers, anthropicBeta),
      );
      return response;
    });
    return await plainResultFromResponse(response, candidate.provider.upstreamId);
  },
};
