import { describe, expect, it } from 'vitest';

import { consumeIRRecords, type IRRecord } from '../../../../src/ir/stream.ts';
import type { OpenAIChatCompletionsInputAssistantTurn } from '../../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { irFromOpenAIChatCompletions } from '../../../../src/protocols/openai-chat-completions/as-target/sse-from.ts';
import type { RoundTripReader } from '../../../../src/round-trip/stream.ts';
import { createReferenceBuilder } from '../../../../src/round-trip/thin/reference-builder.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const chunk = (choices: unknown[]): ReturnType<typeof eventFrame<OpenAIChatCompletionsStreamEvent>> => eventFrame({
  id: 'source',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'model',
  choices,
} as OpenAIChatCompletionsStreamEvent);

type CapturedTurn = Parameters<RoundTripReader<'openaiChatCompletions'>['onAssistantTurn']>;
type AppendRecord = Extract<IRRecord, { type: 'operation'; operation: 'append' }>;

const drain = async (frames: ReturnType<typeof chunk>[]): Promise<Map<number, OpenAIChatCompletionsInputAssistantTurn>> => {
  const turns = new Map<number, OpenAIChatCompletionsInputAssistantTurn>();
  const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
    builder: createReferenceBuilder(),
    onAssistantTurn: (choice, turn) => { turns.set(choice, turn); },
  };
  for await (const _record of irFromOpenAIChatCompletions((async function* () { yield* frames; yield doneFrame(); })(), { maxChoices: 2, roundTrip })) {}
  return turns;
};

