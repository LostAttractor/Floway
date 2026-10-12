import { expect, test } from 'vitest';

import { collect, iterate } from './helpers.ts';
import { createIRCollector } from '../../src/ir/collector.ts';
import { createIRBuilder, type IRRecord } from '../../src/ir/stream.ts';
import { anthropicMessagesFromIR } from '../../src/protocols/anthropic-messages/as-source/sse-to.ts';
import { geminiGenerateContentFromIR } from '../../src/protocols/gemini-generate-content/as-source/sse-to.ts';
import { openaiChatCompletionsFromIR } from '../../src/protocols/openai-chat-completions/as-source/sse-to.ts';
import { openaiResponsesFromIR } from '../../src/protocols/openai-responses/as-source/sse-to.ts';

const writers = [['ChatCompletions', openaiChatCompletionsFromIR], ['Responses', openaiResponsesFromIR], ['Messages', anthropicMessagesFromIR], ['GenerateContent', geminiGenerateContentFromIR]] as const;

const stream = (): IRRecord[] => [
  { type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } },
  { type: 'operation', operation: 'assign', path: ['model'], value: 'model' },
  { type: 'start', id: 'source', created: 1 },
  { type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } },
  { type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } },
  { type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'actual' },
  { type: 'part_end', choice: 0, item: 0, part: 0 },
  { type: 'item_end', choice: 0, item: 0 },
  { type: 'choice_end', choice: 0, finish_reason: 'stop' },
  { type: 'finish', status: 'completed' },
];

test.each(writers)('%s gives frame grouping no semantic meaning', async (_name, writer) => {
  const records = stream();
  const together = await collect<any>(writer(iterate([{ records }])));
  const separate = await collect<any>(writer(iterate(records.map(record => ({ records: [record] })))));
  const normalize = (frames: any[]) => JSON.stringify(frames).replace(/resp_[a-f0-9]+/g, 'resp_ID').replace(/(?:msg|rs)_[a-f0-9]+/g, 'ITEM_ID');
  expect(normalize(together)).toBe(normalize(separate));
});

test('initialize carries real required fields while append targets start empty', async () => {
  const records: IRRecord[] = [
    { type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } },
    { type: 'operation', operation: 'assign', path: ['model'], value: 'model' },
    { type: 'start', id: 'source' },
    { type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call', call_id: 'call', name: 'real-name', arguments: '' } },
    { type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'arguments'], value: '{}' },
    { type: 'item_end', choice: 0, item: 0 },
    { type: 'choice_end', choice: 0, finish_reason: 'tool_calls' },
    { type: 'finish', status: 'completed' },
  ];
  const output = await collect(openaiResponsesFromIR(iterate([{ records }])));
  const serialized = JSON.stringify(output);
  expect(serialized).toContain('real-name');
  expect(serialized).toContain('{}');
});

test('initialize arrays require the exact next index and never replace entries', () => {
  const collector = createIRCollector();
  collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
  expect(() => collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } })).toThrow('absent target');
  for (const index of [-1, 0.5, 2]) expect(() => collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', index], value: { items: [] } })).toThrow();
  collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 1], value: { items: [] } });
  expect(collector.state.choices).toHaveLength(2);
});

test('append accepts only statically declared string fields', () => {
  const collector = createIRCollector();
  collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
  collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
  collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } });
  expect(() => collector.apply({ type: 'operation', operation: 'append', path: ['model'], value: 'x' })).toThrow('append-target path');
  collector.apply({ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'x' });
  expect(collector.value(['choices', 0, 'items', 0, 'content', 0, 'text'])).toBe('x');
});

test('builder initializes items without separate start events', () => {
  const builder = createIRBuilder();
  builder.item(0, { type: 'message', content: [] });
  expect(builder.drain().records).toEqual([
    { type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } },
    { type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } },
  ]);
});
