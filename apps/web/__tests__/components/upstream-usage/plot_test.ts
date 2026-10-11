import { expect, it } from 'vitest';

import { buildUpstreamUsageCharts, gaugePoints, upstreamUsagePlotRows } from '../../../src/components/upstream-usage/plot';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';

const records: UpstreamUsageMetricRecord[] = [
  { upstreamId: 'up-1', key: 'usage', timestamp: 1_000, value: 20 },
  { upstreamId: 'up-1', key: 'cost', timestamp: 1_000, value: 3 },
  { upstreamId: 'up-1', key: 'credits', timestamp: 10_000, value: 200 },
  { upstreamId: 'up-2', key: 'usage', timestamp: 20_000, value: 40 },
  { upstreamId: 'up-1', key: 'usage', timestamp: 61_000, value: 0 },
];
const upstreams = new Map([['up-1', { id: 'up-1', kind: 'ollama' as const, name: 'First', hue: 210 }], ['up-2', { id: 'up-2', kind: 'ollama' as const, name: 'Second', hue: 20 }]]);
const resolve = (_upstreamId: string, key: string) => ({ name: key, metricId: key, unit: key === 'cost' ? 'usd' as const : key === 'credits' ? 'credits' as const : 'percent' as const, windowMinutes: null, emptyValue: null, form: 'line' as const, toDisplayValue: (value: number) => value });

it('builds one comparison choice per upstream with all independently measured units', () => {
  const charts = buildUpstreamUsageCharts(records, 'upstream', upstreams, resolve);
  expect(charts.map(chart => [chart.id, chart.title, chart.entries.map(entry => entry.unit)])).toEqual([['up-1', 'First', ['percent', 'usd', 'credits']], ['up-2', 'Second', ['percent']]]);
  expect(charts[0]!.values.get(JSON.stringify(['up-1', 'usage']))).toEqual([{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }]);
});

it('compares one metric across all upstreams on a single unit axis', () => {
  const charts = buildUpstreamUsageCharts(records, 'metric', upstreams, resolve);
  expect(charts.find(chart => chart.id === 'usage')!.entries.map(entry => [entry.label, entry.unit])).toEqual([['First', 'percent'], ['Second', 'percent']]);
  expect(charts.every(chart => new Set(chart.entries.map(entry => entry.unit)).size === 1)).toBe(true);
});

it('uses current upstream names and hues and omits deleted identities from display', () => {
  const current = new Map([['up-1', { ...upstreams.get('up-1')!, name: 'Renamed', hue: 300 }]]);
  const charts = buildUpstreamUsageCharts(records, 'metric', current, resolve);
  expect(charts.find(chart => chart.id === 'usage')!.entries).toMatchObject([{ label: 'Renamed', hue: 300 }]);
  expect(charts.every(chart => chart.entries.every(entry => entry.id.startsWith('["up-1"')))).toBe(true);
});

it('defaults optional empty metrics to hidden only for upstream comparisons', () => {
  const samples = [
    { upstreamId: 'up-1', key: 'extra', timestamp: 1_000, value: 10 },
    { upstreamId: 'up-1', key: 'extra', timestamp: 2_000, value: 0 },
    { upstreamId: 'up-1', key: 'usage', timestamp: 2_000, value: 0 },
  ];
  const display = (_id: string, key: string) => ({ ...resolve(_id, key), emptyValue: key === 'extra' ? 0 : null });
  const byUpstream = buildUpstreamUsageCharts(samples, 'upstream', upstreams, display);
  expect([...byUpstream[0]!.hiddenByDefault]).toEqual([JSON.stringify(['up-1', 'extra'])]);
  expect(byUpstream[0]!.values.get(JSON.stringify(['up-1', 'extra']))).toHaveLength(2);
  expect(buildUpstreamUsageCharts(samples, 'metric', upstreams, display).every(chart => chart.hiddenByDefault.size === 0)).toBe(true);
});

it('retains only real observation points within the requested range', () => {
  expect(gaugePoints([{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }], 30_000, 120_000)).toEqual([{ timestamp: 61_000, value: 0 }]);
  expect(gaugePoints([{ timestamp: 61_000, value: 20 }], 30_000, 120_000)[0]!.timestamp).toBe(61_000);
});

it('aligns independent observation times without inventing readings before the first observation', () => {
  const chart = buildUpstreamUsageCharts(records, 'metric', upstreams, resolve).find(chart => chart.id === 'usage')!;
  const first = JSON.stringify(['up-1', 'usage']);
  const second = JSON.stringify(['up-2', 'usage']);
  expect(upstreamUsagePlotRows(chart, 5_000, 120_000)).toEqual([
    { timestamp: 20_000, values: { [second]: 40 } },
    { timestamp: 61_000, values: { [first]: 0 } },
  ]);
});

it.each(['upstream', 'metric'] as const)('converts stored values once for %s charts and preserves raw empty semantics', groupBy => {
  const samples = [
    { upstreamId: 'up-1', key: 'extra', timestamp: 1_000, value: 20 },
    { upstreamId: 'up-1', key: 'extra', timestamp: 2_000, value: 0 },
    { upstreamId: 'up-2', key: 'extra', timestamp: 1_000, value: 60 },
    { upstreamId: 'up-1', key: 'cost', timestamp: 1_000, value: 3 },
  ];
  const display = (_id: string, key: string) => ({
    ...resolve(_id, key),
    emptyValue: key === 'extra' ? 0 : null,
    toDisplayValue: key === 'extra' ? (value: number) => 100 - value : (value: number) => value,
  });
  const charts = buildUpstreamUsageCharts(samples, groupBy, upstreams, display);
  const firstId = JSON.stringify(['up-1', 'extra']);
  const first = charts.find(chart => chart.values.has(firstId))!;
  expect(first.values.get(firstId)).toEqual([{ timestamp: 1_000, value: 80 }, { timestamp: 2_000, value: 100 }]);
  expect(first.hiddenByDefault.has(firstId)).toBe(groupBy === 'upstream');
  const secondId = JSON.stringify(['up-2', 'extra']);
  expect(charts.find(chart => chart.values.has(secondId))!.values.get(secondId)).toEqual([{ timestamp: 1_000, value: 40 }]);
  expect(upstreamUsagePlotRows(first, 0, 3_000)[0]!.values[firstId]).toBe(80);
  const costId = JSON.stringify(['up-1', 'cost']);
  expect(charts.find(chart => chart.values.has(costId))!.values.get(costId)).toEqual([{ timestamp: 1_000, value: 3 }]);
  expect(samples.map(sample => sample.value)).toEqual([20, 0, 60, 3]);
});
