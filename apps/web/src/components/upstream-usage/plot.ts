import type { UpstreamUsageMetadata } from './data';
import type { ResolvedUsageMetricDisplay } from './display-name';
import { hueForSeriesSlot } from '../charts/palette';
import type { SeriesLegendEntry } from '../charts/series-legends';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';
import type { UsageMetricUnit } from '@floway-dev/provider/browser';

export type UpstreamUsageGroupBy = 'upstream' | 'metric';
export interface UpstreamUsageSeries extends SeriesLegendEntry { unit: UsageMetricUnit; form: 'line' | 'area' }
export interface UpstreamUsageChart {
  id: string;
  title: string;
  entries: UpstreamUsageSeries[];
  values: Map<string, Array<{ timestamp: number; value: number }>>;
  hiddenByDefault: Set<string>;
}

export const buildUpstreamUsageCharts = (
  records: readonly UpstreamUsageMetricRecord[],
  groupBy: UpstreamUsageGroupBy,
  upstreams: ReadonlyMap<string, UpstreamUsageMetadata>,
  resolve: (upstreamId: string, key: string) => ResolvedUsageMetricDisplay,
): UpstreamUsageChart[] => {
  const charts = new Map<string, UpstreamUsageChart>();
  const identities = new Map<string, { record: UpstreamUsageMetricRecord; display: ResolvedUsageMetricDisplay }>();
  const available = records.filter(record => upstreams.has(record.upstreamId));
  for (const record of available) {
    identities.set(JSON.stringify([record.upstreamId, record.key]), { record, display: resolve(record.upstreamId, record.key) });
  }
  for (const [id, { record, display }] of identities) {
    const upstream = upstreams.get(record.upstreamId)!;
    const chartId = groupBy === 'upstream' ? record.upstreamId : display.metricId;
    let chart = charts.get(chartId);
    if (chart === undefined) {
      chart = { id: chartId, title: groupBy === 'upstream' ? upstream.name : display.name, entries: [], values: new Map(), hiddenByDefault: new Set() };
      charts.set(chartId, chart);
    }
    const label = groupBy === 'upstream' ? display.name : upstream.name;
    chart.entries.push({ id, label, unit: display.unit, form: display.form, hue: groupBy === 'upstream' ? hueForSeriesSlot(chart.entries.length) : upstream.hue });
    chart.values.set(id, []);
    if (groupBy === 'upstream' && display.emptyValue !== null && record.value === display.emptyValue) chart.hiddenByDefault.add(id);
  }
  for (const record of available) {
    const id = JSON.stringify([record.upstreamId, record.key]);
    const { display } = identities.get(id)!;
    const chartId = groupBy === 'upstream' ? record.upstreamId : display.metricId;
    charts.get(chartId)!.values.get(id)!.push({ timestamp: record.timestamp, value: record.value });
  }
  return [...charts.values()];
};

export const gaugePoints = (observations: readonly { timestamp: number; value: number }[], start: number, end: number) => {
  return observations.filter(point => point.timestamp >= start && point.timestamp <= end);
};

export const upstreamUsagePlotRows = (chart: UpstreamUsageChart, start: number, end: number): Array<{ timestamp: number; values: Record<string, number> }> => {
  const changes = new Map<number, Array<{ id: string; value: number }>>();
  for (const [id, observations] of chart.values) {
    for (const point of gaugePoints(observations, start, end)) {
      const atTime = changes.get(point.timestamp);
      const change = { id, value: point.value };
      if (atTime === undefined) changes.set(point.timestamp, [change]);
      else atTime.push(change);
    }
  }
  return [...changes].sort(([left], [right]) => left - right).map(([timestamp, atTime]) => {
    return { timestamp, values: Object.fromEntries(atTime.map(change => [change.id, change.value])) };
  });
};
