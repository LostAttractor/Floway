import { expect, it } from 'vitest';

import { parseClaudeCodeQuotaHeaders } from '../src/quota.ts';
import { claudeCodeProbeMetrics, claudeCodeQuotaMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';

it('preserves header fractions and probe percentages as separate raw series', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-7d-utilization': '0.5' }));
  expect(claudeCodeQuotaMetrics(snapshot)).toEqual([
    { name: 'quota.utilization_fraction', labels: { quota: 'five_hour' }, value: 0.25 },
    { name: 'quota.utilization_fraction', labels: { quota: 'seven_day' }, value: 0.5 },
  ]);
  expect(claudeCodeProbeMetrics({ five_hour: { utilization: 25 }, seven_day_sonnet: { utilization: 40 }, unknown: null })).toEqual([
    { name: 'quota.utilization_percent', labels: { quota: 'five_hour' }, value: 25 },
    { name: 'quota.utilization_percent', labels: { quota: 'seven_day_sonnet' }, value: 40 },
  ]);
});

it('keeps header overage separate from the OAuth extra usage budget', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-overage-utilization': '0.2' }));
  expect(claudeCodeQuotaMetrics(snapshot)).toEqual([{ name: 'quota.utilization_fraction', labels: { quota: 'overage' }, value: 0.2 }]);
  expect(claudeCodeProbeMetrics({ extra_usage: { utilization: 30 } })).toEqual([{ name: 'quota.utilization_percent', labels: { quota: 'extra_usage' }, value: 30 }]);
});

it('delivers nonfinite numeric utilization to the recording boundary', () => {
  const body = JSON.parse('{"five_hour":{"utilization":1e400}}') as Record<string, unknown>;
  expect(claudeCodeProbeMetrics(body)[0]?.value).toBe(Infinity);
});

it('merges raw scales into one display series and applies presentation conversion', () => {
  const fraction = resolveUpstreamMetricDisplay({ name: 'quota.utilization_fraction', labels: { quota: 'five_hour' } });
  const percent = resolveUpstreamMetricDisplay({ name: 'quota.utilization_percent', labels: { quota: 'five_hour' } });
  expect(fraction.series).toEqual(percent.series);
  expect(fraction.toDisplayValue(0.25)).toBe(75);
  expect(percent.toDisplayValue(25)).toBe(75);
  for (const quota of ['overage', 'extra_usage']) {
    const display = resolveUpstreamMetricDisplay({ name: 'quota.utilization_percent', labels: { quota } });
    expect(display.toDisplayValue(25)).toBe(25);
    expect(display.emptyValue).toBe(0);
  }
});
