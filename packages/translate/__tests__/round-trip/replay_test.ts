import { describe, expect, it } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { computeOpenAIChatCompletionsReplayCheck, createOpenAIChatCompletionsSidecarCarrier, inspectOpenAIChatCompletionsAssistantTurn, verifyOpenAIChatCompletionsReplayCheck } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { roundTripAssistantTurn } from '../../src/round-trip/replay.ts';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';

describe('assistant-turn replay boundary', () => {
  it('returns no restored turn when the source has no sidecar', async () => {
    await expect(roundTripAssistantTurn(
      'openaiChatCompletions',
      'anthropicMessages',
      { role: 'assistant', content: 'answer' },
      createTestSidecarCodec(),
      inspectOpenAIChatCompletionsAssistantTurn,
      verifyOpenAIChatCompletionsReplayCheck,
    )).resolves.toBeUndefined();
  });

  it('restores the authenticated target assistant turn', async () => {
    const codec = createTestSidecarCodec();
    const sourceTurn: OpenAIChatCompletionsAssistantMessageEx = {
      role: 'assistant',
      content: 'answer',
      reasoning_details: createOpenAIChatCompletionsSidecarCarrier(''),
    };
    const assistantTurn = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'native target answer', citations: null }],
    };
    const data = await codec.encode('openaiChatCompletions', {
      target: 'anthropicMessages',
      assistantTurn,
      replayCheck: await computeOpenAIChatCompletionsReplayCheck(sourceTurn),
    });
    sourceTurn.reasoning_details = createOpenAIChatCompletionsSidecarCarrier(data);

    await expect(roundTripAssistantTurn(
      'openaiChatCompletions',
      'anthropicMessages',
      sourceTurn,
      codec,
      inspectOpenAIChatCompletionsAssistantTurn,
      verifyOpenAIChatCompletionsReplayCheck,
    )).resolves.toEqual({ turn: assistantTurn });
  });
});
