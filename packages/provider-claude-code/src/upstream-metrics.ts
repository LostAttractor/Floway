import type { ClaudeCodeQuotaSnapshot } from './quota.ts';
import { decimalStringToNumber, multiplyDecimalStrings } from '@floway-dev/protocols/common';
import type { UpstreamMetrics } from '@floway-dev/provider';
import { upstreamMetricAxisPriority, type UpstreamMetricDisplay, type UpstreamMetricIdentity } from '@floway-dev/provider/browser';

// Headers report fractions while OAuth usage reports percentages; both are stored as percentages.
// https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.288.tgz
// The fraction is scaled in decimal so a header reading equals the OAuth percentage for the same
// usage; binary multiplication turns 0.07 into 7.000000000000001.
const fractionToPercent = (fraction: number): number => decimalStringToNumber(multiplyDecimalStrings(String(fraction), '100'));

// The `anthropic-ratelimit-unified-overage-utilization` header and the OAuth usage body's
// `extra_usage.utilization` both report the share of the extra usage (usage credits) monthly
// spend limit that is used, so they are recorded as one `extra_usage` series. Claude Code renders
// the body field as used_credits / monthly_limit:
// https://github.com/ghboke/claude-code-reverse/blob/main/src/src/components/Settings/Usage.tsx
// Independent captures describe the header as the extra usage budget consumed, and as reading 0.0
// on an uncapped account that has spent money:
// https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/02_RATELIMIT-HEADERS.md
// https://github.com/weltern/Clawdmeter/blob/main/docs/overage-mechanics.md
export const claudeCodeQuotaMetrics = (snapshot: ClaudeCodeQuotaSnapshot): UpstreamMetrics => {
  const metrics = [];
  for (const [key, window] of [['five_hour', snapshot.fiveHour], ['seven_day', snapshot.sevenDay], ['extra_usage', snapshot.overage]] as const) {
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
  return {
    name: quota, unit: 'percent', axisPriority: quota === 'extra_usage' ? upstreamMetricAxisPriority.extraUsage : upstreamMetricAxisPriority.subscriptionQuota, windowSeconds: null,
    emptyValue: quota === 'extra_usage' ? 0 : null, form: 'area', toDisplayValue: quota === 'extra_usage' ? value => value : value => 100 - value,
  };
};
