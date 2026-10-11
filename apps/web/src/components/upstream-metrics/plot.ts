import type { UpstreamUsageMetadata } from './data';
import { hueForSeriesSlot } from '../charts/palette';
import type { SeriesLegendEntry } from '../charts/series-legends';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';
import type { UsageMetricDisplay, UsageMetricUnit } from '@floway-dev/provider/browser';

export interface UpstreamMetricsSeries extends SeriesLegendEntry { unit: UsageMetricUnit; form: 'line' | 'area' }
export interface UpstreamMetricsChart {
  id: string;
  title: string;
  entries: UpstreamMetricsSeries[];
  values: Map<string, Array<{ timestamp: number; value: number }>>;
  hiddenByDefault: Set<string>;
}

export const buildUpstreamMetricsChart = (
  records: readonly UpstreamUsageMetricRecord[],
  upstream: UpstreamUsageMetadata,
  resolve: (key: string) => UsageMetricDisplay,
): UpstreamMetricsChart => {
  const chart: UpstreamMetricsChart = { id: upstream.id, title: upstream.name, entries: [], values: new Map(), hiddenByDefault: new Set() };
  const metrics = new Map<string, { display: UsageMetricDisplay; latest: number }>();
  for (const record of records) {
    let metric = metrics.get(record.key);
    if (metric === undefined) {
      metric = { display: resolve(record.key), latest: record.value };
      metrics.set(record.key, metric);
      chart.entries.push({ id: record.key, label: metric.display.name, unit: metric.display.unit, form: metric.display.form, hue: hueForSeriesSlot(chart.entries.length) });
      chart.values.set(record.key, []);
    }
    metric.latest = record.value;
    chart.values.get(record.key)!.push({ timestamp: record.timestamp, value: metric.display.toDisplayValue(record.value) });
  }
  for (const [id, { display, latest }] of metrics) {
    if (display.emptyValue !== null && latest === display.emptyValue) chart.hiddenByDefault.add(id);
  }
  return chart;
};

export const gaugePoints = (observations: readonly { timestamp: number; value: number }[], start: number, end: number) =>
  observations.filter(point => point.timestamp >= start && point.timestamp <= end);

export const upstreamUsagePlotRows = (chart: UpstreamMetricsChart, start: number, end: number): Array<{ timestamp: number; values: Record<string, number> }> => {
  const changes = new Map<number, Array<{ id: string; value: number }>>();
  for (const [id, observations] of chart.values) {
    for (const point of gaugePoints(observations, start, end)) {
      const atTime = changes.get(point.timestamp);
      const change = { id, value: point.value };
      if (atTime === undefined) changes.set(point.timestamp, [change]);
      else atTime.push(change);
    }
  }
  return [...changes].sort(([left], [right]) => left - right).map(([timestamp, atTime]) => ({ timestamp, values: Object.fromEntries(atTime.map(change => [change.id, change.value])) }));
};
