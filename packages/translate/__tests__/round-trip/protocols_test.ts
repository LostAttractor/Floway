import { describe, expect, it } from 'vitest';

import { computeAnthropicMessagesReplayCheck, createAnthropicMessagesSidecarCarrier, inspectAnthropicMessagesAssistantTurn, partitionAnthropicMessagesTurns, verifyAnthropicMessagesReplayCheck } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { computeOpenAIChatCompletionsReplayCheck, createOpenAIChatCompletionsSidecarCarrier, inspectOpenAIChatCompletionsAssistantTurn, partitionOpenAIChatCompletionsTurns, verifyOpenAIChatCompletionsReplayCheck } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { computeOpenAIResponsesReplayCheck, createOpenAIResponsesSidecarCarrier, type inspectOpenAIResponsesAssistantTurn, partitionOpenAIResponsesTurns, verifyOpenAIResponsesReplayCheck } from '../../src/protocols/openai-responses/as-source/round-trip.ts';
import { toOpenAIResponsesInputAssistantTurn, type OpenAIResponsesOutputAssistantTurn } from '../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import type { RoundTripSidecarEnvelope } from '../../src/round-trip/codec.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

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

const responseTurn = (): OpenAIResponsesOutputItemEx[] => [
  { type: 'message', id: 'msg-a', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer', annotations: [], logprobs: [] }] },
  { type: 'function_call', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', status: 'completed' },
  { type: 'reasoning', id: 'carrier-id', status: 'completed', summary: [], encrypted_content: 'opaque-sidecar' },
];

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

const verifyResponsesTurn = (
  turn: Parameters<typeof inspectOpenAIResponsesAssistantTurn>[0],
  replayCheck: Parameters<typeof verifyOpenAIResponsesReplayCheck>[1],
) => verifyOpenAIResponsesReplayCheck(turn, replayCheck);

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

  it('partitions Responses input on native assistant/user/tool-output boundaries without using the sidecar as a delimiter', () => {
    const input: CanonicalOpenAIResponsesInputItem[] = [
      { type: 'reasoning', summary: [], encrypted_content: 'opaque-sidecar' },
      { type: 'function_call', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}' },
      { type: 'function_call_output', call_id: 'call-a', output: 'result' },
      { type: 'message', role: 'assistant', content: 'answer' },
      { type: 'message', role: 'user', content: 'next question' },
    ];
    const turns = partitionOpenAIResponsesTurns(input);
    expect(turns.map(({ role, items }) => [role, items.length])).toEqual([
      ['assistant', 2], ['bare', 1], ['assistant', 1], ['bare', 1],
    ]);
    expect(turns.map(({ items }) => items).flat()).toEqual(input);
  });

  it('checks Responses bodies and statuses in order within each item type independently of other metadata', async () => {
    const turn = responseTurn();
    const check = await computeOpenAIResponsesReplayCheck(turn);
    expect(await verifyResponsesTurn(turn, check)).toBe(true);
    for (const changed of [
      [{ ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, content: [{ type: 'output_text' as const, text: 'edited answer', annotations: [], logprobs: [] }] }, ...turn.slice(1)],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, call_id: 'edited-call' }, turn[2]],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, name: 'edited-name' }, turn[2]],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, namespace: 'different-tool-namespace' }, turn[2]],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, arguments: '{"q":"changed"}' }, turn[2]],
      [{ ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, status: 'incomplete' }, ...turn.slice(1)],
      [turn[0], { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, status: 'incomplete' }, turn[2]],
      [...turn, turn[1]],
    ]) expect(await verifyResponsesTurn(changed, check)).toBe(false);
    expect(await verifyResponsesTurn([turn[1], turn[0], turn[2]], check)).toBe(true);
    for (const message of [
      { ...turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, id: 'edited-message', phase: 'commentary' as const },
    ]) expect(await verifyResponsesTurn([message, ...turn.slice(1)], check)).toBe(true);
    const call = turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>;
    expect(await verifyResponsesTurn([turn[0], { ...call, id: 'different-record' }, turn[2]], check)).toBe(true);
    const outputMessage = turn[0] as Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>;
    const changedOutputCitation: OpenAIResponsesOutputItemEx[] = [
      {
        ...outputMessage,
        content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://edited.test', title: 'edited', start_index: 0, end_index: 1 }], logprobs: [] }],
      },
      ...turn.slice(1),
    ];
    expect(await verifyResponsesTurn(changedOutputCitation, check)).toBe(true);
    const bodyInCarrier = [{ ...turn[0] }, turn[1], { ...turn[2] as Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }>, summary: [{ type: 'summary_text' as const, text: 'visible carrier text' }] }];
    const bodyCheck = await computeOpenAIResponsesReplayCheck(bodyInCarrier);
    expect(await verifyResponsesTurn(bodyInCarrier, bodyCheck)).toBe(true);
    expect(await verifyResponsesTurn([{ ...bodyInCarrier[0] }, bodyInCarrier[1], { ...bodyInCarrier[2] as Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }>, summary: [{ type: 'summary_text', text: 'edited visible carrier text' }] }], bodyCheck)).toBe(false);
    expect(await verifyResponsesTurn([turn[2], ...turn.slice(0, 2)], check)).toBe(true);
    expect(await verifyResponsesTurn(turn, { ...check, version: 99 })).toBe(false);

    const secondCall = { ...turn[1] as Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }>, call_id: 'call-b', name: 'other', arguments: '{"q":"b"}' };
    const twoCalls = [turn[0], turn[1], turn[2], secondCall];
    const twoCallsCheck = await computeOpenAIResponsesReplayCheck(twoCalls);
    expect(await verifyResponsesTurn([turn[0], secondCall, turn[2], turn[1]], twoCallsCheck)).toBe(false);
    expect(await verifyResponsesTurn([turn[1], secondCall, turn[0], turn[2]], twoCallsCheck)).toBe(true);

    const mixedContentMessage = {
      type: 'message' as const,
      role: 'assistant' as const,
      content: [
        { type: 'output_text' as const, text: 'first', annotations: [], logprobs: [] },
        { type: 'refusal' as const, refusal: 'refused' },
        { type: 'output_text' as const, text: 'second', annotations: [], logprobs: [] },
      ],
    };
    const mixedContentTurn = [mixedContentMessage, turn[2]];
    const mixedContentCheck = await computeOpenAIResponsesReplayCheck(mixedContentTurn);
    expect(await verifyResponsesTurn([{ ...mixedContentMessage, content: [mixedContentMessage.content[1], mixedContentMessage.content[0], mixedContentMessage.content[2]] }, turn[2]], mixedContentCheck)).toBe(true);
    expect(await verifyResponsesTurn([{ ...mixedContentMessage, content: [mixedContentMessage.content[2], mixedContentMessage.content[1], mixedContentMessage.content[0]] }, turn[2]], mixedContentCheck)).toBe(false);

    const inputTextMessage = { type: 'message' as const, role: 'assistant' as const, content: [{ type: 'input_text' as const, text: 'input body' }] };
    const inputTextCheck = await computeOpenAIResponsesReplayCheck([inputTextMessage, turn[2]]);
    expect(await verifyResponsesTurn([{ ...inputTextMessage, content: [{ type: 'input_text', text: 'edited input body' }] }, turn[2]], inputTextCheck)).toBe(false);

  });

  it('checks reasoning content and summary and custom tool input without hashing unrelated metadata', async () => {
    const reasoning: Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }> = {
      type: 'reasoning', id: 'rs-readable', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }],
    };
    const custom: Extract<OpenAIResponsesOutputItemEx, { type: 'custom_tool_call' }> = {
      type: 'custom_tool_call', id: 'custom-record', call_id: 'call-custom', name: 'format', input: 'plain input',
    };
    const carrier = createOpenAIResponsesSidecarCarrier('rs-sidecar', 'opaque');
    const turn = [reasoning, custom, carrier];
    const check = await computeOpenAIResponsesReplayCheck(turn);
    expect(await verifyResponsesTurn([{ ...reasoning, id: 'different' }, { ...custom, id: 'different' }, carrier], check)).toBe(true);
    for (const changed of [
      [{ ...reasoning, summary: [{ type: 'summary_text' as const, text: 'edited' }] }, custom, carrier],
      [{ ...reasoning, content: [{ type: 'reasoning_text' as const, text: 'edited' }] }, custom, carrier],
      [reasoning, { ...custom, call_id: 'edited' }, carrier],
      [reasoning, { ...custom, name: 'edited' }, carrier],
      [reasoning, { ...custom, namespace: 'different-tool-namespace' }, carrier],
      [reasoning, { ...custom, input: 'edited' }, carrier],
      [reasoning, custom, { type: 'message' as const, role: 'assistant' as const, content: [{ type: 'output_text' as const, text: '', annotations: [] }] }, carrier],
    ]) expect(await verifyResponsesTurn(changed, check)).toBe(false);
  });

  it('checks status on every status-bearing Responses replay material variant', async () => {
    const cases: Array<{
      original: Parameters<typeof computeOpenAIResponsesReplayCheck>[0];
      changed: Parameters<typeof verifyOpenAIResponsesReplayCheck>[0];
    }> = [
      {
        original: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }],
        changed: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }],
      },
      {
        original: [{ type: 'reasoning', id: 'reasoning', status: 'completed', summary: [] }],
        changed: [{ type: 'reasoning', id: 'reasoning', status: 'incomplete', summary: [] }],
      },
      {
        original: [{ type: 'function_call', call_id: 'function', name: 'lookup', arguments: '{}', status: 'completed' }],
        changed: [{ type: 'function_call', call_id: 'function', name: 'lookup', arguments: '{}', status: 'incomplete' }],
      },
      {
        original: [{ type: 'custom_tool_call', call_id: 'custom', name: 'format', input: 'value', status: 'completed' }],
        changed: [{ type: 'custom_tool_call', call_id: 'custom', name: 'format', input: 'value', status: 'incomplete' }],
      },
      {
        original: [{ type: 'image_generation_call', id: 'image', result: 'image', status: 'completed' }],
        changed: [{ type: 'image_generation_call', id: 'image', result: 'image', status: 'failed' }],
      },
      {
        original: [{ type: 'web_search_call', id: 'search', status: 'completed' }],
        changed: [{ type: 'web_search_call', id: 'search', status: 'failed' }],
      },
    ];

    for (const { original, changed } of cases) {
      const originalCheck = await computeOpenAIResponsesReplayCheck(original);
      const changedCheck = await computeOpenAIResponsesReplayCheck(changed);
      expect(await verifyOpenAIResponsesReplayCheck(changed, originalCheck)).toBe(false);
      expect(await verifyOpenAIResponsesReplayCheck(original, changedCheck)).toBe(false);
    }

    const statusless = [{ type: 'function_call' as const, call_id: 'function', name: 'lookup', arguments: '{}' }];
    const statuslessCheck = await computeOpenAIResponsesReplayCheck(statusless);
    expect(await verifyOpenAIResponsesReplayCheck(statusless, statuslessCheck)).toBe(true);
    expect(await verifyOpenAIResponsesReplayCheck(cases[2].original, statuslessCheck)).toBe(false);
  });

  it('builds canonical Responses history items', async () => {
    expect(createOpenAIResponsesSidecarCarrier('rs_sidecar', 'opaque-sidecar')).toEqual({
      type: 'reasoning', id: 'rs_sidecar', summary: [], encrypted_content: 'opaque-sidecar',
    });
    const imageCall: Extract<OpenAIResponsesOutputItemEx, { type: 'image_generation_call' }> = {
      type: 'image_generation_call', id: 'ig-data', result: 'image-base64', status: 'completed', action: 'generate', output_format: 'png',
    };
    const messageWithSDKFields = {
      type: 'message', id: 'message-a', role: 'assistant', status: 'completed', phase: 'final_answer', created_by: 'sdk',
      content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [], parsed: { answer: true } }],
    } satisfies Extract<OpenAIResponsesOutputItemEx, { type: 'message' }> & { created_by: string; content: (Extract<Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>['content'][number], { type: 'output_text' }> & { parsed: { answer: boolean } })[] };
    const functionCallWithSDKFields = {
      type: 'function_call', id: 'function-a', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', parsed_arguments: { q: 'a' }, status: 'completed', created_by: 'sdk',
    } satisfies Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }> & { parsed_arguments: { q: string }; created_by: string };
    const outputHistory: OpenAIResponsesOutputAssistantTurn = [
      messageWithSDKFields,
      functionCallWithSDKFields,
      { type: 'additional_tools', id: 'additional-tools-assistant', role: 'assistant', tools: [] },
      { type: 'shell_call_output', id: 'shell-output', call_id: 'shell-call', output: [{ stdout: 'ok', stderr: '', outcome: { type: 'exit', exit_code: 0 }, created_by: 'sdk' }], status: 'completed', created_by: 'sdk' },
      { type: 'computer_call_output', call_id: 'computer-call', output: { type: 'computer_screenshot', file_id: 'screenshot' }, status: 'failed', created_by: 'sdk' },
      { type: 'custom_tool_call_output', call_id: 'custom-incomplete', output: 'incomplete', status: 'incomplete' },
      { type: 'custom_tool_call_output', id: 'custom-completed', call_id: 'custom-completed-call', output: 'complete', status: 'completed' },
      { type: 'additional_tools', id: 'additional-tools-developer', role: 'developer', tools: [] },
      { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
      imageCall,
    ];
    expect(toOpenAIResponsesInputAssistantTurn(outputHistory)).toEqual([
      { type: 'message', id: 'message-a', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [] }] },
      { type: 'function_call', id: 'function-a', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', status: 'completed' },
      { type: 'shell_call_output', id: 'shell-output', call_id: 'shell-call', output: [{ stdout: 'ok', stderr: '', outcome: { type: 'exit', exit_code: 0 } }], status: 'completed' },
      { type: 'custom_tool_call_output', id: 'custom-completed', call_id: 'custom-completed-call', output: 'complete' },
      { type: 'additional_tools', id: 'additional-tools-developer', role: 'developer', tools: [] },
      { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
      imageCall,
    ]);
    const imageTurn: OpenAIResponsesOutputItemEx[] = [
      imageCall,
      { type: 'reasoning', id: 'rs-image', summary: [], encrypted_content: 'opaque-sidecar' },
    ];
    const imageCheck = await computeOpenAIResponsesReplayCheck(imageTurn);
    expect(await verifyResponsesTurn(imageTurn, imageCheck)).toBe(true);
    expect(await verifyResponsesTurn([
      { ...imageCall, action: 'edit' as const, id: 'ig-other', status: 'completed' as const, output_format: 'jpeg' as const },
      imageTurn[1],
    ], imageCheck)).toBe(true);
    expect(await verifyResponsesTurn([{ ...imageCall, result: 'changed-image' }, imageTurn[1]], imageCheck)).toBe(false);
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
