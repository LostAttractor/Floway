import { expect, test } from 'vitest';

import { collect, iterate } from './helpers.ts';
import type { IR } from '../../src/ir/model.ts';
import { applyIROperation, consumeIRRecords, createIRBuilder, type IRRecord } from '../../src/ir/stream.ts';
import { anthropicMessagesFromIR } from '../../src/protocols/anthropic-messages/as-source/sse-to.ts';
import { geminiGenerateContentFromIR } from '../../src/protocols/gemini-generate-content/as-source/sse-to.ts';
import { openaiChatCompletionsFromIR } from '../../src/protocols/openai-chat-completions/as-source/sse-to.ts';
import { openaiResponsesFromIR } from '../../src/protocols/openai-responses/as-source/sse-to.ts';

const operation = (operation: 'initialize' | 'assign', path: (string | number)[], value: any): IRRecord => ({ type: 'operation', operation, path, value });
const finish: IRRecord[] = [{ type: 'choice_end', choice: 0, finish_reason: 'stop' }, { type: 'finish', status: 'completed' }];
const writers = [['ChatCompletions', openaiChatCompletionsFromIR], ['Responses', openaiResponsesFromIR], ['Messages', anthropicMessagesFromIR], ['GenerateContent', geminiGenerateContentFromIR]] as const;

const skeleton = (): IRRecord[] => [
  operation('initialize', ['choices', 0], { items: [] }),
  operation('initialize', ['choices', 0, 'items', 0], { type: 'message', content: [{ type: 'text', text: 'SKELETON' }, { type: 'audio', audio: { data: 'SKELETON', transcript: 'SKELETON' } }, { type: 'image', image: { data: 'SKELETON' } }] }),
  operation('initialize', ['choices', 0, 'items', 1], { type: 'reasoning', summary: ['SKELETON'], encrypted_content: 'SKELETON' }),
  operation('initialize', ['choices', 0, 'items', 2], { type: 'function_call', name: 'SKELETON', arguments: 'SKELETON' }),
  operation('initialize', ['extensions', 'openaiResponses'], { service_tier: 'SKELETON', item_ids: { 1: 'SKELETON' } }),
  operation('initialize', ['usage'], { input_tokens_inclusive: 999, output_tokens_inclusive: 999 }),
  { type: 'start', id: 'source', model: 'model', created: 1 },
];

for (const [name, writer] of writers) {
  test(`${name} emits no initialized payload regardless of frame grouping`, async () => {
    const records = [...skeleton(), ...finish];
    const together = await collect<any>(writer(iterate([{ records }])));
    const separate = await collect<any>(writer(iterate(records.map(record => ({ records: [record] })))));
    const normalize = (frames: any[]) => JSON.stringify(frames).replace(/resp_[a-f0-9]+/g, 'resp_ID');
    expect(normalize(together)).toBe(normalize(separate));
    expect(JSON.stringify(together)).not.toContain('SKELETON');
    expect(JSON.stringify(together)).not.toContain('999');
  });
  test(`${name} publishes assigned object values following initialization`, async () => {
    const records: IRRecord[] = [...skeleton(), operation('assign', ['choices', 0, 'items', 0], { type: 'message', content: [{ type: 'text', text: 'actual' }] }), ...finish];
    const output = await collect<any>(writer(iterate([{ records }])));
    expect(JSON.stringify(output)).toContain('actual');
    expect(JSON.stringify(output)).not.toContain('SKELETON');
  });
}

test('initialize arrays require the exact next index and never replace existing entries', () => {
  const state: IR = { choices: [], extensions: {} };
  applyIROperation(state, operation('initialize', ['choices', 0], { items: [] }) as any);
  expect(() => applyIROperation(state, operation('initialize', ['choices', 0], { items: [] }) as any)).toThrow('absent target');
  for (const index of [-1, 0.5, 2]) expect(() => applyIROperation(state, operation('initialize', ['choices', index], { items: [] }) as any)).toThrow();
  applyIROperation(state, operation('assign', ['choices', 0], { items: [] }) as any);
  applyIROperation(state, operation('assign', ['choices', 1], { items: [] }) as any);
  expect(state.choices).toHaveLength(2);
});

