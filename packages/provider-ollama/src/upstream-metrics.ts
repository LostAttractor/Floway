import { readOllamaAccountUsage } from './account-usage.ts';
import type { UpstreamMetricDisplay } from '@floway-dev/provider';

export const ollamaMetrics = (body: unknown): Map<string, number> => {
  const { included, purchasedBalanceUsd, activity } = readOllamaAccountUsage(body);
  const metrics = new Map<string, number>();
  if (included.kind === 'credits') {
    metrics.set(JSON.stringify(['balance', 'included']), included.balanceUsd);
    metrics.set(JSON.stringify(['allowance', 'included']), included.allowanceUsd);
  } else {
    for (const name of ['session', 'weekly'] as const) metrics.set(JSON.stringify(['window', name]), included[name].remainingPercent);
  }
  metrics.set(JSON.stringify(['balance', 'purchased']), purchasedBalanceUsd);
  if (activity.usageUsd !== null) metrics.set(JSON.stringify(['activity_cost', activity.range]), activity.usageUsd);
  return metrics;
};

export const resolveUpstreamMetricDisplay = (key: string): UpstreamMetricDisplay => {
  const [kind, name] = JSON.parse(key) as [string, string];
  if ((kind !== 'window' && kind !== 'activity_cost' && kind !== 'balance' && kind !== 'allowance') || typeof name !== 'string') throw new TypeError('Invalid Ollama metric key');
  return { name: kind === 'activity_cost' ? `cost_${name}` : kind === 'allowance' ? 'included_allowance' : name, unit: kind === 'window' ? 'percent' : 'usd', windowMinutes: null, emptyValue: kind === 'balance' && name === 'purchased' ? 0 : null, form: kind === 'balance' || kind === 'allowance' ? 'line' : 'area', toDisplayValue: value => value };
};
