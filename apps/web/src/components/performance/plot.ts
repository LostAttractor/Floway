import type { ChartProps } from '@fluentui/react-charts';

import {
  performanceValue,
  resolvePerformanceGroup,
  type PerformanceDisplayRecord,
  type PerformanceBreakdown,
  type PerformanceMetric,
  type PerformanceLabels,
  type PerformancePercentile,
  type PerformanceRange,
} from './overview';
import { DataVizPalette, getColorFromToken } from '../../fluent';
import { dashboardBucketFrames, formatBucketInterval, type ChartBucket } from '../charts/dashboard-time';
import { hueForSeriesSlot } from '../charts/palette';
import { withUniqueSeriesLegends, type ChartSeries } from '../charts/series-legends';
import { lineSeries } from '../charts/series-plot';

export interface PerformanceChartPointDetails { outputSpeed: number | null; ttft: number | null }
// 沿用 Fluent Charts 9.3.22 定性色板的家族顺序，选择通过明暗校验的六组原生色阶，不使用语义状态色。
// 色值与明暗索引：https://github.com/microsoft/fluentui/blob/cbee28ba42d268404e9b9663a6a3a33e205c66d1/packages/charts/react-charts/library/src/utilities/colors.ts#L4-L103
// 主题解析：https://github.com/microsoft/fluentui/blob/cbee28ba42d268404e9b9663a6a3a33e205c66d1/packages/charts/react-charts/library/src/utilities/colors.ts#L123-L145
export const comparisonPalette = {
  light: [DataVizPalette.color1, DataVizPalette.color2, DataVizPalette.color5, DataVizPalette.color6, DataVizPalette.color7, DataVizPalette.color9].map(token => getColorFromToken(token, false)),
  dark: [DataVizPalette.color1, DataVizPalette.color22, DataVizPalette.color5, DataVizPalette.color6, DataVizPalette.color17, DataVizPalette.color19].map(token => getColorFromToken(token, true)),
} as const;
export const comparisonSeriesLimit = comparisonPalette.light.length;

export const assignComparisonSlots = (ids: readonly string[], previous: ReadonlyMap<string, number>): Map<string, number> => {
  if (ids.length > comparisonSeriesLimit) return new Map(previous);
  const next = new Map([...previous].filter(([id]) => ids.includes(id)));
  for (const id of [...ids].sort()) {
    if (next.has(id)) continue;
    const slot = comparisonPalette.light.findIndex((_, index) => ![...next.values()].includes(index));
    if (slot < 0) throw new RangeError('Performance comparison palette exhausted');
    next.set(id, slot);
  }
  return next;
};

export interface PerformancePlot {
  comparisonLimitExceeded?: boolean;
  data: ChartProps;
  details: Map<number, Map<string, PerformanceChartPointDetails>>;
  entries: ChartSeries[];
  buckets: ChartBucket[];
  range: PerformanceRange;
  metric: PerformanceMetric;
}

export const buildPerformanceChart = (
  records: PerformanceDisplayRecord[],
  metric: PerformanceMetric,
  percentile: PerformancePercentile,
  groupBy: PerformanceBreakdown,
  labels: PerformanceLabels,
  buckets: ChartBucket[],
  range: PerformanceRange,
  comparison?: { slots: ReadonlyMap<string, number>; dark: boolean },
): PerformancePlot => {
  const groups = [...new Set(records.map(record => record.group))].sort();
  const comparisonLimitExceeded = groupBy === 'comparison' && groups.length > comparisonSeriesLimit;
  const entries = withUniqueSeriesLegends((comparisonLimitExceeded ? [] : groups).map((group, slot) => {
    const color = comparison && comparisonPalette[comparison.dark ? 'dark' : 'light'][comparison.slots.get(group) ?? -1];
    if (comparison && !color) throw new RangeError('Performance comparison has no assigned color');
    return {
      id: group,
      color,
      label: resolvePerformanceGroup(group, groupBy, labels),
      hue: groupBy === 'upstream'
        ? labels.upstreamHues.get(group) ?? hueForSeriesSlot(slot)
        : hueForSeriesSlot(slot),
    };
  }));
  const values = new Map(records.map(record => [
    `${record.bucket}\0${record.group}`,
    record,
  ]));
  return {
    comparisonLimitExceeded,
    entries,
    buckets,
    details: new Map(buckets.map(bucket => [
      bucket.date.getTime(),
      new Map(entries.flatMap(entry => {
        const record = values.get(`${bucket.key}\0${entry.id}`);
        return record ? [[entry.id, {
          outputSpeed: performanceValue(record, 'tokPerSec', percentile),
          ttft: performanceValue(record, 'ttft', percentile),
        }] as const] : [];
      })),
    ])),
    range,
    metric,
    data: {
      chartTitle: '',
      lineChartData: entries.flatMap(entry => {
        const data = buckets.flatMap(bucket => {
          const value = values.get(`${bucket.key}\0${entry.id}`);
          const y = value ? performanceValue(value, metric, percentile) : null;
          return y === null || y <= 0 ? [] : [{ x: bucket.date, y }];
        });
        return data.length ? [lineSeries(entry, data.map(point => ({ ...point, markerSize: 3 })))] : [];
      }),
    },
  };
};

export const performanceBuckets = (range: PerformanceRange, now: number): ChartBucket[] =>
  dashboardBucketFrames(range, now).map(frame => ({ ...frame, label: formatBucketInterval(frame) }));
