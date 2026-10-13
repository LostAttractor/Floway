import { expect, it } from 'vitest';

import { codexMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';
import { upstreamMetricAxisPriority } from '@floway-dev/provider/browser';

it('uses actual durations and active limits to identify reordered Codex windows', () => {
  const snapshot = { observed_at: '2026-10-01T00:00:00Z', active_limit: 'codex', primary_used_percent: 25, primary_window_minutes: 300, secondary_used_percent: 50, secondary_window_minutes: 10080, credits_balance: 0 };
  const reordered = { ...snapshot, primary_used_percent: 50, primary_window_minutes: 10080, secondary_used_percent: 25, secondary_window_minutes: 300 };
  expect(codexMetrics(snapshot).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
    .toEqual(codexMetrics(reordered).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  const identity = { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } };
  expect(resolveUpstreamMetricDisplay(identity)).toMatchObject({ name: '', unit: 'percent', axisPriority: upstreamMetricAxisPriority.subscriptionQuota, windowSeconds: 18_000, emptyValue: null, form: 'area' });
  expect(codexMetrics(snapshot).find(metric => metric.name === 'credits.balance')?.value).toBe(0);
  expect(codexMetrics({ observed_at: snapshot.observed_at, primary_used_percent: 50 })).toHaveLength(0);
});

it('displays remaining window quota while preserving credit balances', () => {
  const window = resolveUpstreamMetricDisplay({ name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } })!;
  expect([0, 25, 100].map(window.toDisplayValue)).toEqual([100, 75, 0]);
  const credits = resolveUpstreamMetricDisplay({ name: 'credits.balance', labels: {} })!;
  expect(credits.axisPriority).toBe(upstreamMetricAxisPriority.purchasedBalance);
  expect(credits.toDisplayValue(200)).toBe(200);
});