test('append only accepts an existing string while assign can replace or extend arrays', () => {
  const state: IR = { choices: [], extensions: {} };
  expect(() => applyIROperation(state, { type: 'operation', operation: 'append', path: ['choices'], value: [] } as any)).toThrow('string target');
  expect(() => applyIROperation(state, { type: 'operation', operation: 'append', path: ['extensions', 'missing'], value: 'x' })).toThrow('string target');
  applyIROperation(state, operation('initialize', ['extensions', 'text'], '') as any);
  applyIROperation(state, { type: 'operation', operation: 'append', path: ['extensions', 'text'], value: 'x' });
  expect((state.extensions as any).text).toBe('x');
});

test('publication tracks actual empty values independently from initialized values', async () => {
  const records = [...skeleton(), operation('assign', ['choices', 0, 'items', 0, 'content', 0, 'text'], ''), ...finish];
  const snapshots = await collect(consumeIRRecords(iterate([{ records }])));
  const values = snapshots.at(-1)!.values;
  expect(values.has(['choices', 0, 'items', 0, 'content', 0, 'text'])).toBe(true);
  expect(values.has(['choices', 0, 'items', 0, 'content', 1, 'audio', 'data'])).toBe(false);
  expect(values.read(['choices', 0, 'items', 0, 'content', 0], { type: 'text', text: '' })).toEqual({ text: '' });
});

test('builder creates choices by initialize and items by indexed actual assignment', () => {
  const builder = createIRBuilder();
  builder.item(0, { type: 'message', content: [] });
  expect(builder.drain().records).toEqual([
    operation('initialize', ['choices', 0], { items: [] }),
    operation('assign', ['choices', 0, 'items', 0], { type: 'message', content: [] }),
    { type: 'item_start', choice: 0, item: 0 },
  ]);
});

test('lifecycle envelopes do not publish initialized text and actual empty assignment remains visible', async () => {
  const records: IRRecord[] = [...skeleton(), { type: 'item_start', choice: 0, item: 0 }, { type: 'part_start', choice: 0, item: 0, part: 0 }];
  const initialized = await collect(openaiResponsesFromIR(iterate([{ records: [...records, ...finish] }])));
  expect(JSON.stringify(initialized)).not.toContain('SKELETON');
  expect(initialized.some(frame => frame.type === 'event' && frame.event.type === 'response.content_part.added')).toBe(true);
  const published = [...skeleton(), operation('assign', ['choices', 0, 'items', 0, 'content', 0, 'text'], ''), ...finish];
  const google = await collect(geminiGenerateContentFromIR(iterate([{ records: published }])));
  expect(google.flatMap(frame => (frame.event as any).candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? [])).toEqual([{ text: '' }]);
});

test.each(writers)('%s skips unpublished citation array entries without renumbering source paths', async (_name, writer) => {
  const citation = { type: 'source_citation', source_kind: 'url', source: 'https://example.com', source_label: 'Source', output_text_range: { start: 0, end_exclusive: 1 } };
  const records: IRRecord[] = [
    operation('initialize', ['choices', 0], { items: [] }),
    operation('initialize', ['choices', 0, 'items', 0], { type: 'message', content: [{ type: 'text', text: '', annotations: [citation, citation] }] }),
    { type: 'start', id: 'source', model: 'model', created: 1 },
    operation('assign', ['choices', 0, 'items', 0, 'content', 0, 'text'], 'A'),
    operation('assign', ['choices', 0, 'items', 0, 'content', 0, 'annotations', 1], citation),
    ...finish,
  ];
  const output = await collect<any>(writer(iterate([{ records }])));
  expect(JSON.stringify(output)).toContain('A');
});
