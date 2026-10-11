import { expect, test } from 'vitest';

import { LEGACY_BALANCE, USAGE_TOTALS, accountUsage } from './usage-fixture.ts';
import { ollamaMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';

test('credit balances and period consumption retain distinct money gauges', () => {
  expect([...ollamaMetrics(accountUsage())]).toEqual([
    ['["balance","included"]', 18], ['["allowance","included"]', 60], ['["balance","purchased"]', 25], ['["activity_cost","7d"]', 3.25],
  ]);
});

test('legacy plans retain percentage gauges and omit monetary usage when not supplied', () => {
  expect([...ollamaMetrics({ balance: LEGACY_BALANCE, usage: { ...USAGE_TOTALS, totals: { request_count: 15 } } })]).toEqual([
    ['["window","session"]', 75], ['["window","weekly"]', 60], ['["balance","purchased"]', 25],
  ]);
});

test('historical metric keys remain readable independently of the retired response format', () => {
  expect(resolveUpstreamMetricDisplay('["activity_cost","last_4_weeks"]')).toEqual({ name: 'cost_last_4_weeks', unit: 'usd', windowMinutes: null, emptyValue: null, form: 'area', toDisplayValue: expect.any(Function) });
});

test('displays remaining legacy windows and preserves monetary gauges', () => {
  for (const name of ['session', 'weekly']) {
    expect(resolveUpstreamMetricDisplay(JSON.stringify(['window', name])).toDisplayValue(25)).toBe(25);
  }
  for (const key of [['balance', 'included'], ['balance', 'purchased'], ['activity_cost', '7d']]) {
    expect(resolveUpstreamMetricDisplay(JSON.stringify(key)).toDisplayValue(3.25)).toBe(3.25);
  }
});

test('preserves full and exhausted legacy windows without inverting their raw values', () => {
  const balance = { ...LEGACY_BALANCE, included: { session: { ...LEGACY_BALANCE.included.session, remaining_percent: 0 }, weekly: { ...LEGACY_BALANCE.included.weekly, remaining_percent: 100 } } };
  const metrics = ollamaMetrics({ balance, usage: USAGE_TOTALS });
  expect(metrics.get('["window","session"]')).toBe(0);
  expect(metrics.get('["window","weekly"]')).toBe(100);
});

test('records zero and changed included allowances separately from remaining balance', () => {
  for (const allowance_usd of [0, 60, 120]) {
    const base = accountUsage();
    const body = { ...base, balance: { ...base.balance, included: { ...base.balance.included, allowance_usd } } };
    const metrics = ollamaMetrics(body);
    expect(metrics.get('["allowance","included"]')).toBe(allowance_usd);
    expect(metrics.get('["balance","included"]')).toBe(18);
  }
  const display = resolveUpstreamMetricDisplay('["allowance","included"]');
  expect(display).toMatchObject({ name: 'included_allowance', unit: 'usd', form: 'line', emptyValue: null });
  expect(display.toDisplayValue(60)).toBe(60);
});
