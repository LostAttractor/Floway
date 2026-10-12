import { expect, test } from 'vitest';

import { collectIR, iterate } from './helpers.ts';
import { irFromOpenAIResponses } from '../../src/protocols/openai-responses/as-target/sse-from.ts';
import { eventFrame } from '@floway-dev/protocols/common';

const response = (output: any[] = []) => ({ id: 'resp', model: 'served', created_at: 1, status: 'completed', output, usage: null, error: null, incomplete_details: null });
const read = async (events: any[]) => await collectIR(irFromOpenAIResponses(iterate(events.map(event => eventFrame(event as any)))));

test('empty output_item.done content does not erase streamed text', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const done = { ...added, status: 'completed', content: [] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'visible' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'visible' }] });
});

test('output_item.done supplies a reasoning summary omitted from deltas', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], status: 'in_progress' };
  const done = { ...added, summary: [{ type: 'summary_text', text: 'summary' }], status: 'completed' };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'reasoning', summary: ['summary'] });
});

test('done snapshots append a missing suffix', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const part = { type: 'output_text', text: 'hello', annotations: [] };
  const done = { ...added, status: 'completed', content: [part] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hel' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ text: 'hello' }] });
});

test('non-prefix done snapshots throw', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], status: 'in_progress' };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'tail' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'headtail' },
  ])).rejects.toThrow('cannot replace streamed text');
});

test('text done does not close the field and later deltas remain valid', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const part = { type: 'output_text', text: 'codex', annotations: [] };
  const done = { ...added, status: 'completed', content: [part] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'cod' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'cod' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ex' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ text: 'codex' }] });
});

test('terminal response closes an item without output_item.done', async () => {
  const added = { type: 'function_call', id: 'fc', call_id: 'call', name: 'tool', arguments: '', status: 'in_progress' };
  const done = { ...added, arguments: '{}', status: 'completed' };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'function_call', arguments: '{}' });
});

test.each([
  ['type', { type: 'reasoning', id: 'msg', summary: [] }, 'type changed'],
  ['id', { type: 'message', id: 'other', role: 'assistant', status: 'completed', content: [] }, 'id changed'],
] as const)('output_item.done rejects a snapshot %s mismatch', async (_name, done, message) => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
  ])).rejects.toThrow(message);
});

test('output_item.done initializes snapshot-only content and logprobs', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const token = { token: 'x', logprob: -1, bytes: [120], top_logprobs: [] };
  const done = { ...added, status: 'completed', content: [{ type: 'output_text', text: 'x', annotations: [], logprobs: [token] }] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ text: 'x' }] });
  expect(result.choices[0].logprobs?.[0].tokens).toEqual([token]);
});

test('empty final reasoning summary preserves streamed content', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], status: 'in_progress' };
  const done = { ...added, status: 'completed' };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'visible' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'reasoning', summary: ['visible'] });
});

test('a second output_item.added at an announced index throws', async () => {
  const item = { type: 'reasoning', id: 'rs', summary: [] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.added', output_index: 0, item },
  ])).rejects.toThrow('Duplicate Responses output_item.added');
});
