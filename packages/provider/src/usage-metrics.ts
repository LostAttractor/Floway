import { getProviderRepo } from './repo.ts';

export type UpstreamUsageMetrics = ReadonlyMap<string, number>;
export type UsageMetricUnit = 'percent' | 'usd' | 'credits';
export interface UsageMetricDisplay {
  name: string;
  unit: UsageMetricUnit;
  windowMinutes: number | null;
  emptyValue: number | null;
  form: 'line' | 'area';
  toDisplayValue: (storedValue: number) => number;
}

export const normalizeUsageMetricKey = (key: string): string => {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed)) throw new TypeError('Upstream usage metric key must be a JSON array');
  return JSON.stringify(parsed);
};

export const recordUpstreamUsageMetric = (upstreamId: string, key: string, value: number, timestamp: number): Promise<void> =>
  getProviderRepo().recordUpstreamUsageMetric(upstreamId, key, value, timestamp);

export const recordUpstreamUsageMetrics = async (
  upstreamId: string,
  metrics: UpstreamUsageMetrics,
  timestamp: number,
): Promise<void> => {
  await Promise.all([...metrics].map(([key, value]) => recordUpstreamUsageMetric(upstreamId, key, value, timestamp)));
};
