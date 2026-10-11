import { expect, test } from 'vitest';

import { collect, iterate } from './helpers.ts';
import { createIRCollector } from '../../src/ir/collector.ts';
import { consumeIRRecords, createIRBuilder, reconcileIRValue } from '../../src/ir/stream.ts';
import { createIRStringProjection } from '../../src/ir/string-projection.ts';
import { irFromAnthropicMessages } from '../../src/protocols/anthropic-messages/as-target/sse-from.ts';
import { irFromOpenAIChatCompletions } from '../../src/protocols/openai-chat-completions/as-target/sse-from.ts';
import { irFromOpenAIResponses } from '../../src/protocols/openai-responses/as-target/sse-from.ts';
import { eventFrame } from '@floway-dev/protocols/common';

test('collectors borrow record trees and copy only containers first written by that collector', () => {
  const changed = Object.freeze({ text: '' });
  const untouched = Object.freeze({ text: 'shared' });
  const value = Object.freeze({ changed, untouched });
  const operation = { type: 'operation', operation: 'assign', path: ['extensions', 'openaiResponses'], value } as const;
  const first = createIRCollector();
  const second = createIRCollector();
  first.apply(operation);
  second.apply(operation);
  expect(first.state.extensions!.openaiResponses).toBe(value);
  expect(second.state.extensions!.openaiResponses).toBe(value);

  first.apply({ type: 'operation', operation: 'append', path: [...operation.path, 'changed', 'text'], value: 'one' });
  const owned = first.state.extensions!.openaiResponses!;
  expect(owned).not.toBe(value);
  expect(owned.changed).not.toBe(changed);
  expect(owned.untouched).toBe(untouched);
  expect(second.state.extensions!.openaiResponses).toBe(value);
  const ownedChanged = owned.changed;
  first.apply({ type: 'operation', operation: 'append', path: [...operation.path, 'changed', 'text'], value: 'two' });
  expect(first.state.extensions!.openaiResponses).toBe(owned);
  expect(first.state.extensions!.openaiResponses!.changed).toBe(ownedChanged);

  second.apply({ type: 'operation', operation: 'append', path: [...operation.path, 'changed', 'text'], value: 'other' });
  expect(first.read([...operation.path, 'changed', 'text'])).toBe('onetwo');
  expect(second.read([...operation.path, 'changed', 'text'])).toBe('other');
  expect(value.changed.text).toBe('');
});

test('builder transfers skeletons without copying and later operations never modify their records', async () => {
  const builder = createIRBuilder();
  const choice = Object.freeze({ items: Object.freeze([]) });
  const item = Object.freeze({ type: 'message', content: Object.freeze([]) });
  const part = Object.freeze({ type: 'text', text: '' });
  builder.event({ type: 'start', id: 'example', model: 'example' });
  builder.initialize(['choices', 0], choice);
  builder.initialize(['choices', 0, 'items', 0], item);
  builder.initialize(['choices', 0, 'items', 0, 'content', 0], part);
  builder.append(['choices', 0, 'items', 0, 'content', 0, 'text'], 'hello');
  builder.event({ type: 'finish', status: 'completed' });
  const frame = builder.drain();
  expect(frame.records[1].type === 'operation' && frame.records[1].value).toBe(choice);
  expect(frame.records[2].type === 'operation' && frame.records[2].value).toBe(item);
  expect(frame.records[3].type === 'operation' && frame.records[3].value).toBe(part);
  const results = await collect(consumeIRRecords(iterate([frame])));
  expect(results.at(-1)!.collector.state).toEqual(builder.state);
  expect(choice.items).toEqual([]);
  expect(item.content).toEqual([]);
  expect(part.text).toBe('');
});

test('array writes copy the array while retaining immutable sibling values', () => {
  const sibling = Object.freeze({ items: Object.freeze([]) });
  const choices = Object.freeze([sibling]);
  const collector = createIRCollector();
  collector.apply({ type: 'operation', operation: 'assign', path: ['choices'], value: choices });
  expect(collector.state.choices).toBe(choices);
  collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 1], value: { items: [] } });
  expect(collector.state.choices).not.toBe(choices);
  expect(collector.state.choices[0]).toBe(sibling);
  const owned = collector.state.choices;
  collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 2], value: { items: [] } });
  expect(collector.state.choices).toBe(owned);
  expect(choices).toHaveLength(1);
});

test('parent replacement borrows the new record and never reuses the preceding mutable container', () => {
  const collector = createIRCollector();
  const path = ['extensions', 'openaiResponses'] as const;
  collector.apply({ type: 'operation', operation: 'assign', path, value: { text: '' } });
  collector.apply({ type: 'operation', operation: 'append', path: [...path, 'text'], value: 'old' });
  const preceding = collector.state.extensions!.openaiResponses;
  const replacement = Object.freeze({ text: 'new' });
  collector.apply({ type: 'operation', operation: 'assign', path, value: replacement });
  expect(collector.state.extensions!.openaiResponses).toBe(replacement);
  collector.apply({ type: 'operation', operation: 'append', path: [...path, 'text'], value: ' value' });
  expect(collector.state.extensions!.openaiResponses).not.toBe(preceding);
  expect(replacement.text).toBe('new');
  expect(collector.read(path)).toEqual({ text: 'new value' });
});

test('reconciliation snapshots borrowed changed subtrees before transferring them to records', () => {
  const builder = createIRBuilder();
  const next = { nested: [{ text: 'original' }] };
  reconcileIRValue(builder, ['extensions', 'openaiResponses'], undefined, next);
  const record = builder.drain().records[0];
  next.nested[0].text = 'later';
  expect(record).toHaveProperty('value', { nested: [{ text: 'original' }] });
  expect(builder.state.extensions!.openaiResponses).toEqual({ nested: [{ text: 'original' }] });
});

test('projection snapshots own mutable containers and borrow immutable paths', () => {
  const projection = createIRStringProjection();
  const source = Object.freeze(['choices', 0, 'items', 0, 'summary', 0]);
  const target = Object.freeze(['choices', 0, 'delta', 'reasoning']);
  projection.appendSnapshot(source, 'one', target);
  const snapshot = projection.result();
  expect(snapshot.contents[0].path).toBe(target);
  expect(snapshot.projections[0].source_path).toBe(source);
  projection.appendSnapshot(source, 'onetwo', target);
  expect(snapshot.contents[0].text).toBe('one');
  expect(snapshot.projections[0].source_end_exclusive).toBe(3);
  expect(projection.result().contents[0].text).toBe('onetwo');
});

test('published reads transfer independent objects to the caller', () => {
  const collector = createIRCollector();
  const value = { nested: [{ text: 'original' }] };
  const path = ['extensions', 'openaiResponses'] as const;
  collector.apply({ type: 'operation', operation: 'assign', path, value });
  const result = collector.read(path);
  result.nested[0].text = 'changed by caller';
  expect(collector.read(path)).toEqual(value);
  expect(value.nested[0].text).toBe('original');
});

test.each([
  ['ChatCompletions', irFromOpenAIChatCompletions],
  ['Responses', irFromOpenAIResponses],
  ['Messages', irFromAnthropicMessages],
] as const)('%s reader transfers immutable error objects without copying', async (_name, reader) => {
  const error = Object.freeze({ type: 'api_error', message: 'original', details: Object.freeze([Object.freeze({ text: 'original' })]) });
  const frames = await collect(reader(iterate([eventFrame({ type: 'error', error } as any)])));
  const record = frames.flatMap(frame => frame.records).find(record => record.type === 'error');
  expect(record?.error).toBe(error);
});
