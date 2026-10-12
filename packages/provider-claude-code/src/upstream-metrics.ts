import type { ClaudeCodeQuotaSnapshot } from './quota.ts';
import { decimalStringToNumber, multiplyDecimalStrings } from '@floway-dev/protocols/common';
import type { UpstreamMetricDisplay, UpstreamMetricIdentity, UpstreamMetrics } from '@floway-dev/provider';

// Headers report fractions while OAuth usage reports percentages; both are stored as percentages.
// https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.288.tgz
// The fraction is scaled in decimal so a header reading equals the OAuth percentage for the same
// usage; binary multiplication turns 0.07 into 7.000000000000001.
const fractionToPercent = (fraction: number): number => decimalStringToNumber(multiplyDecimalStrings(String(fraction), '100'));

export const claudeCodeQuotaMetrics = (snapshot: ClaudeCodeQuotaSnapshot): UpstreamMetrics => {
  const metrics = [];
  for (const [key, window] of [['five_hour', snapshot.fiveHour], ['seven_day', snapshot.sevenDay], ['overage', snapshot.overage]] as const) {
    if (window !== null && window.utilization !== null) metrics.push({ name: 'quota.utilization', labels: { quota: key }, value: fractionToPercent(window.utilization) });
  }
  return metrics;
};

export const claudeCodeProbeMetrics = (body: Record<string, unknown>): UpstreamMetrics => {
  const metrics = [];
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'object' && value !== null && 'utilization' in value && typeof value.utilization === 'number') metrics.push({ name: 'quota.utilization', labels: { quota: key }, value: value.utilization });
  }
  return metrics;
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity): UpstreamMetricDisplay | null => {
  const quota = labels.quota;
  if (name !== 'quota.utilization' || typeof quota !== 'string' || Object.keys(labels).length !== 1) return null;
  const isExtraUsage = quota === 'overage' || quota === 'extra_usage';
  return {
    name: quota, unit: 'percent', windowSeconds: null,
    emptyValue: isExtraUsage ? 0 : null, form: 'area', toDisplayValue: isExtraUsage ? value => value : value => 100 - value,
  };
};
