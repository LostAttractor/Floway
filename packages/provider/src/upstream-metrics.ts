import { getProviderRepo } from './repo.ts';

export type UpstreamMetrics = ReadonlyMap<string, number>;
export type UpstreamMetricUnit = 'percent' | 'usd' | 'credits' | 'count';
export interface UpstreamMetricDisplay {
  name: string;
  unit: UpstreamMetricUnit;
  windowMinutes: number | null;
  emptyValue: number | null;
  form: 'line' | 'area';
  toDisplayValue: (storedValue: number) => number;
}

export const normalizeUpstreamMetricKey = (key: string): string => {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed)) throw new TypeError('Upstream metric key must be a JSON array');
  return JSON.stringify(parsed);
};

export const recordUpstreamMetric = (upstreamId: string, key: string, value: number, timestamp: number): Promise<void> =>
  getProviderRepo().recordUpstreamMetric(upstreamId, key, value, timestamp);

export const recordUpstreamMetrics = async (
  upstreamId: string,
  metrics: UpstreamMetrics,
  timestamp: number,
): Promise<void> => {
  await Promise.all([...metrics].map(([key, value]) => recordUpstreamMetric(upstreamId, key, value, timestamp)));
};
