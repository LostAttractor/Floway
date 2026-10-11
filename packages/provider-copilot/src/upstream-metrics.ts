import type { CopilotQuotaSnapshot } from './quota.ts';
import type { UpstreamMetricDisplay } from '@floway-dev/provider';

// https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/nodejs/src/generated/rpc.ts#L6572
export const copilotMetrics = (snapshot: CopilotQuotaSnapshot): Map<string, number> => {
  const metrics = new Map<string, number>();
  for (const [key, quota] of Object.entries(snapshot.quotas)) {
    if (quota.unlimited || quota.entitlement <= 0) continue;
    metrics.set(JSON.stringify(['remaining', key]), quota.quota_remaining);
    metrics.set(JSON.stringify(['entitlement', key]), quota.entitlement);
  }
  return metrics;
};

export const resolveUpstreamMetricDisplay = (key: string): UpstreamMetricDisplay => {
  const [kind, name] = JSON.parse(key) as [string, string];
  if ((kind !== 'remaining' && kind !== 'entitlement') || typeof name !== 'string') throw new TypeError('Invalid Copilot metric key');
  return { name: `${kind}_${name}`, unit: 'count', windowMinutes: null, emptyValue: null, form: kind === 'entitlement' ? 'line' : 'area', toDisplayValue: value => value };
};