describe('OpenAI Chat Completions round-trip capture', () => {
  it('keeps early audio metadata native until audio content enters IR', async () => {
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
      builder: createReferenceBuilder(),
      onAssistantTurn: (...args) => { captured = args; },
    };
    const frames = [
      chunk([{ index: 0, delta: { audio: { id: 'audio', expires_at: 123 } } }]),
      chunk([{ index: 0, delta: { audio: { data: 'YQ==', transcript: 'word' } } }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
      doneFrame(),
    ];
    const reader = irFromOpenAIChatCompletions((async function* () { yield* frames; })(), { roundTrip });
    let state;
    for await (const value of consumeIRRecords(reader)) state = value.collector.state;

    expect(state?.choices[0].items).toMatchObject([{ type: 'message', content: [{ type: 'audio', audio: { data: 'YQ==', transcript: 'word' } }] }]);
    expect(JSON.stringify(state)).not.toContain('"id":"audio"');
    expect(JSON.stringify(state)).not.toContain('expires_at');
    if (captured === undefined) throw new Error('Expected a captured Chat assistant turn');
    expect(captured[1].audio).toEqual({ id: 'audio' });
    expect(captured[2]).toEqual({});
  });

  it('captures native fields and their SSE atom part IDs before choice_end', async () => {
    const builder = createReferenceBuilder();
    const order: string[] = [];
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
      builder,
      onAssistantTurn: (...args) => { order.push('turn'); captured = args; },
    };
    const frames = [
      chunk([{ index: 0, delta: { content: 'north ' } }]),
      chunk([{ index: 0, delta: { reasoning_text: 'work' } }]),
      chunk([{ index: 0, delta: { content: 'south', vendor_specific: { opaque: 'literal' } } }]),
      chunk([{ index: 0, delta: { function_call: { name: 'legacy', arguments: '{"legacy":1}' } } }]),
      chunk([{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: '{"q":' } }] } }]),
      chunk([{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: '1' } }] } }]),
      chunk([{ index: 0, delta: { tool_calls: [{ index: 2, id: 'call', type: 'function', function: { name: 'lookup', arguments: '}' } }] }, finish_reason: 'tool_calls' }]),
      doneFrame(),
    ];
    const appends: AppendRecord[] = [];
    for await (const record of irFromOpenAIChatCompletions((async function* () { yield* frames; })(), { roundTrip })) {
      if (record.type === 'choice_end') order.push('choice_end');
      if (record.type === 'operation' && record.operation === 'append') appends.push(record);
    }

    expect(order).toEqual(['turn', 'choice_end']);
    if (captured === undefined) throw new Error('Expected a captured Chat assistant turn');
    const [, turn, fieldState] = captured;
    expect(turn.content).toBe('north south');
    expect(turn.reasoning_text).toBe('work');
    expect(turn.function_call?.arguments).toBe('{"legacy":1}');
    expect(turn.tool_calls?.[0]?.type === 'function' && turn.tool_calls[0].function.arguments).toBe('{"q":1}');
    expect(turn.vendor_specific).toEqual({ opaque: 'literal' });
    expect(fieldState.content).toBeDefined();
    expect(fieldState.reasoning_text).toBeDefined();
    expect(fieldState.function_call?.arguments).toBeDefined();
    const toolState = fieldState.tool_calls?.[0];
    expect(toolState !== undefined && 'function' in toolState && toolState.function?.arguments).toBeDefined();
    const referencedAppends = appends.filter(record => record.partId !== undefined);
    expect(referencedAppends.map(record => record.value)).toEqual(['north ', 'work', 'south', '{"legacy":1}', '{"q":', '1', '}']);
    expect(new Set(referencedAppends.map(record => record.partId)).size).toBe(referencedAppends.length);
  });

  it('allocates distinct part IDs for each choice', async () => {
    const builder = createReferenceBuilder();
    const turns = new Map<number, CapturedTurn>();
    const appends: AppendRecord[] = [];
    const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
      builder,
      onAssistantTurn: (...args) => { turns.set(args[0], args); },
    };
    const frames = [chunk([
      { index: 0, delta: { content: 'first' }, finish_reason: 'stop' },
      { index: 1, delta: { content: 'second' }, finish_reason: 'stop' },
    ]), doneFrame()];
    for await (const record of irFromOpenAIChatCompletions((async function* () { yield* frames; })(), { maxChoices: 2, roundTrip })) {
      if (record.type === 'operation' && record.operation === 'append') appends.push(record);
    }

    expect(turns.get(0)?.[1].content).toBe('first');
    expect(turns.get(1)?.[1].content).toBe('second');
    expect(turns.get(0)?.[2].content).toBeDefined();
    expect(turns.get(1)?.[2].content).toBeDefined();
    const choiceParts = appends.filter(record => record.path.at(-1) === 'text').map(record => ({ choice: record.path[1], partId: record.partId }));
    expect(choiceParts).toHaveLength(2);
    expect(choiceParts[0].partId).not.toBe(choiceParts[1].partId);
  });

  it('does not attach source part IDs to transformed wrapped custom input', async () => {
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
      builder: createReferenceBuilder(),
      onAssistantTurn: (...args) => { captured = args; },
    };
    const frames = [
      chunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'script', arguments: '{"input":"text"}' } }] }, finish_reason: 'tool_calls' }]),
      doneFrame(),
    ];
    const inputAppends: AppendRecord[] = [];
    for await (const record of irFromOpenAIChatCompletions((async function* () { yield* frames; })(), { customToolNames: new Set(['script']), roundTrip })) {
      if (record.type === 'operation' && record.operation === 'append' && record.path.at(-1) === 'input') inputAppends.push(record);
    }

    expect(inputAppends).toEqual([expect.objectContaining({ value: 'text' })]);
    expect(inputAppends[0]).not.toHaveProperty('partId');
    if (captured === undefined) throw new Error('Expected a captured wrapped Chat assistant turn');
    const toolState = captured[2].tool_calls?.[0];
    expect(toolState !== undefined && 'function' in toolState && toolState.function?.arguments).toBeDefined();
  });

  it('finalizes each choice while another choice has partial audio', async () => {
    const turns = new Map<number, CapturedTurn>();
    const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
      builder: createReferenceBuilder(),
      onAssistantTurn: (...args) => { turns.set(args[0], args); },
    };
    const frames = [
      chunk([
        { index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
        { index: 1, delta: { role: 'assistant', audio: { id: 'audio', data: 'YQ==' } }, finish_reason: null },
      ]),
      chunk([{ index: 1, delta: { audio: { transcript: 'a', expires_at: 10 } }, finish_reason: 'stop' }]),
      doneFrame(),
    ];
    for await (const _record of irFromOpenAIChatCompletions((async function* () { yield* frames; })(), { maxChoices: 2, roundTrip })) {}

    expect(turns.get(0)?.[1]).toMatchObject({ role: 'assistant', content: 'done' });
    expect(turns.get(1)?.[1]).toMatchObject({ role: 'assistant', audio: { id: 'audio' } });
  });

  it('rejects incomplete audio when its own choice finalizes', async () => {
    const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
      builder: createReferenceBuilder(),
      onAssistantTurn: () => {},
    };
    const reader = irFromOpenAIChatCompletions((async function* () {
      yield chunk([{ index: 0, delta: { role: 'assistant', audio: { id: 'audio', data: 'YQ==' } }, finish_reason: 'stop' }]);
    })(), { roundTrip });
    await expect((async () => { for await (const _record of reader) {} })()).rejects.toThrow('audio ended without its complete metadata');
  });
});

it('collects a native assistant turn for a finish-only Chat choice with omitted delta', async () => {
  const choice = { index: 0, delta: {}, finish_reason: 'stop' as const };
  Reflect.deleteProperty(choice, 'delta');
  expect(choice).not.toHaveProperty('delta');

  const turns = await drain([chunk([choice])]);

  expect([...turns]).toEqual([[0, { role: 'assistant', content: null, refusal: null }]]);
});

it('collects every native Chat choice when a sibling omits delta', async () => {
  const emptyChoice = { index: 0, delta: {}, finish_reason: 'stop' as const };
  Reflect.deleteProperty(emptyChoice, 'delta');
  expect(emptyChoice).not.toHaveProperty('delta');
  const delta = { role: 'assistant' as const, content: 'Hello', reasoning_content: 'Think', provider_specific_fields: { trace: 'native' } };

  const turns = await drain([
    chunk([emptyChoice, { index: 1, delta, finish_reason: null }]),
    chunk([{ index: 1, delta: { content: ' world' }, finish_reason: 'stop' }]),
  ]);

  expect([...turns]).toEqual([
    [0, { role: 'assistant', content: null, refusal: null }],
    [1, { role: 'assistant', content: 'Hello world', refusal: null, reasoning_content: 'Think', provider_specific_fields: { trace: 'native' } }],
  ]);
});
