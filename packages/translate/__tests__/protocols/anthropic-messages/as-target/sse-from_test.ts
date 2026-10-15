import { describe, expect, it } from 'vitest';

import type { IRRecord } from '../../../../src/ir/stream.ts';
import type { AnthropicMessagesAssistantState, AnthropicMessagesInputAssistantTurn } from '../../../../src/protocols/anthropic-messages/as-target/assistant-turn.ts';
import { irFromAnthropicMessages } from '../../../../src/protocols/anthropic-messages/as-target/sse-from.ts';
import type { RoundTripReader } from '../../../../src/round-trip/stream.ts';
import { createReferenceBuilder, finalizeAssistantTurnReferences, type FieldStates } from '../../../../src/round-trip/thin/reference-builder.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';

type CapturedTurn = Parameters<RoundTripReader<'anthropicMessages'>['onAssistantTurn']>;
type AppendRecord = Extract<IRRecord, { type: 'operation'; operation: 'append' }>;

describe('Anthropic Messages round-trip capture', () => {

  it('captures source blocks, citations, thinking, and parsed tool JSON before choice_end', async () => {
    const builder = createReferenceBuilder();
    const order: string[] = [];
    let captured: {
      turn: AnthropicMessagesInputAssistantTurn;
      fieldState: AnthropicMessagesAssistantState<FieldStates>;
    } | undefined;
    const roundTrip: RoundTripReader<'anthropicMessages'> = {
      builder,
      onAssistantTurn: (_choice, turn, fieldState) => { order.push('turn'); captured = { turn, fieldState }; },
    };
    const toolInput = '{"large":9007199254740993,"__proto__":{"safe":true}}';
    const sourceEvents = [
      { type: 'message_start', message: { id: 'source', type: 'message', role: 'assistant', model: 'model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'read ', citations: [{ type: 'web_search_result_location', url: 'https://example.test', title: 'source', encrypted_index: 'idx', cited_text: 'search quote' }], provider_opaque: { kept: true } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '😀' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'reason', signature: 'sealed', provider_opaque: 'thinking metadata' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'final-sealed' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call', name: 'lookup', input: {}, provider_opaque: 'tool metadata' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: toolInput } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, container: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    const frames = sourceEvents.map(value => eventFrame(value as AnthropicMessagesStreamEventEx));
    const appends: AppendRecord[] = [];
    for await (const record of irFromAnthropicMessages((async function* () { yield* frames; })(), { roundTrip })) {
      if (record.type === 'choice_end') order.push('choice_end');
      if (record.type === 'operation' && record.operation === 'append') appends.push(record);
    }

    expect(order).toEqual(['turn', 'choice_end']);
    if (captured === undefined) throw new Error('Expected a captured Messages assistant turn');
    const { turn, fieldState } = captured;
    expect(turn.role).toBe('assistant');
    expect(turn.content[0]).toMatchObject({ type: 'text', text: 'read 😀', citations: [{ cited_text: 'search quote' }] });
    expect(turn.content[1]).toMatchObject({ type: 'thinking', thinking: 'reason' });
    const toolBlock = turn.content[2];
    if (toolBlock.type !== 'tool_use') throw new Error('Expected a tool-use block');
    expect(JSON.stringify(toolBlock.input)).toBe(toolInput);
    if (typeof toolBlock.input !== 'object' || toolBlock.input === null || Array.isArray(toolBlock.input)) throw new Error('Expected parsed tool input');
    expect(Object.hasOwn(toolBlock.input, '__proto__')).toBe(true);
    expect(fieldState).toMatchObject({
      content: [
        { text: {} },
        { thinking: {} },
        { input: {} },
      ],
    });
    const referencedAppends = appends.filter(record => record.partId !== undefined);
    expect(referencedAppends.map(record => record.value)).toEqual(['read ', '😀', 'reason', toolInput]);
    expect(new Set(referencedAppends.map(record => record.partId)).size).toBe(4);
    expect(Reflect.get(turn.content[0], 'provider_opaque')).toEqual({ kept: true });
    const thinkingBlock = turn.content[1];
    if (thinkingBlock.type !== 'thinking') throw new Error('Expected a thinking block');
    expect(thinkingBlock.signature).toBe('final-sealed');
    expect(Reflect.get(turn.content[2], 'provider_opaque')).toBe('tool metadata');
  });

  it('keeps wrapped custom input literal after its IR text is transformed', async () => {
    const builder = createReferenceBuilder();
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'anthropicMessages'> = {
      builder,
      onAssistantTurn: (...args) => { captured = args; },
    };
    const sourceEvents = [
      { type: 'message_start', message: { id: 'source', model: 'model', usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'script', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"input":"text"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    const inputAppends: AppendRecord[] = [];
    const frames = sourceEvents.map(value => eventFrame(value as AnthropicMessagesStreamEventEx));
    for await (const record of irFromAnthropicMessages((async function* () { yield* frames; })(), { customToolNames: new Set(['script']), roundTrip })) {
      if (record.type === 'operation' && record.operation === 'append' && record.path.at(-1) === 'input') inputAppends.push(record);
    }

    expect(inputAppends).toEqual([expect.objectContaining({ value: 'text' })]);
    expect(inputAppends[0]).not.toHaveProperty('partId');
    if (captured === undefined) throw new Error('Expected a wrapped Messages assistant turn');
    const finalized = await finalizeAssistantTurnReferences<'anthropicMessages'>(captured[1], captured[2], builder, new Map());
    const block = finalized.assistantTurn.content[0];
    if (block.type !== 'tool_use') throw new Error('Expected a finalized tool-use block');
    expect(block.input).toEqual({ input: 'text' });
  });
});
