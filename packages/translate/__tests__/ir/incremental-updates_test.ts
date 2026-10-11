import { expect, test, vi } from 'vitest';

import { collect, iterate } from './helpers.ts';
import { createIRCollector } from '../../src/ir/collector.ts';
import { irChangedItems } from '../../src/ir/item-updates.ts';
import type { IRFrame } from '../../src/ir/stream.ts';
import { anthropicMessagesFromIR } from '../../src/protocols/anthropic-messages/as-source/sse-to.ts';
import { geminiGenerateContentFromIR } from '../../src/protocols/gemini-generate-content/as-source/sse-to.ts';
import { openaiChatCompletionsFromIR } from '../../src/protocols/openai-chat-completions/as-source/sse-to.ts';
import { irFromOpenAIChatCompletions } from '../../src/protocols/openai-chat-completions/as-target/sse-from.ts';
import { openaiResponsesFromIR } from '../../src/protocols/openai-responses/as-source/sse-to.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const writers = [['ChatCompletions', openaiChatCompletionsFromIR], ['Responses', openaiResponsesFromIR], ['Messages', anthropicMessagesFromIR], ['GenerateContent', geminiGenerateContentFromIR]] as const;

test.each(writers)('%s does not read unrelated historical items for a single text append', async (_name, writer) => {
  const content = [{ type: 'text', text: 'unrelated' }];
  const read = vi.fn(() => content);
  const untouched = { type: 'message', get content() { return read(); } };
  const frames = async function* (): AsyncGenerator<IRFrame> {
    yield { records: [{ type: 'start', id: 'source', model: 'model' }, { type: 'operation', operation: 'assign', path: ['choices'], value: [{ items: [{ type: 'message', content: [{ type: 'text', text: 'first' }] }, untouched] }] }] };
    read.mockClear();
    yield { records: [{ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: ' delta' }] };
    expect(read).not.toHaveBeenCalled();
    yield { records: [{ type: 'choice_end', choice: 0, finish_reason: 'stop' }, { type: 'finish', status: 'completed' }] };
  };
  expect(JSON.stringify(await collect<any>(writer(frames())))).toContain(' delta');
});

test('logprob owner routing waits for both owner indexes to be published', () => {
  const collector = createIRCollector();
  collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0], value: { items: [{ type: 'message', content: [{ type: 'text', text: '' }] }] } });
  collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'logprobs'], value: [{ tokens: [] }] });
  const scope = { type: 'operation', operation: 'assign', path: ['choices', 0, 'logprobs', 0, 'scope'], value: 'text_part' } as const;
  collector.apply(scope);
  expect([...irChangedItems(collector, scope).get(0)!]).toEqual([]);
  collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'logprobs', 0, 'item_index'], value: 0 });
  const part = { type: 'operation', operation: 'assign', path: ['choices', 0, 'logprobs', 0, 'content_index'], value: 0 } as const;
  collector.apply(part);
  expect([...irChangedItems(collector, part).get(0)!]).toEqual([0]);
});

test('Responses preserves every streamed ChatCompletions token once in the final text snapshot', async () => {
  const tokens = Array.from({ length: 64 }, (_, index) => ({ token: String(index), logprob: -index, bytes: null, top_logprobs: [] }));
  const frames = tokens.map(token => eventFrame({ id: 'source', model: 'model', created: 1, choices: [{ index: 0, delta: { content: token.token }, logprobs: { content: [token], refusal: null }, finish_reason: null }] } as any));
  frames.push(eventFrame({ id: 'source', model: 'model', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any));
  const output = await collect(openaiResponsesFromIR(irFromOpenAIChatCompletions(iterate([...frames, doneFrame()]))));
  const done = output.find(frame => frame.type === 'event' && frame.event.type === 'response.output_text.done');
  expect(done).toMatchObject({ event: { text: tokens.map(token => token.token).join(''), logprobs: tokens } });
});

test.each(writers)('%s does not read unrelated parts for a single text append', async (_name, writer) => {
  const read = vi.fn(() => 'unrelated');
  const untouched = { type: 'text', get text() { return read(); } };
  const frames = async function* (): AsyncGenerator<IRFrame> {
    yield { records: [{ type: 'start', id: 'source', model: 'model' }, { type: 'operation', operation: 'assign', path: ['choices'], value: [{ items: [{ type: 'message', content: [{ type: 'text', text: 'first' }, untouched] }] }] }] };
    read.mockClear();
    yield { records: [{ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: ' delta' }] };
    expect(read).not.toHaveBeenCalled();
    yield { records: [{ type: 'choice_end', choice: 0, finish_reason: 'stop' }, { type: 'finish', status: 'completed' }] };
  };
  expect(JSON.stringify(await collect<any>(writer(frames())))).toContain(' delta');
});

test('GenerateContent releases a buffered text run only after its preceding tool closes', async () => {
  let closed = false;
  const frames = async function* (): AsyncGenerator<IRFrame> {
    yield { records: [{ type: 'start', id: 'source', model: 'model' }, { type: 'operation', operation: 'assign', path: ['choices'], value: [{ items: [{ type: 'function_call', name: 'tool', call_id: 'call', arguments: '' }, { type: 'message', content: [{ type: 'text', text: 'after tool' }] }] }] }] };
    for (const value of ['{', '"key"', ':1', '}']) yield { records: [{ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'arguments'], value }] };
    closed = true;
    yield { records: [{ type: 'item_end', choice: 0, item: 0, status: 'completed' }, { type: 'choice_end', choice: 0, finish_reason: 'tool_calls' }, { type: 'finish', status: 'completed' }] };
  };
  const parts = [];
  for await (const frame of geminiGenerateContentFromIR(frames())) {
    const current = (frame.event as any).candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? [];
    if (current.length > 0) expect(closed).toBe(true);
    parts.push(...current);
  }
  expect(parts).toEqual([{ functionCall: { id: 'call', name: 'tool', args: { key: 1 } } }, { text: 'after tool' }]);
});
