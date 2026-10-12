import { expect, it } from 'vitest';

import { copilotMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';

it('retains arbitrary metered Copilot quantities and omits unavailable and unlimited quotas', () => {
  const quota = { entitlement: 100, percent_remaining: 80, quota_remaining: 80, unlimited: false, overage_count: 0, overage_permitted: false };
  expect(copilotMetrics({ observed_at: '2026-10-01T00:00:00Z', reset_at: null, quotas: { future_metric: quota, unavailable: { ...quota, entitlement: 0, percent_remaining: 0 }, unlimited: { ...quota, entitlement: -1, unlimited: true } } })).toEqual([
    { name: 'quota.remaining', labels: { quota: 'future_metric' }, value: 80 },
    { name: 'quota.entitlement', labels: { quota: 'future_metric' }, value: 100 },
  ]);
  expect(resolveUpstreamMetricDisplay({ name: 'quota.remaining', labels: { quota: 'future_metric' } }).name).toBe('remaining_future_metric');
});

it('records fractional remaining quantities and changed allowances without storing percentages', () => {
  for (const [remaining, entitlement] of [[0, 300], [300, 300], [9_719_759.1, 10_000_000], [600, 600]]) {
    const metrics = copilotMetrics({ observed_at: '2026-10-01T00:00:00Z', reset_at: null, quotas: { premium_interactions: { entitlement: entitlement!, percent_remaining: 97.1, quota_remaining: remaining!, unlimited: false, overage_count: 0, overage_permitted: false } } });
    expect(metrics).toEqual([
      { name: 'quota.remaining', labels: { quota: 'premium_interactions' }, value: remaining },
      { name: 'quota.entitlement', labels: { quota: 'premium_interactions' }, value: entitlement },
    ]);
  }
});

it('displays raw remaining quantities and allowances on the same numeric scale', () => {
  for (const [name, quantity, form] of [['quota.remaining', 'remaining', 'area'], ['quota.entitlement', 'entitlement', 'line']] as const) {
    const display = resolveUpstreamMetricDisplay({ name, labels: { quota: 'premium_interactions' } });
    expect(display).toMatchObject({ name: `${quantity}_premium_interactions`, unit: 'count', form, emptyValue: null });
    expect([0, 300, 9_719_759.1, 10_000_000].map(display.toDisplayValue)).toEqual([0, 300, 9_719_759.1, 10_000_000]);
  }
});
