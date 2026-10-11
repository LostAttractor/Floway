import type { ClaudeCodeQuotaSnapshot } from './quota.ts';
import type { UpstreamMetricDisplay } from '@floway-dev/provider';

// Header utilization is fractional; the OAuth usage body reports percentages.
// https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.288.tgz
export const claudeCodeQuotaMetrics = (snapshot: ClaudeCodeQuotaSnapshot): Map<string, number> => {
  const metrics = new Map<string, number>();
  for (const [key, window] of [['five_hour', snapshot.fiveHour], ['seven_day', snapshot.sevenDay], ['overage', snapshot.overage]] as const) {
    if (window !== null && window.utilization !== null) metrics.set(JSON.stringify(['quota', key]), window.utilization * 100);
  }
  return metrics;
};

export const claudeCodeProbeMetrics = (body: Record<string, unknown>): Map<string, number> => {
  const metrics = new Map<string, number>();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'object' && value !== null && 'utilization' in value && typeof value.utilization === 'number') metrics.set(JSON.stringify(['quota', key]), value.utilization);
  }
  return metrics;
};

export const resolveUpstreamMetricDisplay = (key: string): UpstreamMetricDisplay => {
  const [kind, name] = JSON.parse(key) as [string, string];
  if (kind !== 'quota' || typeof name !== 'string') throw new TypeError('Invalid Claude Code metric key');
  const isExtraUsage = name === 'overage' || name === 'extra_usage';
  return { name, unit: 'percent', windowMinutes: null, emptyValue: isExtraUsage ? 0 : null, form: 'area', toDisplayValue: isExtraUsage ? value => value : value => 100 - value };
};
