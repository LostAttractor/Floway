import { describe, expect, it } from 'vitest';

import { computeOpenAIChatCompletionsReplayCheck, createOpenAIChatCompletionsSidecarCarrier, inspectOpenAIChatCompletionsAssistantTurn, partitionOpenAIChatCompletionsTurns, verifyOpenAIChatCompletionsReplayCheck } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import type { RoundTripSidecarEnvelope } from '../../src/round-trip/codec.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

const chatTurn = (): OpenAIChatCompletionsAssistantMessageEx => ({
  role: 'assistant',
  content: 'answer',
  name: 'assistant-name',
  audio: { id: 'audio-a' },
  annotations: [{ type: 'url_citation', url_citation: { start_index: 0, end_index: 6, title: 'source', url: 'https://example.test' } }],
  reasoning_details: createOpenAIChatCompletionsSidecarCarrier('opaque-sidecar', 'readable summary'),
  tool_calls: [
    { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' }, provider_specific_fields: { trace: 'a' } },
    { id: 'call-b', type: 'custom', custom: { name: 'format', input: 'plain text' }, extra_content: { trace: 'b' } },
  ],
  provider_specific_fields: { dropped: true },
});

const verifyChatTurn = (
  turn: Parameters<typeof inspectOpenAIChatCompletionsAssistantTurn>[0],
  replayCheck: Parameters<typeof verifyOpenAIChatCompletionsReplayCheck>[1],
) => verifyOpenAIChatCompletionsReplayCheck(turn, replayCheck);

describe('assistant-turn sidecar protocols', () => {
  it('types the unified envelope by source protocol, target protocol, assistant turn, and replay check', () => {
    const sidecar: RoundTripSidecarEnvelope = {
      source: 'openaiChatCompletions',
      target: 'anthropicMessages',
      assistantTurn: { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'original-target-value' }] },
      replayCheck: { version: 1, digest: new Uint8Array(32) },
    };
    expect([sidecar.source, sidecar.target, sidecar.assistantTurn.content[0].type]).toEqual([
      'openaiChatCompletions', 'anthropicMessages', 'redacted_thinking',
    ]);
  });

  it('partitions Chat messages one assistant message at a time and leaves every other role bare', () => {
    const messages: OpenAIChatCompletionsMessage[] = [
      { role: 'user', content: 'question' },
      chatTurn(),
      { role: 'tool', tool_call_id: 'call-a', content: 'result' },
      { role: 'assistant', content: 'follow-up' },
    ];
    const turns = partitionOpenAIChatCompletionsTurns(messages);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([
      ['bare', 1], ['assistant', 1], ['bare', 1], ['assistant', 1],
    ]);
    expect(turns.map(({ items }) => items).flat()).toEqual(messages);
  });

  it('checks complete Chat body, readable summary, and ordered tool identities and arguments', async () => {
    const turn = chatTurn();
    const inspection = inspectOpenAIChatCompletionsAssistantTurn(turn);
    expect(inspection.sidecars).toEqual(['opaque-sidecar']);
    const check = await computeOpenAIChatCompletionsReplayCheck(turn);
    expect(await verifyChatTurn(turn, check)).toBe(true);
    expect(await verifyChatTurn({ ...turn, audio: { id: 'edited-audio' } }, check)).toBe(true);
    const firstFunctionCall = turn.tool_calls![0] as Extract<NonNullable<typeof turn.tool_calls>[number], { type: 'function' }>;
    for (const changed of [
      { ...turn, content: 'edited answer' },
      { ...turn, reasoning_details: createOpenAIChatCompletionsSidecarCarrier('opaque-sidecar', 'edited summary') },
      { ...turn, tool_calls: [...turn.tool_calls!].reverse() },
      { ...turn, tool_calls: [{ ...turn.tool_calls![0], id: 'edited-call' }, turn.tool_calls![1]] },
      { ...turn, tool_calls: [{ ...firstFunctionCall, function: { ...firstFunctionCall.function, name: 'edited-name' } }, turn.tool_calls![1]] },
      { ...turn, tool_calls: [{ ...firstFunctionCall, function: { ...firstFunctionCall.function, arguments: '{"q":"changed"}' } }, turn.tool_calls![1]] },
      { ...turn, tool_calls: turn.tool_calls!.slice(0, 1) },
      { ...turn, tool_calls: [...turn.tool_calls!, turn.tool_calls![0]] },
    ]) expect(await verifyChatTurn(changed, check)).toBe(false);
    const reasoningDetails = createOpenAIChatCompletionsSidecarCarrier('opaque-sidecar', 'readable summary');
    expect(await verifyChatTurn({
      ...turn,
      reasoning_details: [
        { ...reasoningDetails[0], index: 4, format: 'edited' },
        { ...reasoningDetails[1], data: 'different opaque payload', index: 5 },
      ],
    }, check)).toBe(true);
    expect(await verifyChatTurn({
      ...turn,
      name: 'edited-assistant-name',
      reasoning_details: [reasoningDetails[0], { ...reasoningDetails[1], format: 'edited' }],
    }, check)).toBe(true);
    expect(await verifyChatTurn(turn, { ...check, version: 99 })).toBe(false);
    expect(createOpenAIChatCompletionsSidecarCarrier('opaque')).toEqual([
      { type: 'reasoning.encrypted', data: 'opaque', format: 'unknown', index: 1 },
    ]);
  });

});
