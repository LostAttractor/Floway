import type { CopilotQuotaSnapshot } from './quota.ts';
import type { UpstreamMetricDisplay } from '@floway-dev/provider';

// https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/nodejs/src/generated/rpc.ts#L6572
export const copilotMetrics = (snapshot: CopilotQuotaSnapshot): Map<string, number> => new Map(
  Object.entries(snapshot.quotas)
    .filter(([, quota]) => !quota.unlimited && quota.entitlement > 0)
    .map(([key, quota]) => [JSON.stringify(['quota', key]), 100 - quota.percent_remaining]),
);

export const resolveUpstreamMetricDisplay = (key: string): UpstreamMetricDisplay => {
  const [kind, name] = JSON.parse(key) as [string, string];
  if (kind !== 'quota' || typeof name !== 'string') throw new TypeError('Invalid Copilot metric key');
  return { name, unit: 'percent', windowMinutes: null, emptyValue: null, form: 'area', toDisplayValue: value => 100 - value };
};
