import { describe, expect, test } from 'vitest';

import { createIRCollector } from '../../src/ir/collector.ts';
import { IRNone } from '../../src/ir/types.ts';

describe('IR accumulator', () => {
  test('stores plain accumulated state without publication metadata', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'operation', operation: 'initialize', path: ['usage'], value: {} });
    collector.apply({ type: 'operation', operation: 'assign', path: ['usage', 'output_tokens_inclusive'], value: 0 });
    expect(collector.value(['usage'])).toEqual({ output_tokens_inclusive: 0 });
  });

  test('enforces static append targets', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'x' })).toThrow('append target cannot be assigned');
    collector.apply({ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'x' });
    expect(collector.value(['choices', 0, 'items', 0, 'content', 0, 'text'])).toBe('x');
  });

  test('rejects undefined and only assigns IRNone to absent fields', () => {
    const collector = createIRCollector();
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['model'], value: IRNone })).toThrow('IRNone is not allowed');
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'function_call', name: 'f', arguments: '' } });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: undefined as any })).toThrow('undefined');
    collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: IRNone });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'call_id'], value: IRNone })).toThrow('absent target');
  });

  test('rejects operations after part and item end', () => {
    const collector = createIRCollector();
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0], value: { items: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'message', content: [] } });
    collector.apply({ type: 'operation', operation: 'initialize', path: ['choices', 0, 'items', 0, 'content', 0], value: { type: 'text', text: '' } });
    collector.applyEvent({ type: 'part_end', choice: 0, item: 0, part: 0 });
    expect(() => collector.apply({ type: 'operation', operation: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'late' })).toThrow('closed part');
    collector.applyEvent({ type: 'item_end', choice: 0, item: 0 });
    expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 0, 'items', 0, 'type'], value: 'message' })).toThrow('closed item');
  });
});
