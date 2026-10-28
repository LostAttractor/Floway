import { describe, expect, it } from 'vitest';

import { buildPerformanceQuery, normalizePerformanceBreakdownForRuntime, normalizePerformanceDimensionsForRuntime, parsePerformanceUrlState, performanceLabels, performancePercentileTailOf, performanceValue, resolvePerformanceGroup, serializePerformanceUrlState, type PerformanceDisplayRecord, type PerformanceOverviewResponse } from '../../../src/components/performance/overview';
import { assignComparisonSlots, buildPerformanceChart, comparisonPalette } from '../../../src/components/performance/plot';
import en from '../../../src/i18n/locales/en';
import zhHans from '../../../src/i18n/locales/zh-Hans';

const emptyOverview = (): PerformanceOverviewResponse => ({
  series: [],
  axes: { none: [], keyId: [], userId: [], model: [], upstream: [], operation: [], requestedServiceTier: [], serviceTier: [], runtimeLocation: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], requestedServiceTiers: [], serviceTiers: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  upstreams: [],
  keys: [],
});

describe('performance overview query', () => {
  it('sends group-by and all active filters using the new API shape', () => {
    const query = buildPerformanceQuery('7d', 'operation', {
      model: ['gpt-5', 'claude-opus-4-7'], upstream: ['up_1'], operation: [], requestedServiceTier: ['priority'], serviceTier: [''], runtimeLocation: ['SJC'], userId: ['2'], keyId: ['key_1'],
    }, Date.UTC(2026, 6, 12, 4));
    expect(query).toMatchObject({
      bucket: '4h',
      group_by: 'operation',
      filter_model: ['gpt-5', 'claude-opus-4-7'],
      filter_upstream: ['up_1'],
      filter_requested_service_tier: ['priority'],
      filter_service_tier: [''],
      filter_runtime_location: ['SJC'],
      filter_user_id: ['2'],
      filter_key_id: ['key_1'],
    });
    expect(query).not.toHaveProperty('metric_scope');
  });

  it('requests UTC hours only for the range whose repeated hours stay separate', () => {
    const filters = { model: [], upstream: [], operation: [], requestedServiceTier: [], serviceTier: [], runtimeLocation: [], userId: [], keyId: [] };

    expect(buildPerformanceQuery('today', 'model', filters, Date.UTC(2026, 10, 1, 7))).toMatchObject({
      bucket: 'hour',
      timezone: 'UTC',
      timezone_offset_minutes: '0',
    });
    expect(buildPerformanceQuery('30d', 'model', filters, Date.UTC(2026, 10, 1, 7)).bucket).toBe('day');
  });

  it('converts TPOT microseconds to output tokens per second', () => {
    const record = { tpotUsP95: 20_000 } as Parameters<typeof performanceValue>[0];
    expect(performanceValue(record, 'tokPerSec', 'p95')).toBe(50);
  });

  it('reads the selected percentile for either metric', () => {
    const record = { ttftMsP50: 100, ttftMsP99: 300, tpotUsP50: 10_000, tpotUsP99: 40_000 } as Parameters<typeof performanceValue>[0];

    expect(performanceValue(record, 'ttft', 'p50')).toBe(100);
    expect(performanceValue(record, 'ttft', 'p99')).toBe(300);
    expect(performanceValue(record, 'tokPerSec', 'p50')).toBe(100);
    expect(performanceValue(record, 'tokPerSec', 'p99')).toBe(25);
  });

  it('names the share of readings below each percentile for the speed label', () => {
    expect(performancePercentileTailOf('p50')).toBe(50);
    expect(performancePercentileTailOf('p95')).toBe(5);
    expect(performancePercentileTailOf('p99')).toBe(1);
  });

  it('round-trips non-default dashboard state through the URL', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('m=tokPerSec&ttft_p=p99&speed_p=p50&tab=upstream&sort=errors&dir=ascending&g=upstream&r=30d&fm=&fm=gpt-5&fm=gpt-5&fm=claude-opus-4-7&hide=a%252Cb,c'));
    const serialized = serializePerformanceUrlState({ ...state, hidden: ['a,b', '100%', '模型', 'duplicate', 'duplicate'] });
    expect(parsePerformanceUrlState(serialized)).toMatchObject({
      metric: 'tokPerSec',
      percentile: 'p50',
      breakdown: 'upstream',
      sort: { key: 'errors', direction: 'ascending' },
      groupBy: 'upstream',
      range: '30d',
      filters: { model: ['gpt-5', 'claude-opus-4-7'] },
      hidden: ['100%', 'a,b', 'duplicate', 'duplicate', '模型'],
    });
    expect(serialized.get('m')).toBe('tokPerSec');
    expect(serialized.get('p')).toBe('p50');
    expect(serialized.has('ttft_p')).toBe(false);
    expect(serialized.has('speed_p')).toBe(false);
    expect(serialized.get('tab')).toBe('upstream');
    expect(serialized.get('sort')).toBe('errors');
    expect(serialized.get('dir')).toBe('ascending');
    expect(serialized.getAll('fm')).toEqual(['gpt-5', 'claude-opus-4-7']);
  });

  it.each(['requestedServiceTier', 'serviceTier'] as const)('round-trips %s grouping while preserving both tier filters', groupBy => {
    const state = parsePerformanceUrlState(new URLSearchParams(`g=${groupBy}&tab=${groupBy}&tier=&requested_tier=priority&fm=model-a`));
    const filters = { requestedServiceTier: ['priority'], serviceTier: [''] };

    expect(state).toMatchObject({ groupBy, breakdown: groupBy, filters: { ...filters, model: ['model-a'] } });
    expect(parsePerformanceUrlState(serializePerformanceUrlState(state))).toEqual(state);
    expect(buildPerformanceQuery(state.range, state.groupBy, state.filters, 0)).toMatchObject({
      group_by: groupBy, filter_requested_service_tier: filters.requestedServiceTier, filter_service_tier: filters.serviceTier, filter_model: ['model-a'],
    });
  });

  it.each([{ tiers: [''] }, { tiers: ['', 'priority', 'default', 'standard', 'future,tier/模型', '  vendor tier  '] }])('preserves both raw tier filters including the empty bucket: $tiers', ({ tiers }) => {
    const search = new URLSearchParams();
    for (const tier of [...tiers, ...tiers]) {
      search.append('tier', tier);
      search.append('requested_tier', tier);
    }
    const state = parsePerformanceUrlState(search);
    const serialized = serializePerformanceUrlState(state);

    expect(state.groupBy).toBe('model');
    expect(state.filters.requestedServiceTier).toEqual(tiers);
    expect(state.filters.serviceTier).toEqual(tiers);
    expect(serialized.getAll('requested_tier')).toEqual(tiers);
    expect(serialized.getAll('tier')).toEqual(tiers);
    expect(parsePerformanceUrlState(serialized).filters).toEqual(state.filters);
    expect(buildPerformanceQuery(state.range, state.groupBy, state.filters, 0)).toMatchObject({
      filter_requested_service_tier: tiers, filter_service_tier: tiers,
    });
    const cleared = serializePerformanceUrlState({ ...state, filters: { ...state.filters, requestedServiceTier: [] } });
    expect(cleared.has('requested_tier')).toBe(false);
    expect(cleared.getAll('tier')).toEqual(tiers);
  });

  it('round-trips comparison, model/tier multiselects and structured hidden IDs', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('compare=requestedServiceTier&fm=model-a&fm=model-b&requested_tier=&requested_tier=future%2C%E9%9B%AA'));
    const hidden = JSON.stringify(['model-a', 'future,雪']);
    expect(state).toMatchObject({ compareBy: 'requestedServiceTier', breakdown: 'comparison', filters: { model: ['model-a', 'model-b'], requestedServiceTier: ['', 'future,雪'] } });
    expect(parsePerformanceUrlState(serializePerformanceUrlState({ ...state, hidden: [hidden] }))).toEqual({ ...state, hidden: [hidden] });
    expect(buildPerformanceQuery(state.range, state.groupBy, state.filters, 0, state.compareBy)).toMatchObject({ compare_by: 'requestedServiceTier', group_by: 'model', filter_model: ['model-a', 'model-b'], filter_requested_service_tier: ['', 'future,雪'] });
    expect(parsePerformanceUrlState(new URLSearchParams('g=upstream&compare=requestedServiceTier&tab=comparison'))).toMatchObject({ groupBy: 'upstream', compareBy: undefined, breakdown: 'model' });
    expect(parsePerformanceUrlState(new URLSearchParams('compare=serviceTier')).compareBy).toBeUndefined();
  });

  it.each([
    ['', 'p95'], ['p=p50', 'p50'], ['p=p95', 'p95'], ['p=p99', 'p99'],
    ['ttft_p=p99&speed_p=p50', 'p99'],
    ['m=tokPerSec&ttft_p=p99&speed_p=p50', 'p50'],
    ['m=invalid&ttft_p=p99&speed_p=p50', 'p99'],
    ['speed_p=p50', 'p95'], ['m=tokPerSec&ttft_p=p99', 'p95'],
    ['ttft_p=invalid&speed_p=p50', 'p95'],
    ['m=tokPerSec&speed_p=invalid&ttft_p=p99', 'p95'],
    ['p=p99&ttft_p=p50&speed_p=p50', 'p99'],
    ['m=tokPerSec&p=p95&ttft_p=p99&speed_p=p50', 'p95'],
    ['p=&ttft_p=p99', 'p95'], ['p=invalid&ttft_p=p99', 'p95'],
  ])('normalizes shared and legacy percentile links: %s', (search, percentile) => {
    const state = parsePerformanceUrlState(new URLSearchParams(search));
    const serialized = serializePerformanceUrlState(state);

    expect(state.percentile).toBe(percentile);
    expect(serialized.get('p')).toBe(percentile === 'p95' ? null : percentile);
    expect(serialized.has('ttft_p')).toBe(false);
    expect(serialized.has('speed_p')).toBe(false);
    expect(parsePerformanceUrlState(serialized)).toEqual(state);
  });

  it('reads the table breakdown and sort from the URL', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('tab=operation&sort=speed&dir=ascending'));

    expect(state.breakdown).toBe('operation');
    expect(state.sort).toEqual({ key: 'speed', direction: 'ascending' });
    expect(serializePerformanceUrlState(state).toString()).toBe('tab=operation&sort=speed&dir=ascending');
  });

  it('omits a default sort and direction from the URL', () => {
    const state = parsePerformanceUrlState(new URLSearchParams());

    expect(state.sort).toEqual({ key: 'requests', direction: 'descending' });
    expect(serializePerformanceUrlState(state).toString()).toBe('');
  });

  it('restores hidden series from the original comma format', () => {
    expect(parsePerformanceUrlState(new URLSearchParams('hide=a%252Cb,c')).hidden).toEqual(['a,b', 'c']);
  });

  it('distinguishes one comma-containing id in the repeated parameter format', () => {
    const state = parsePerformanceUrlState(new URLSearchParams());
    const serialized = serializePerformanceUrlState({ ...state, hidden: ['a,b'] });

    expect(serialized.get('hidev')).toBe('2');
    expect(serialized.getAll('hide')).toEqual(['a,b']);
    expect(parsePerformanceUrlState(serialized).hidden).toEqual(['a,b']);
  });

  it('serializes hidden series as stable repeated parameters', () => {
    const state = parsePerformanceUrlState(new URLSearchParams());
    const first = serializePerformanceUrlState({ ...state, hidden: ['模型', 'duplicate', '100%', 'a,b', 'duplicate'] });
    const second = serializePerformanceUrlState({ ...state, hidden: ['duplicate', 'a,b', '模型', '100%', 'duplicate'] });

    expect(first.toString()).toBe(second.toString());
    expect(first.get('hidev')).toBe('2');
    expect(first.getAll('hide')).toEqual(['100%', 'a,b', 'duplicate', 'duplicate', '模型']);
    expect(parsePerformanceUrlState(first).hidden).toEqual(['100%', 'a,b', 'duplicate', 'duplicate', '模型']);
  });

  it('removes Region state outside the Cloudflare runtime', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('g=runtimeLocation&tab=runtimeLocation&fm=gpt-5&fr=SJC&hide=SJC'));
    expect(normalizePerformanceDimensionsForRuntime(state, false)).toMatchObject({
      changed: true,
      state: {
        groupBy: 'model',
        filters: { model: ['gpt-5'], runtimeLocation: [] },
        hidden: [],
      },
    });
    expect(normalizePerformanceDimensionsForRuntime(state, true)).toEqual({ changed: false, state });
    expect(normalizePerformanceBreakdownForRuntime(state.breakdown, false)).toBe('model');
    expect(normalizePerformanceBreakdownForRuntime(state.breakdown, true)).toBe(state.breakdown);
  });
});

