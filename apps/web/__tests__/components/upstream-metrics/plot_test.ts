import { expect, it } from 'vitest';

import { buildUpstreamMetricsChart, gaugePoints, upstreamMetricsPlotRows } from '../../../src/components/upstream-metrics/plot';
import type { UpstreamMetricRecord } from '@floway-dev/gateway/browser';

const upstream = { id: 'seat', kind: 'ollama' as const, name: 'Seat', hue: 210 };
const records: UpstreamMetricRecord[] = [
  { upstreamId: 'seat', key: 'usage', timestamp: 1_000, value: 20 },
  { upstreamId: 'seat', key: 'cost', timestamp: 1_000, value: 3 },
  { upstreamId: 'seat', key: 'credits', timestamp: 10_000, value: 200 },
  { upstreamId: 'seat', key: 'usage', timestamp: 61_000, value: 0 },
];
const resolve = (key: string) => ({ name: key, unit: key === 'cost' ? 'usd' as const : key === 'credits' ? 'credits' as const : 'percent' as const, windowMinutes: null, emptyValue: key === 'usage' ? 0 : null, form: 'line' as const, toDisplayValue: key === 'usage' ? (value: number) => 100 - value : (value: number) => value });

it('builds the upstream metrics once with transformed values and raw latest empty semantics', () => {
  const chart = buildUpstreamMetricsChart(records, upstream, resolve);
  expect(chart.entries.map(entry => entry.unit)).toEqual(['percent', 'usd', 'credits']);
  expect(chart.values.get('usage')).toEqual([{ timestamp: 1_000, value: 80 }, { timestamp: 61_000, value: 100 }]);
  expect(chart.values.get('credits')).toEqual([{ timestamp: 10_000, value: 200 }]);
  expect([...chart.hiddenByDefault]).toEqual(['usage']);
  expect(records.map(record => record.value)).toEqual([20, 3, 200, 0]);
});

it('uses current upstream identity and keeps sparse observation times', () => {
  const chart = buildUpstreamMetricsChart(records, { ...upstream, name: 'Renamed' }, resolve);
  expect(chart.title).toBe('Renamed');
  expect(upstreamMetricsPlotRows(chart, 5_000, 120_000)).toEqual([
    { timestamp: 10_000, values: { credits: 200 } },
    { timestamp: 61_000, values: { usage: 100 } },
  ]);
});

it('retains only real observations within the requested range', () => {
  expect(gaugePoints([{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }], 30_000, 120_000)).toEqual([{ timestamp: 61_000, value: 0 }]);
});
