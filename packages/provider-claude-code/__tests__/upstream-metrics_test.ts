import { expect, it } from 'vitest';

import { parseClaudeCodeQuotaHeaders } from '../src/quota.ts';
import { claudeCodeProbeMetrics, claudeCodeQuotaMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';

it('records header fractions and probe percentages as one canonical percent metric', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-7d-utilization': '0.5' }));
  expect(claudeCodeQuotaMetrics(snapshot)).toEqual([
    { name: 'quota.utilization', labels: { quota: 'five_hour' }, value: 25 },
    { name: 'quota.utilization', labels: { quota: 'seven_day' }, value: 50 },
  ]);
  expect(claudeCodeProbeMetrics({ five_hour: { utilization: 25 }, seven_day_sonnet: { utilization: 40 }, unknown: null })).toEqual([
    { name: 'quota.utilization', labels: { quota: 'five_hour' }, value: 25 },
    { name: 'quota.utilization', labels: { quota: 'seven_day_sonnet' }, value: 40 },
  ]);
});

it('keeps header overage separate from the OAuth extra usage budget', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-overage-utilization': '0.2' }));
  expect(claudeCodeQuotaMetrics(snapshot)).toEqual([{ name: 'quota.utilization', labels: { quota: 'overage' }, value: 20 }]);
  expect(claudeCodeProbeMetrics({ extra_usage: { utilization: 30 } })).toEqual([{ name: 'quota.utilization', labels: { quota: 'extra_usage' }, value: 30 }]);
});

it('delivers nonfinite numeric utilization to the recording boundary', () => {
  const body = JSON.parse('{"five_hour":{"utilization":1e400}}') as Record<string, unknown>;
  expect(claudeCodeProbeMetrics(body)[0]?.value).toBe(Infinity);
});

it('converts canonical utilization percent into remaining percent for display', () => {
  const display = resolveUpstreamMetricDisplay({ name: 'quota.utilization', labels: { quota: 'five_hour' } });
  expect(display.toDisplayValue(25)).toBe(75);
  for (const quota of ['overage', 'extra_usage']) {
    const extra = resolveUpstreamMetricDisplay({ name: 'quota.utilization', labels: { quota } });
    expect(extra.toDisplayValue(25)).toBe(25);
    expect(extra.emptyValue).toBe(0);
  }
});

it('rejects labels outside the Claude utilization metric schema', () => {
  expect(() => resolveUpstreamMetricDisplay({ name: 'quota.utilization', labels: { quota: 'five_hour', region: 'us' } })).toThrow(TypeError);
});
