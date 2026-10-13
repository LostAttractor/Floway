import { describe, expect, it } from 'vitest';

import { computeAnthropicMessagesReplayCheck, createAnthropicMessagesSidecarCarrier, inspectAnthropicMessagesAssistantTurn, partitionAnthropicMessagesTurns, verifyAnthropicMessagesReplayCheck } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsReplayCheck, createOpenAIChatCompletionsSidecarCarrier, inspectOpenAIChatCompletionsAssistantTurn, partitionOpenAIChatCompletionsTurns, verifyOpenAIChatCompletionsReplayCheck } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import type { RoundTripSidecarEnvelope } from '../../src/round-trip/codec.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';
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

const messagesTurn = (): AnthropicMessagesAssistantMessage[] => [{
  role: 'assistant',
  content: [
    { type: 'text', text: 'answer', citations: null },
    { type: 'thinking', thinking: 'reasoning', signature: 'native-message-signature' },
    { type: 'tool_use', id: 'call-a', name: 'lookup', input: { q: 'a' } },
    createAnthropicMessagesSidecarCarrier('opaque-sidecar'),
  ],
}];

const verifyChatTurn = (
  turn: Parameters<typeof inspectOpenAIChatCompletionsAssistantTurn>[0],
  replayCheck: Parameters<typeof verifyOpenAIChatCompletionsReplayCheck>[1],
) => verifyOpenAIChatCompletionsReplayCheck(turn, replayCheck);

const verifyMessagesTurn = (
  turn: Parameters<typeof inspectAnthropicMessagesAssistantTurn>[0],
  replayCheck: Parameters<typeof verifyAnthropicMessagesReplayCheck>[1],
) => verifyAnthropicMessagesReplayCheck(turn, replayCheck);

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

  it('merges adjacent Messages roles into runs and checks bodies in order within each block type', async () => {
    const first = messagesTurn()[0];
    const second: AnthropicMessagesAssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'continued', citations: null }] };
    const user: AnthropicMessagesMessage = { role: 'user', content: 'question' };
    const turns = partitionAnthropicMessagesTurns([first, second, user]);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([['assistant', 2], ['user', 1]]);
    expect(turns.map(({ items }) => items).flat()).toEqual([first, second, user]);
    const assistantTurn = [first, second];
    const inspection = inspectAnthropicMessagesAssistantTurn(assistantTurn);
    expect(inspection.sidecars).toEqual(['opaque-sidecar']);
    const check = await computeAnthropicMessagesReplayCheck(assistantTurn);
    expect(await verifyMessagesTurn(assistantTurn, check)).toBe(true);
    const changed = (blocks: AnthropicMessagesAssistantMessage['content']): AnthropicMessagesAssistantMessage[] => [{ role: 'assistant', content: blocks }];
    const blocks = first.content as Exclude<AnthropicMessagesAssistantMessage['content'], string>;
    for (const changedTurn of [
      changed([{ ...blocks[0] as Extract<typeof blocks[number], { type: 'text' }>, text: 'edited' }, ...blocks.slice(1)]),
      changed([blocks[0], blocks[1], { ...blocks[2] as Extract<typeof blocks[number], { type: 'tool_use' }>, id: 'edited-call' }, blocks[3]]),
      changed([blocks[0], blocks[1], { ...blocks[2] as Extract<typeof blocks[number], { type: 'tool_use' }>, name: 'edited-name' }, blocks[3]]),
      changed([blocks[0], blocks[1], { ...blocks[2] as Extract<typeof blocks[number], { type: 'tool_use' }>, input: { q: 'changed' } }, blocks[3]]),
      [first, { ...second, content: [{ type: 'text' as const, text: 'edited continued', citations: null }] }],
    ]) expect(await verifyMessagesTurn(changedTurn, check)).toBe(false);
    expect(await verifyMessagesTurn([...changed([blocks[0], blocks[2], blocks[1], blocks[3]]), second], check)).toBe(true);
    expect(await verifyMessagesTurn(changed([blocks[2], blocks[0], blocks[3], blocks[1], ...(second.content as Exclude<typeof second.content, string>)]), check)).toBe(true);
    expect(await verifyMessagesTurn(changed([...(second.content as Exclude<typeof second.content, string>), ...blocks]), check)).toBe(false);

    const secondTool = { type: 'tool_use' as const, id: 'tool-b', name: 'other', input: { q: 'b' } };
    const twoTools = changed([...blocks, secondTool]);
    const twoToolsCheck = await computeAnthropicMessagesReplayCheck(twoTools);
    expect(await verifyMessagesTurn(changed([blocks[0], blocks[1], secondTool, blocks[2], blocks[3]]), twoToolsCheck)).toBe(false);
    expect(await verifyMessagesTurn(changed([blocks[0], blocks[2], secondTool, blocks[1], blocks[3]]), twoToolsCheck)).toBe(true);
    const settingsTurn: AnthropicMessagesAssistantMessage[] = [
      { ...first, clear_at: 'never', output_config: null },
      second,
    ];
    const settingsCheck = await computeAnthropicMessagesReplayCheck(settingsTurn);
    expect(await verifyMessagesTurn(settingsTurn, settingsCheck)).toBe(true);
    expect(await verifyMessagesTurn([{ ...settingsTurn[0], clear_at: 'next_user_message' }, second], settingsCheck)).toBe(true);
    expect(await verifyMessagesTurn([{ role: 'assistant', content: [...blocks, ...(second.content as Exclude<typeof second.content, string>)] }], check)).toBe(true);
    const stringContentCheck = await computeAnthropicMessagesReplayCheck([{ role: 'assistant', content: 'plain text' }]);
    expect(await verifyMessagesTurn([{ role: 'assistant', content: [{ type: 'text', text: 'plain text', citations: null }] }], stringContentCheck)).toBe(true);
    expect(await verifyMessagesTurn([{
      ...first, content: [
        { ...blocks[0] as Extract<typeof blocks[number], { type: 'text' }>, cache_control: { type: 'ephemeral' } },
        { ...blocks[1] as Extract<typeof blocks[number], { type: 'thinking' }>, signature: 'different-signature' },
        ...blocks.slice(2),
      ],
    }, second], check)).toBe(true);
  });

  it('checks Messages text, citations, thinking, and JSON tool input', async () => {
    const textCitation = {
      type: 'char_location' as const,
      document_index: 0,
      document_title: 'source document',
      file_id: 'file-a',
      cited_text: 'answer',
      start_char_index: 0,
      end_char_index: 6,
    };
    const responseContent = [
      { type: 'text', text: 'answer', citations: [textCitation] },
      { type: 'thinking', thinking: 'reasoning', signature: 'native-message-signature' },
      { type: 'tool_use', id: 'call-a', name: 'lookup', input: { q: 'a' } },
      createAnthropicMessagesSidecarCarrier('opaque-sidecar'),
    ] satisfies AnthropicMessagesAssistantContentBlock[];
    const citedTurn: AnthropicMessagesAssistantMessage[] = [{ role: 'assistant', content: responseContent }];
    const citedCheck = await computeAnthropicMessagesReplayCheck(citedTurn);
    const responseText = responseContent[0] as Extract<typeof responseContent[number], { type: 'text' }>;
    expect(await verifyMessagesTurn([{
      role: 'assistant',
      content: [{ ...responseText, citations: [{ ...textCitation, cited_text: 'edited citation' }] }, ...responseContent.slice(1)],
    }], citedCheck)).toBe(false);
  });
});
