import type { ClaudeCodeQuotaSnapshot } from './quota.ts';
import type { UpstreamMetricDisplay, UpstreamMetricIdentity, UpstreamMetrics } from '@floway-dev/provider';

// Header utilization is fractional; the OAuth usage body reports percentages.
// https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.288.tgz
export const claudeCodeQuotaMetrics = (snapshot: ClaudeCodeQuotaSnapshot): UpstreamMetrics => {
  const metrics = [];
  for (const [key, window] of [['five_hour', snapshot.fiveHour], ['seven_day', snapshot.sevenDay], ['overage', snapshot.overage]] as const) {
    if (window !== null && window.utilization !== null) metrics.push({ name: 'quota.utilization_fraction', labels: { quota: key }, value: window.utilization });
  }
  return metrics;
};

export const claudeCodeProbeMetrics = (body: Record<string, unknown>): UpstreamMetrics => {
  const metrics = [];
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'object' && value !== null && 'utilization' in value && typeof value.utilization === 'number') metrics.push({ name: 'quota.utilization_percent', labels: { quota: key }, value: value.utilization });
  }
  return metrics;
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity): UpstreamMetricDisplay => {
  const quota = labels.quota;
  if ((name !== 'quota.utilization_fraction' && name !== 'quota.utilization_percent') || typeof quota !== 'string' || Object.keys(labels).length !== 1) throw new TypeError('Invalid Claude Code metric identity');
  const isExtraUsage = quota === 'overage' || quota === 'extra_usage';
  const toPercent = name === 'quota.utilization_fraction' ? (value: number) => value * 100 : (value: number) => value;
  return {
    series: { name: 'quota.utilization', labels: { quota } }, name: quota, unit: 'percent', windowSeconds: null,
    emptyValue: isExtraUsage ? 0 : null, form: 'area', toDisplayValue: isExtraUsage ? toPercent : value => 100 - toPercent(value),
  };
};
