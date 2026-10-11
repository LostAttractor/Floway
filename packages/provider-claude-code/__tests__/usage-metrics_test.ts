import { expect, it } from 'vitest';

import { parseClaudeCodeQuotaHeaders } from '../src/quota.ts';
import { claudeCodeProbeUsageMetrics, claudeCodeQuotaUsageMetrics, resolveUsageMetricDisplayName } from '../src/usage-metrics.ts';

it('normalizes Claude Code header fractions to probe percentages and preserves dynamic windows', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-7d-utilization': '0.5' }));
  expect(claudeCodeQuotaUsageMetrics(snapshot)).toEqual(new Map([['["quota","five_hour"]', 25], ['["quota","seven_day"]', 50]]));
  expect(claudeCodeProbeUsageMetrics({ five_hour: { utilization: 25 }, seven_day_sonnet: { utilization: 40 }, unknown: null })).toEqual(new Map([['["quota","five_hour"]', 25], ['["quota","seven_day_sonnet"]', 40]]));
});

it('keeps header overage separate from the OAuth extra usage budget', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-overage-utilization': '0.2' }));
  expect(claudeCodeQuotaUsageMetrics(snapshot)).toEqual(new Map([['["quota","overage"]', 20]]));
  expect(claudeCodeProbeUsageMetrics({ extra_usage: { utilization: 30 } })).toEqual(new Map([['["quota","extra_usage"]', 30]]));
});

it('delivers nonfinite numeric utilization to the recording boundary', () => {
  const body = JSON.parse('{"five_hour":{"utilization":1e400}}') as Record<string, unknown>;
  expect(claudeCodeProbeUsageMetrics(body).get('["quota","five_hour"]')).toBe(Infinity);
});

it('displays remaining subscription windows and keeps additional usage as consumption', () => {
  for (const key of ['five_hour', 'seven_day', 'seven_day_sonnet', 'future_window']) {
    expect(resolveUsageMetricDisplayName(JSON.stringify(['quota', key])).toDisplayValue(25)).toBe(75);
  }
  for (const key of ['overage', 'extra_usage']) {
    const display = resolveUsageMetricDisplayName(JSON.stringify(['quota', key]));
    expect(display.toDisplayValue(25)).toBe(25);
    expect(display.emptyValue).toBe(0);
  }
});
