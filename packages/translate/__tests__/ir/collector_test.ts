import { expect, test } from 'vitest';

import { createIRCollector } from '../../src/ir/collector.ts';

test('collector owns skeleton state and reads only published fields', () => {
  const collector = createIRCollector();
  collector.apply({ type: 'operation', operation: 'initialize', path: ['usage'], value: { output_tokens_inclusive: 99 } });
  expect(collector.state.usage).toEqual({ output_tokens_inclusive: 99 });
  expect(collector.read(['usage'])).toBeUndefined();
  collector.apply({ type: 'operation', operation: 'assign', path: ['usage', 'output_tokens_inclusive'], value: 0 });
  expect(collector.state.usage).toEqual({ output_tokens_inclusive: 0 });
  expect(collector.read(['usage'])).toEqual({ output_tokens_inclusive: 0 });
});

test('collector replaces publication paths with the assigned parent snapshot', () => {
  const collector = createIRCollector();
  collector.apply({ type: 'operation', operation: 'assign', path: ['usage'], value: { input_tokens_inclusive: 1, output_tokens_inclusive: 2 } });
  collector.apply({ type: 'operation', operation: 'assign', path: ['usage'], value: { output_tokens_inclusive: 3 } });
  expect(collector.has(['usage', 'input_tokens_inclusive'])).toBe(false);
  expect(collector.read(['usage', 'input_tokens_inclusive'])).toBeUndefined();
  expect(collector.state.usage).toEqual({ output_tokens_inclusive: 3 });
  expect(collector.read(['usage'])).toEqual({ output_tokens_inclusive: 3 });
});

test('failed operations publish nothing and leave collected state intact', () => {
  const collector = createIRCollector();
  expect(() => collector.apply({ type: 'operation', operation: 'assign', path: ['choices', 1], value: { items: [] } })).toThrow();
  expect(collector.state.choices).toEqual([]);
  expect(collector.within(['choices'])).toBe(false);
  collector.apply({ type: 'operation', operation: 'initialize', path: ['extensions', 'text'], value: '' });
  collector.apply({ type: 'operation', operation: 'append', path: ['extensions', 'text'], value: 'actual' });
  expect(() => collector.apply({ type: 'operation', operation: 'initialize', path: ['extensions', 'text'], value: 'invalid' })).toThrow('absent target');
  expect(collector.read(['extensions', 'text'])).toBe('actual');
});
