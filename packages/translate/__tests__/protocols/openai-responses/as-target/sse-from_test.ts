import { describe, expect, it } from 'vitest';

import type { IRRecord } from '../../../../src/ir/stream.ts';
import { irFromOpenAIResponses } from '../../../../src/protocols/openai-responses/as-target/sse-from.ts';
import type { RoundTripReader } from '../../../../src/round-trip/stream.ts';
import { createReferenceBuilder } from '../../../../src/round-trip/thin/reference-builder.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import { openaiResponsesResultToEvents, type OpenAIResponsesOutputContentBlock, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

type VendorRecordEx = {
  type: string;
  sequence: number;
  payload: { envelope: { ciphertext: string; format: string } };
  [key: string]: unknown;
};
type CapturedTurn = Parameters<RoundTripReader<'openaiResponses'>['onAssistantTurn']>;
type AppendRecord = Extract<IRRecord, { type: 'operation'; operation: 'append' }>;
type OperationRecord = Extract<IRRecord, { type: 'operation' }>;
const operationRecords = (records: readonly IRRecord[]): OperationRecord[] => records.filter((record): record is OperationRecord => record.type === 'operation');

describe('OpenAI Responses round-trip capture', () => {
  it('keeps predeclared text and refusal parts separate while streaming', async () => {
    const response = {
      id: 'source', object: 'response', model: 'model', created_at: 1, status: 'completed', error: null, incomplete_details: null, usage: null,
      output: [{
        type: 'message', id: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'answer', annotations: [] }, { type: 'refusal', refusal: 'blocked' }],
      }],
    } as OpenAIResponsesResultEx;
    const records: IRRecord[] = [];
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'openaiResponses'> = {
      builder: createReferenceBuilder(),
      onAssistantTurn: (...args) => { captured = args; },
    };
    const frames = openaiResponsesResultToEvents(response);
    for await (const record of irFromOpenAIResponses((async function* () { yield* frames; })(), { roundTrip })) records.push(record);
    const operations = operationRecords(records);
    expect(operations.filter(record => record.operation === 'append' && (record.path.at(-1) === 'text' || record.path.at(-1) === 'refusal')).map(record => record.value)).toEqual(['answer', 'blocked']);
    expect(records.filter(record => record.type === 'part_end')).toEqual([
      { type: 'part_end', choice: 0, item: 0, part: 0 },
      { type: 'part_end', choice: 0, item: 0, part: 1 },
    ]);
    expect(operations.filter((record): record is AppendRecord => record.operation === 'append').map(record => record.partId)).toEqual([0, 1]);
    if (captured === undefined) throw new Error('Expected a captured Responses assistant turn');
    const messageState = captured[2][0];
    if (messageState === undefined || !('content' in messageState) || !Array.isArray(messageState.content)) throw new Error('Expected message state');
    expect(messageState.content[0] !== undefined && 'text' in messageState.content[0] && messageState.content[0].text).toBeDefined();
    expect(messageState.content[1] !== undefined && 'refusal' in messageState.content[1] && messageState.content[1].refusal).toBeDefined();
  });

  it('captures supported output fields, preserves opaque items, and retains a null image result', async () => {
    const builder = createReferenceBuilder();
    const order: string[] = [];
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'openaiResponses'> = {
      builder,
      onAssistantTurn: (...args) => { order.push('turn'); captured = args; },
    };
    const vendorRecord: VendorRecordEx & { id: string } = {
      type: 'vendor_record',
      id: 'vendor-record',
      sequence: 7,
      created_by: 'vendor',
      payload: { envelope: { ciphertext: 'opaque-vendor-ciphertext', format: 'opaque' } },
    };
    const response = {
      id: 'source',
      object: 'response',
      model: 'model',
      created_at: 1,
      status: 'completed',
      error: null,
      incomplete_details: null,
      usage: null,
      output: [
        {
          type: 'message',
          id: 'message',
          role: 'assistant',
          status: 'completed',
          phase: 'final',
          internal_chat_message_metadata_passthrough: { keep: true },
          content: [
            { type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [{ token: 'answer' }] },
            { type: 'refusal', refusal: 'blocked' },
          ],
        },
        {
          type: 'reasoning',
          id: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'thought' }],
          content: [{ type: 'reasoning_text', text: 'detail' }],
          encrypted_content: 'sealed',
          provider_opaque: { keep: true },
        },
        {
          type: 'function_call',
          id: 'function',
          call_id: 'call',
          name: 'lookup',
          arguments: '{"query":"x"}',
          status: 'completed',
          provider_opaque: 'tool metadata',
        },
        {
          type: 'custom_tool_call',
          id: 'custom',
          call_id: 'custom-call',
          name: 'script',
          input: 'freeform input',
          status: 'completed',
        },
        { type: 'image_generation_call', id: 'image', status: 'failed', result: null, output_format: 'png' },
        vendorRecord,
      ],
    } as OpenAIResponsesResultEx;
    const frames = [
      eventFrame({ type: 'response.created', response: { ...response, output: [] } } as OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.completed', response } as OpenAIResponsesStreamEventEx),
    ];
    const irRecords: IRRecord[] = [];
    for await (const record of irFromOpenAIResponses((async function* () { yield* frames; })(), { roundTrip })) {
      irRecords.push(record);
      if (record.type === 'choice_end') order.push('choice_end');
    }

    expect(order).toEqual(['turn', 'choice_end']);
    if (captured === undefined) throw new Error('Expected a captured Responses assistant turn');
    const [, turn, fieldState] = captured;
    const { created_by: _createdBy, ...expectedVendorRecord } = vendorRecord;
    expect(turn[5]).toEqual(expectedVendorRecord);
    expect(JSON.stringify(irRecords)).not.toContain('vendor_record');
    expect(JSON.stringify(irRecords)).not.toContain('opaque-vendor-ciphertext');
    expect(turn[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: 'answer' }, { type: 'refusal', refusal: 'blocked' }] });
    expect(Reflect.get(turn[0], 'internal_chat_message_metadata_passthrough')).toEqual({ keep: true });
    expect(turn[1]).toMatchObject({ type: 'reasoning', summary: [{ text: 'thought' }], content: [{ text: 'detail' }], encrypted_content: 'sealed' });
    expect(Reflect.get(turn[1], 'provider_opaque')).toEqual({ keep: true });
    expect(turn[2]).toMatchObject({ type: 'function_call', arguments: '{"query":"x"}' });
    expect(Reflect.get(turn[2], 'provider_opaque')).toBe('tool metadata');
    expect(turn[3]).toMatchObject({ type: 'custom_tool_call', input: 'freeform input' });
    expect(turn[4]).toMatchObject({ type: 'image_generation_call', result: null, output_format: 'png' });
    const messageState = fieldState[0];
    const reasoningState = fieldState[1];
    const functionState = fieldState[2];
    const customState = fieldState[3];
    if (messageState === undefined || !('content' in messageState) || !Array.isArray(messageState.content)) throw new Error('Expected message state');
    if (reasoningState === undefined || !('summary' in reasoningState) || !('content' in reasoningState)) throw new Error('Expected reasoning state');
    expect(messageState.content[0]).toBeDefined();
    expect(messageState.content[1]).toBeDefined();
    expect(reasoningState.summary?.[0]).toBeDefined();
    expect(reasoningState.content?.[0]).toBeDefined();
    expect(functionState !== undefined && 'arguments' in functionState && functionState.arguments).toBeDefined();
    expect(customState !== undefined && 'input' in customState && customState.input).toBeDefined();
    expect(4 in fieldState).toBe(false);
    expect(5 in fieldState).toBe(false);
  });

  it('keeps direct delta atoms while repeated snapshots add no parts', async () => {
    const added: OpenAIResponsesOutputItemEx = { type: 'message', id: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const part: OpenAIResponsesOutputContentBlock = { type: 'output_text', text: 'hello', annotations: [] };
    const done: OpenAIResponsesOutputItemEx = { ...added, status: 'completed', content: [part] };
    const response: OpenAIResponsesResultEx = {
      id: 'source', object: 'response', model: 'model', status: 'completed', error: null, incomplete_details: null, usage: null, output: [done],
    };
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'openaiResponses'> = {
      builder: createReferenceBuilder(),
      onAssistantTurn: (...args) => { captured = args; },
    };
    const frames = [
      eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: added } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.content_part.added', item_id: 'message', output_index: 0, content_index: 0, part: { ...part, text: '' } } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_text.delta', item_id: 'message', output_index: 0, content_index: 0, delta: 'hel' } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_text.delta', item_id: 'message', output_index: 0, content_index: 0, delta: 'lo' } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_text.done', item_id: 'message', output_index: 0, content_index: 0, text: 'hello' } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: done } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.completed', response } satisfies OpenAIResponsesStreamEventEx),
    ];
    const textAppends: AppendRecord[] = [];
    for await (const record of irFromOpenAIResponses((async function* () { yield* frames; })(), { roundTrip })) {
      if (record.type === 'operation' && record.operation === 'append' && record.path.at(-1) === 'text') textAppends.push(record);
    }

    expect(textAppends.map(record => ({ value: record.value, partId: record.partId }))).toEqual([
      { value: 'hel', partId: 0 },
      { value: 'lo', partId: 1 },
    ]);
    if (captured === undefined) throw new Error('Expected captured direct-delta state');
    expect(captured[2]).toMatchObject([{ content: [{ text: {} }] }]);
  });

  it('leaves a field literal when a final snapshot supplies a missing suffix', async () => {
    const added: OpenAIResponsesOutputItemEx = { type: 'message', id: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const part: OpenAIResponsesOutputContentBlock = { type: 'output_text', text: 'hello', annotations: [] };
    const done: OpenAIResponsesOutputItemEx = { ...added, status: 'completed', content: [part] };
    const response: OpenAIResponsesResultEx = {
      id: 'source', object: 'response', model: 'model', status: 'completed', error: null, incomplete_details: null, usage: null, output: [done],
    };
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'openaiResponses'> = {
      builder: createReferenceBuilder(),
      onAssistantTurn: (...args) => { captured = args; },
    };
    const frames = [
      eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: added } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.content_part.added', item_id: 'message', output_index: 0, content_index: 0, part: { ...part, text: '' } } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_text.delta', item_id: 'message', output_index: 0, content_index: 0, delta: 'hel' } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_text.done', item_id: 'message', output_index: 0, content_index: 0, text: 'hello' } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: done } satisfies OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.completed', response } satisfies OpenAIResponsesStreamEventEx),
    ];
    const textAppends: AppendRecord[] = [];
    for await (const record of irFromOpenAIResponses((async function* () { yield* frames; })(), { roundTrip })) {
      if (record.type === 'operation' && record.operation === 'append' && record.path.at(-1) === 'text') textAppends.push(record);
    }

    if (captured === undefined) throw new Error('Expected captured snapshot-suffix turn');
    expect(captured[1][0]).toMatchObject({ type: 'message', content: [{ text: 'hello' }] });
    expect(textAppends.map(record => ({ value: record.value, partId: record.partId }))).toEqual([
      { value: 'hel', partId: 0 },
      { value: 'lo', partId: undefined },
    ]);
    expect(0 in captured[2]).toBe(false);
  });

  it('filters and reindexes sparse field state with the native turn', async () => {
    const message = {
      type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }],
    } as const;
    const response = {
      id: 'source', object: 'response', model: 'model', status: 'completed', error: null, incomplete_details: null, usage: null,
      output: [{ type: 'additional_tools', id: 'tools', role: 'assistant', tools: [] }, message],
    } as OpenAIResponsesResultEx;
    let captured: CapturedTurn | undefined;
    const roundTrip: RoundTripReader<'openaiResponses'> = {
      builder: createReferenceBuilder(),
      onAssistantTurn: (...args) => { captured = args; },
    };
    const frames = [
      eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } } as OpenAIResponsesStreamEventEx),
      eventFrame({ type: 'response.completed', response } as OpenAIResponsesStreamEventEx),
    ];
    for await (const _record of irFromOpenAIResponses((async function* () { yield* frames; })(), { roundTrip })) {}

    if (captured === undefined) throw new Error('Expected a filtered Responses assistant turn');
    expect(captured[1]).toEqual([message]);
    expect(captured[2]).toMatchObject([{ content: [{ text: {} }] }]);
  });
});
