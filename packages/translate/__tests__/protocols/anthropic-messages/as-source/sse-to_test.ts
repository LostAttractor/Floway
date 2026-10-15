import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../../src/ir/stream.ts';
import { anthropicMessagesFromIR } from '../../../../src/protocols/anthropic-messages/as-source/sse-to.ts';
import type { RoundTripWriter } from '../../../../src/round-trip/stream.ts';
import { appendField, collectContentViews, createReferenceBuilder, createFieldState, createReferenceFinalizer } from '../../../../src/round-trip/thin/reference-builder.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

test('collects Messages output state from emitted IR atoms', async () => {
  const references = createReferenceBuilder();
  const textField = createFieldState('text');
  const reasoningField = createFieldState('text');
  const argumentsField = createFieldState('json');
  const textParts = ['A', 'B'].map(part => appendField(references, textField, part));
  const reasoningParts = ['S', 'C'].map(part => appendField(references, reasoningField, part));
  const argumentParts = ['{"x":', '1}'].map(part => appendField(references, argumentsField, part));
  let prepared: Parameters<RoundTripWriter<'anthropicMessages'>['prepareSidecar']> | undefined;
  const roundTrip: RoundTripWriter<'anthropicMessages'> = {
    builder: references,
    prepareSidecar: async (...args) => { prepared = args; return 'sidecar'; },
  };
  const builder = createIRBuilder();
  builder.choice(0);
  builder.assign(['model'], 'model');
  builder.event({ type: 'start', id: 'response' });
  builder.initialize(['choices', 0, 'items', 0], { type: 'reasoning', summary: [''], content: [''] });
  builder.append(['choices', 0, 'items', 0, 'summary', 0], 'S', reasoningParts[0]);
  builder.append(['choices', 0, 'items', 0, 'content', 0], 'C', reasoningParts[1]);
  builder.event({ type: 'item_end', choice: 0, item: 0 });
  builder.initialize(['choices', 0, 'items', 1], { type: 'message', content: [] });
  builder.initialize(['choices', 0, 'items', 1, 'content', 0], { type: 'text', text: '' });
  builder.append(['choices', 0, 'items', 1, 'content', 0, 'text'], 'A', textParts[0]);
  builder.append(['choices', 0, 'items', 1, 'content', 0, 'text'], 'B', textParts[1]);
  builder.event({ type: 'part_end', choice: 0, item: 1, part: 0 });
  builder.event({ type: 'item_end', choice: 0, item: 1 });
  builder.initialize(['choices', 0, 'items', 2], { type: 'function_call', call_id: 'call', name: 'lookup', arguments: '' });
  builder.append(['choices', 0, 'items', 2, 'arguments'], '{"x":', argumentParts[0]);
  builder.append(['choices', 0, 'items', 2, 'arguments'], '1}', argumentParts[1]);
  builder.event({ type: 'item_end', choice: 0, item: 2 });
  builder.event({ type: 'choice_end', choice: 0, finish_reason: 'tool_calls' });
  builder.event({ type: 'finish', status: 'completed' });

  for await (const _frame of anthropicMessagesFromIR((async function* () { yield* builder.drain(); })(), { roundTrip })) {}
  if (prepared === undefined) throw new Error('Messages sidecar was not prepared');
  const [, , turn, state] = prepared;
  expect(turn.content).toMatchObject([
    { type: 'thinking', thinking: 'SC' },
    { type: 'text', text: 'AB' },
    { type: 'tool_use', input: { x: 1 } },
  ]);
  expect(state.content?.[0]).toBeDefined();
  expect(state.content?.[1]).toBeDefined();
  expect(state.content?.[2]).toBeDefined();
  const finalizer = await createReferenceFinalizer(references, collectContentViews(turn, state));
  expect(await finalizer.finalizeField('AB', textField)).not.toBe('AB');
  expect(await finalizer.finalizeField('SC', reasoningField)).not.toBe('SC');
  expect(await finalizer.finalizeField({ x: 1 }, argumentsField)).not.toEqual({ x: 1 });
});

test('resolves blocked reasoning in emitted summary/content order before live appends', async () => {
  const references = createReferenceBuilder();
  const summary = createFieldState('text');
  const content = createFieldState('text');
  const a = appendField(references, summary, 'A');
  const x = appendField(references, content, 'X');
  const b = appendField(references, summary, 'B');
  const c = appendField(references, summary, 'C');
  const source = createIRBuilder();
  source.choice(0);
  source.assign(['model'], 'model');
  source.event({ type: 'start', id: 'response' });
  const tool = source.item(0, { type: 'function_call', name: 'blocker', arguments: '' });
  tool.append('arguments', '{}');
  const reasoning = source.item(0, { type: 'reasoning', summary: [''], content: [''] });
  reasoning.append(['summary', 0], 'A', a);
  reasoning.append(['content', 0], 'X', x);
  reasoning.append(['summary', 0], 'B', b);
  tool.assign('call_id', 'blocker');
  reasoning.append(['summary', 0], 'C', c);
  reasoning.end();
  tool.end();
  source.choice(0).end('tool_calls');
  source.event({ type: 'finish', status: 'completed' });

  let prepared: Parameters<RoundTripWriter<'anthropicMessages'>['prepareSidecar']> | undefined;
  const roundTrip: RoundTripWriter<'anthropicMessages'> = {
    builder: references,
    prepareSidecar: async (...args) => { prepared = args; return 'sidecar'; },
  };
  const events: AnthropicMessagesStreamEventEx[] = [];
  for await (const frame of anthropicMessagesFromIR((async function* () { yield* source.drain(); })(), { roundTrip })) events.push(frame.event);
  expect(events.flatMap(event => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' ? [event.delta.thinking] : [])).toEqual(['ABX', 'C']);
  if (prepared === undefined) throw new Error('Messages sidecar was not prepared');
  const [, , turn, state] = prepared;
  expect(turn.content).toContainEqual(expect.objectContaining({ type: 'thinking', thinking: 'ABXC' }));
  const finalizer = await createReferenceFinalizer(references, collectContentViews(turn, state));
  expect(await finalizer.finalizeField('ABC', summary)).toMatchObject({ value: [[1, 0, 2], [1, 3, 4]] });
  expect(await finalizer.finalizeField('X', content)).toMatchObject({ value: [[1, 2, 3]] });
});
