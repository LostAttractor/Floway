import { readOllamaAccountUsage } from './account-usage.ts';
import type { UpstreamMetricDisplay, UpstreamMetricIdentity, UpstreamMetrics } from '@floway-dev/provider';

export const ollamaMetrics = (body: unknown): UpstreamMetrics => {
  const { included, purchasedBalanceUsd, activity } = readOllamaAccountUsage(body);
  const metrics = [];
  if (included.kind === 'credits') {
    metrics.push({ name: 'balance.usd', labels: { source: 'included' }, value: included.balanceUsd });
    metrics.push({ name: 'allowance.usd', labels: { source: 'included' }, value: included.allowanceUsd });
  } else {
    for (const window of ['session', 'weekly'] as const) metrics.push({ name: 'quota.remaining_percent', labels: { window }, value: included[window].remainingPercent });
  }
  metrics.push({ name: 'balance.usd', labels: { source: 'purchased' }, value: purchasedBalanceUsd });
  if (activity.usageUsd !== null) metrics.push({ name: 'activity.cost_usd', labels: { range: activity.range }, value: activity.usageUsd });
  return metrics;
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity): UpstreamMetricDisplay => {
  let metricName: string;
  if (name === 'quota.remaining_percent' && typeof labels.window === 'string') metricName = labels.window;
  else if (name === 'activity.cost_usd' && typeof labels.range === 'string') metricName = `cost_${labels.range}`;
  else if (name === 'balance.usd' && (labels.source === 'included' || labels.source === 'purchased')) metricName = labels.source;
  else if (name === 'allowance.usd' && labels.source === 'included') metricName = 'included_allowance';
  else throw new TypeError('Invalid Ollama metric identity');
  const balance = name === 'balance.usd';
  const allowance = name === 'allowance.usd';
  return { series: { name, labels }, name: metricName, unit: name === 'quota.remaining_percent' ? 'percent' : 'usd', windowSeconds: null, emptyValue: balance && labels.source === 'purchased' ? 0 : null, form: balance || allowance ? 'line' : 'area', toDisplayValue: value => value };
};
