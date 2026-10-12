import { getProviderRepo } from './repo.ts';
import { normalizeUpstreamMetricIdentity, type UpstreamMetricIdentity, type UpstreamMetricLabels } from './upstream-metric-identity.ts';

export interface UpstreamMetricObservation extends UpstreamMetricIdentity { value: number }
export type UpstreamMetrics = readonly UpstreamMetricObservation[];
export type UpstreamMetricUnit = 'percent' | 'usd' | 'credits' | 'count';
export interface UpstreamMetricDisplay {
  name: string;
  unit: UpstreamMetricUnit;
  windowSeconds: number | null;
  emptyValue: number | null;
  form: 'line' | 'area';
  toDisplayValue: (storedValue: number) => number;
}

export const recordUpstreamMetric = (upstreamId: string, name: string, labels: UpstreamMetricLabels, value: number, timestamp: number): Promise<void> => {
  const identity = normalizeUpstreamMetricIdentity(name, labels);
  return getProviderRepo().recordUpstreamMetric(upstreamId, identity.name, identity.labels, value, timestamp);
};

export const recordUpstreamMetrics = async (
  upstreamId: string,
  metrics: UpstreamMetrics,
  timestamp: number,
): Promise<void> => {
  await Promise.all(metrics.map(metric => recordUpstreamMetric(upstreamId, metric.name, metric.labels, metric.value, timestamp)));
};
