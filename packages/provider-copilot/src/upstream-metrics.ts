import type { CopilotQuotaSnapshot } from './quota.ts';
import type { UpstreamMetricDisplay, UpstreamMetricIdentity, UpstreamMetrics } from '@floway-dev/provider';

// https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/nodejs/src/generated/rpc.ts#L6572
export const copilotMetrics = (snapshot: CopilotQuotaSnapshot): UpstreamMetrics => {
  const metrics = [];
  for (const [key, quota] of Object.entries(snapshot.quotas)) {
    if (quota.unlimited || quota.entitlement <= 0) continue;
    metrics.push({ name: 'quota.remaining', labels: { quota: key }, value: quota.quota_remaining });
    metrics.push({ name: 'quota.entitlement', labels: { quota: key }, value: quota.entitlement });
  }
  return metrics;
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity): UpstreamMetricDisplay => {
  const quota = labels.quota;
  if ((name !== 'quota.remaining' && name !== 'quota.entitlement') || typeof quota !== 'string') throw new TypeError('Invalid Copilot metric identity');
  const quantity = name === 'quota.entitlement' ? 'entitlement' : 'remaining';
  return { series: { name, labels }, name: `${quantity}_${quota}`, unit: 'count', windowSeconds: null, emptyValue: null, form: quantity === 'entitlement' ? 'line' : 'area', toDisplayValue: value => value };
};
