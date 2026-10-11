import { expect, it } from 'vitest';

import { codexMetrics, resolveUpstreamMetricDisplayName } from '../src/upstream-metrics.ts';

it('uses actual durations and active limits to identify reordered Codex windows', () => {
  const snapshot = { observed_at: '2026-10-01T00:00:00Z', active_limit: 'codex', primary_used_percent: 25, primary_window_minutes: 300, secondary_used_percent: 50, secondary_window_minutes: 10080, credits_balance: 0 };
  const reordered = { ...snapshot, primary_used_percent: 50, primary_window_minutes: 10080, secondary_used_percent: 25, secondary_window_minutes: 300 };
  expect([...codexMetrics(snapshot)].sort()).toEqual([...codexMetrics(reordered)].sort());
  const key = JSON.stringify(['window', 'codex', 300]);
  expect(resolveUpstreamMetricDisplayName(key)).toEqual({ name: '', unit: 'percent', windowMinutes: 300, emptyValue: null, form: 'area', toDisplayValue: expect.any(Function) });
  expect(codexMetrics(snapshot).get('["balance","credits"]')).toBe(0);
  expect(codexMetrics({ observed_at: snapshot.observed_at, primary_used_percent: 50 }).size).toBe(0);
});

it('displays remaining window quota while preserving credit balances', () => {
  const window = resolveUpstreamMetricDisplayName('["window","codex",300]');
  expect([0, 25, 100].map(window.toDisplayValue)).toEqual([100, 75, 0]);
  expect(resolveUpstreamMetricDisplayName('["balance","credits"]').toDisplayValue(200)).toBe(200);
});
