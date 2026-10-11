import { expect, test } from 'vitest';

import { LEGACY_BALANCE, USAGE_TOTALS, accountUsage } from './usage-fixture.ts';
import { ollamaUsageMetrics, resolveUsageMetricDisplayName } from '../src/usage-metrics.ts';

test('credit balances and period consumption retain distinct money gauges', () => {
  expect([...ollamaUsageMetrics(accountUsage())]).toEqual([
    ['["balance","included"]', 18], ['["balance","purchased"]', 25], ['["activity_cost","7d"]', 3.25],
  ]);
});

test('legacy plans retain percentage gauges and omit monetary usage when not supplied', () => {
  expect([...ollamaUsageMetrics({ balance: LEGACY_BALANCE, usage: { ...USAGE_TOTALS, totals: { request_count: 15 } } })]).toEqual([
    ['["window","session"]', 25], ['["window","weekly"]', 40], ['["balance","purchased"]', 25],
  ]);
});

test('historical metric keys remain readable independently of the retired response format', () => {
  expect(resolveUsageMetricDisplayName('["activity_cost","last_4_weeks"]')).toEqual({ name: 'cost_last_4_weeks', unit: 'usd', windowMinutes: null, emptyValue: null, form: 'area', toDisplayValue: expect.any(Function) });
});

test('displays remaining legacy windows and preserves monetary gauges', () => {
  for (const name of ['session', 'weekly']) {
    expect(resolveUsageMetricDisplayName(JSON.stringify(['window', name])).toDisplayValue(25)).toBe(75);
  }
  for (const key of [['balance', 'included'], ['balance', 'purchased'], ['activity_cost', '7d']]) {
    expect(resolveUsageMetricDisplayName(JSON.stringify(key)).toDisplayValue(3.25)).toBe(3.25);
  }
});