describe('performance chart series', () => {
  const record = (group: string): PerformanceDisplayRecord => ({
    bucket: 'bucket-1',
    group,
    requests: 1,
    errors: 0,
    ttftSamples: 1,
    tpotSamples: 1,
    neutral: 0,
    ttftMsP50: 10,
    ttftMsP95: 20,
    ttftMsP99: 30,
    tpotUsP50: 10_000,
    tpotUsP95: 20_000,
    tpotUsP99: 30_000,
  });
  const buckets = [{ key: 'bucket-1', label: 'Bucket 1', date: new Date(0), start: 0, end: 3_600_000 }];

  it.each(['ttft', 'tokPerSec'] as const)('uses one percentile for the %s curve and both hover values', metric => {
    const labels = performanceLabels(emptyOverview(), [], en.translation.dashboard.performance);
    for (const [percentile, ttft, outputSpeed] of [['p50', 10, 100], ['p95', 20, 50], ['p99', 30, 1_000_000 / 30_000]] as const) {
      const chart = buildPerformanceChart([record('model-a')], metric, percentile, 'model', labels, buckets, 'today');
      expect(chart.data.lineChartData?.[0].data).toEqual([expect.objectContaining({ x: new Date(0), y: metric === 'ttft' ? ttft : outputSpeed })]);
      expect(chart.details.get(0)?.get('model-a')).toEqual({ ttft, outputSpeed });
    }
  });

  it.each([null, 0, -1])('keeps missing or invalid speed readings out of the curve: %s', tpot => {
    const labels = performanceLabels(emptyOverview(), [], en.translation.dashboard.performance);
    const row = { ...record('model-a'), ttftMsP50: null, ttftMsP95: null, ttftMsP99: null, tpotUsP50: tpot, tpotUsP95: tpot, tpotUsP99: tpot };
    for (const percentile of ['p50', 'p95', 'p99'] as const) {
      const chart = buildPerformanceChart([row], 'tokPerSec', percentile, 'model', labels, buckets, 'today');
      expect(chart.data.lineChartData).toEqual([]);
      expect(chart.details.get(0)?.get('model-a')).toEqual({ ttft: null, outputSpeed: null });
    }
  });

  it('uses stable group ids when two API keys have the same name', () => {
    const overview = emptyOverview();
    overview.keys = [
      { id: 'key-1', name: 'Shared name', createdAt: '' },
      { id: 'key-2', name: 'Shared name', createdAt: '' },
    ];
    const chart = buildPerformanceChart(
      [record('key-1'), record('key-2')],
      'ttft',
      'p95',
      'keyId',
      performanceLabels(overview, [], en.translation.dashboard.performance),
      buckets,
      'today',
    );

    expect(chart.entries.map(entry => entry.label)).toEqual(['Shared name', 'Shared name']);
    expect(chart.entries.map(entry => entry.id)).toEqual(['key-1', 'key-2']);
    expect(chart.data.lineChartData?.map(series => series.legend)).toEqual(['Shared name (1)', 'Shared name (2)']);
    expect(chart.details.get(0)?.get('key-1')).toEqual({ outputSpeed: 50, ttft: 20 });
  });

  it.each([
    ['en', en, 'Unspecified / not recorded', 'Unreported / not recorded'],
    ['zh-Hans', zhHans, '未指定 / 未记录', '未上报 / 未记录'],
  ] as const)('localizes only the unknown tiers in %s without changing series IDs', (_language, resource, requestedLabel, reportedLabel) => {
    const labels = performanceLabels(emptyOverview(), [], resource.translation.dashboard.performance);
    const groups = ['', 'priority', 'future,tier/模型', 'default', 'standard', '  vendor tier  '];
    for (const [groupBy, unknownLabel] of [['requestedServiceTier', requestedLabel], ['serviceTier', reportedLabel]] as const) {
      const chart = buildPerformanceChart(groups.map(record), 'ttft', 'p95', groupBy, labels, buckets, 'today');
      expect(chart.entries.map(entry => [entry.id, entry.label])).toEqual(
        [...groups].sort().map(group => [group, group === '' ? unknownLabel : group]),
      );
      expect(chart.details.get(0)?.get('')).toEqual({ outputSpeed: 50, ttft: 20 });
    }
    expect(resolvePerformanceGroup('', 'model', labels)).toBe('');
  });

  it('resolves six Fluent categorical slots to their selected theme steps', () => {
    expect(comparisonPalette).toEqual({
      light: ['#637cef', '#e3008c', '#13a10e', '#3a96dd', '#ca5010', '#b146c2'],
      dark: ['#637cef', '#ea38a6', '#13a10e', '#3a96dd', '#d77440', '#c36bd1'],
    });
    for (const colors of Object.values(comparisonPalette)) expect(new Set(colors).size).toBe(6);
  });

  it('keeps tuple colors across filters and themes without cycling beyond six', () => {
    const groups = ['model-a', 'model-b'].flatMap(model => ['', 'priority'].map(tier => ({ id: JSON.stringify([model, tier]), model, tier })));
    const overview = { ...emptyOverview(), comparison: { by: 'requestedServiceTier' as const, groups, rows: groups.map(group => record(group.id)) } };
    const labels = performanceLabels(overview, [], en.translation.dashboard.performance);
    const slots = assignComparisonSlots(groups.map(group => group.id), new Map());
    const chart = buildPerformanceChart(overview.comparison.rows, 'ttft', 'p95', 'comparison', labels, buckets, 'today', { slots, dark: false });
    expect(chart.entries).toHaveLength(4);
    expect(chart.entries.map(entry => entry.label)).toContain('model-a · Unspecified / not recorded');
    expect(chart.entries.map(entry => entry.color)).toEqual(comparisonPalette.light.slice(0, 4));
    const surviving = groups.slice(1, 3).map(group => group.id);
    const filteredSlots = assignComparisonSlots(surviving, slots);
    expect([...filteredSlots]).toEqual([...slots].filter(([id]) => surviving.includes(id)));
    const dark = buildPerformanceChart(overview.comparison.rows.filter(row => surviving.includes(row.group)), 'ttft', 'p95', 'comparison', labels, buckets, 'today', { slots: filteredSlots, dark: true });
    expect(dark.entries.map(entry => entry.color)).toEqual(comparisonPalette.dark.slice(1, 3));
    expect(dark.entries[0].color).not.toBe(chart.entries[1].color);
    const seven = Array.from({ length: 7 }, (_, index) => record(JSON.stringify([String(index), ''])));
    const limited = buildPerformanceChart(seven, 'ttft', 'p95', 'comparison', labels, buckets, 'today', { slots, dark: false });
    expect(limited.comparisonLimitExceeded).toBe(true);
    expect(limited.data.lineChartData).toEqual([]);
    expect(assignComparisonSlots(seven.map(row => row.group), slots)).toEqual(slots);
  });

  it('uses configured hues for upstream series', () => {
    const overview = emptyOverview();
    const chart = buildPerformanceChart(
      [record('up-1')],
      'ttft',
      'p95',
      'upstream',
      performanceLabels(overview, [{ id: 'up-1', name: 'Copilot seat', hue: 217 }], en.translation.dashboard.performance),
      buckets,
      'today',
    );

    expect(chart.entries[0]).toMatchObject({ id: 'up-1', label: 'Copilot seat', hue: 217 });
    expect(chart.data.lineChartData?.[0]?.color).toBe('#00b1d3');
  });
});
