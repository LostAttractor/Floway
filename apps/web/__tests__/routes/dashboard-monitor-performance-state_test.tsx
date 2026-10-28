import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardBucketFrames } from '../../src/components/charts/dashboard-time';
import { parsePerformanceUrlState, type PerformanceDisplayRecord, type PerformanceOverviewResponse } from '../../src/components/performance/overview';
import DashboardMonitorPerformance from '../../src/routes/dashboard-monitor-performance';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

stubLocalStorage();

afterEach(() => vi.unstubAllGlobals());

const loadedAt = Date.UTC(2026, 7, 5, 12);
const bucket = dashboardBucketFrames('today', loadedAt).at(-2)!.key;

const record = (group: string, values: Partial<PerformanceDisplayRecord> = {}): PerformanceDisplayRecord => ({
  bucket,
  group,
  requests: 1,
  errors: 0,
  ttftSamples: 1,
  tpotSamples: 1,
  neutral: 0,
  ttftMsP50: 100,
  ttftMsP95: 200,
  ttftMsP99: 300,
  tpotUsP50: 20_000,
  tpotUsP95: 40_000,
  tpotUsP99: 80_000,
  ...values,
});

const overview: PerformanceOverviewResponse = {
  series: [record('model-a'), record('model-b')],
  axes: {
    none: [record('')],
    keyId: [],
    userId: [],
    model: [
      record('model-a', { requests: 2, ttftMsP50: 100, ttftMsP95: 400, ttftMsP99: 450, tpotUsP50: 10_000, tpotUsP95: 50_000, tpotUsP99: 60_000 }),
      record('model-b', { requests: 9, ttftMsP50: 200, ttftMsP95: 300, ttftMsP99: 500 }),
    ],
    upstream: [],
    operation: [],
    requestedServiceTier: [record(''), record('priority'), record('default'), record('standard'), record('vendor/fast-v2')],
    serviceTier: [record(''), record('priority'), record('default'), record('standard'), record('vendor/fast-v2')],
    runtimeLocation: [],
  },
  dimensionValues: { models: ['model-a', 'model-b'], upstreams: [], operations: [], requestedServiceTiers: ['', 'priority', 'default', 'standard', 'vendor/fast-v2'], serviceTiers: ['', 'priority', 'default', 'standard', 'vendor/fast-v2'], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  upstreams: [],
  keys: [],
};

const renderPage = (search: string, data = overview) => {
  const state = parsePerformanceUrlState(new URLSearchParams(search));
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <DashboardMonitorPerformance
      loaderData={{
        currentUserId: '1',
        error: null,
        loadedAt,
        overview: data,
        regionAvailable: true,
        state,
      }}
      matches={[] as never}
      params={{}}
    />,
  }], { initialEntries: [`/?${search}`] });
  const view = renderInApp(<RouterProvider router={router} />);
  return { ...view, router };
};

const urlSearch = (router: ReturnType<typeof renderPage>['router']) => new URLSearchParams(router.state.location.search);

const comparedOverview = (count = 4): PerformanceOverviewResponse => {
  const groups = Array.from({ length: count }, (_, index) => ({ model: `model-${Math.floor(index / 2)}`, tier: index % 2 ? 'priority' : '' }))
    .map(group => ({ ...group, id: JSON.stringify([group.model, group.tier]) }));
  const rows = groups.map((group, index) => record(group.id, { requests: index + 1 }));
  return { ...overview, series: rows, comparison: { by: 'requestedServiceTier', groups, rows } };
};

describe('Performance table state', () => {
  it.each([
    ['ttft', false], ['tokPerSec', false], ['ttft', true], ['tokPerSec', true],
  ] as const)('updates both table metrics for every percentile with chart %s and comparison %s', async (metric, comparison) => {
    const data = comparison ? comparedOverview() : { ...overview, axes: { ...overview.axes, model: [record('model-a')] } };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderPage(`m=${metric}${comparison ? '&compare=requestedServiceTier' : ''}`, data);
    const group = comparison ? 'Model × Service Tier' : 'By Model';
    const table = within(screen.getByRole('table', { name: group }));
    const summary = () => screen.getByText('Speed p50').parentElement!.parentElement!.textContent;
    const initialSummary = summary();
    expect(initialSummary).toContain('50.0 tok/s');

    for (const [percentile, tail, latency, speed] of [
      ['p50', 50, '100ms', '50.0 tok/s'],
      ['p99', 1, '300ms', '12.5 tok/s'],
      ['p95', 5, '200ms', '25.0 tok/s'],
    ] as const) {
      await act(async () => { fireEvent.click(screen.getByRole('radio', { name: percentile })); });
      expect(table.getByRole('columnheader', { name: `TTFT ${percentile}` })).toBeTruthy();
      expect(table.getByRole('columnheader', { name: `Worst ${tail}% speed` })).toBeTruthy();
      expect(table.getAllByRole('cell', { name: latency }).length).toBeGreaterThan(0);
      expect(table.getAllByRole('cell', { name: speed }).length).toBeGreaterThan(0);
      expect(screen.getByText(`${group}: ${metric === 'ttft' ? `TTFT ${percentile}` : `Worst ${tail}% speed`}`)).toBeTruthy();
      expect(summary()).toBe(initialSummary);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exposes only request tiers normally and explicitly clears historical URL conditions', async () => {
    const fetch = vi.fn(async () => Response.json(overview));
    vi.stubGlobal('fetch', fetch);
    const { router, unmount } = renderPage('tier=&tier=priority');
    expect(screen.getByText(/Historical reported service tier conditions are active/)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Reported service tier (historical)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear historical tier conditions' }));
    await waitFor(() => expect(urlSearch(router).has('tier')).toBe(false));
    expect(screen.queryByRole('combobox', { name: 'Reported service tier (historical)' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'By Reported Service Tier (Historical)' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
    unmount();
    renderPage('g=serviceTier&tab=serviceTier');
    expect(screen.getByText(/Historical reported service tier conditions are active/)).toBeTruthy();
  });

  it('commits comparison with its URL/table only after success, retaining selections and hidden tuples on refresh', async () => {
    const comparison = comparedOverview();
    let fail = true;
    const requests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      requests.push(url);
      return fail ? Response.json({ error: 'Comparison failed' }, { status: 500 }) : Response.json(url.searchParams.has('compare_by') ? comparison : overview);
    }));
    const { router, unmount } = renderPage('fm=model-a&fm=model-b&requested_tier=&requested_tier=priority');
    fireEvent.click(screen.getByRole('radio', { name: 'Service tier' }));
    await waitFor(() => expect(screen.getByText('Comparison failed')).toBeTruthy());
    expect(urlSearch(router).has('compare')).toBe(false);
    expect(screen.getByRole('radio', { name: 'No split' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('table', { name: 'By Model' })).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('radio', { name: 'Service tier' }));
    await waitFor(() => expect(urlSearch(router).get('compare')).toBe('requestedServiceTier'));
    expect(requests.at(-1)?.searchParams.getAll('filter_model')).toEqual(['model-a', 'model-b']);
    expect(requests.at(-1)?.searchParams.getAll('filter_requested_service_tier')).toEqual(['', 'priority']);
    expect(within(screen.getByRole('table', { name: 'Model × Service Tier' })).getAllByRole('row')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'model-0 · priority' }));
    await waitFor(() => expect(urlSearch(router).getAll('hide')).toEqual([JSON.stringify(['model-0', 'priority'])]));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
    await waitFor(() => expect(requests).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh performance' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('button', { name: 'model-0 · priority' }).className).toContain('line-through');
    const address = urlSearch(router).toString();
    unmount();
    const restored = renderPage(address, comparison);
    expect(screen.getByRole('button', { name: 'model-0 · priority' }).className).toContain('line-through');
    fireEvent.click(screen.getByRole('radio', { name: 'No split' }));
    await waitFor(() => expect(urlSearch(restored.router).has('compare')).toBe(false));
    expect(urlSearch(restored.router).getAll('fm')).toEqual(['model-a', 'model-b']);
    expect(urlSearch(restored.router).getAll('requested_tier')).toEqual(['', 'priority']);
    expect(urlSearch(restored.router).getAll('hide')).toEqual([]);
    expect(screen.getByRole('table', { name: 'By Model' })).toBeTruthy();
  });

  it('keeps every comparison row when the six-series chart cap is exceeded', () => {
    renderPage('compare=requestedServiceTier', comparedOverview(7));
    expect(screen.getByText(/More than 6 model × tier combinations/)).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Model × Service Tier' })).getAllByRole('row')).toHaveLength(8);
    expect(screen.getByRole('tab', { name: 'By Model' })).toBeTruthy();
  });
  it('normalizes both table columns to the active metric percentile in legacy links', () => {
    renderPage('ttft_p=p99&speed_p=p50');

    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Worst 1% speed' })).toBeTruthy();
    expect(screen.getAllByRole('cell', { name: '500ms' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('cell', { name: '12.5 tok/s' }).length).toBeGreaterThan(0);
  });

  it('sorts the table by the percentile its column names', async () => {
    const { router } = renderPage('ttft_p=p95&sort=ttft');
    const modelOrder = () => screen.getAllByRole('row').slice(1).map(row => row.querySelector('td')?.textContent);

    expect(modelOrder()).toEqual(['model-a', 'model-b']);

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    await waitFor(() => expect(urlSearch(router).get('p')).toBe('p99'));
    expect(modelOrder()).toEqual(['model-b', 'model-a']);
  });

  it('preserves the shared percentile across metric switches, links, refresh and reload', async () => {
    const fetch = vi.fn(async () => Response.json(overview));
    vi.stubGlobal('fetch', fetch);
    const { router, unmount } = renderPage('ttft_p=p99&speed_p=p50');

    const target = screen.getByRole('radio', { name: 'p50' }).getAttribute('href');
    expect(parsePerformanceUrlState(new URL(target!, 'http://localhost').searchParams).percentile).toBe('p50');
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p50' })); });
    await waitFor(() => expect(urlSearch(router).get('p')).toBe('p50'));
    expect(urlSearch(router).has('ttft_p')).toBe(false);
    expect(urlSearch(router).has('speed_p')).toBe(false);

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Output speed' })); });
    await waitFor(() => expect(urlSearch(router).get('m')).toBe('tokPerSec'));
    expect(screen.getByRole('radio', { name: 'p50' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('By Model: Worst 50% speed')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    await waitFor(() => expect(urlSearch(router).get('p')).toBe('p99'));
    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Worst 1% speed' })).toBeTruthy();
    expect(screen.getByText('By Model: Worst 1% speed')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh performance' }).hasAttribute('disabled')).toBe(false));
    expect(urlSearch(router).get('p')).toBe('p99');
    const address = urlSearch(router).toString();
    unmount();
    renderPage(address);
    expect(screen.getByText('By Model: Worst 1% speed')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'TTFT' })); });
    expect(screen.getByText('By Model: TTFT p99')).toBeTruthy();
  });

  it.each([
    ['ttft', 'speed', ['model-b', 'model-a'], ['model-a', 'model-b']],
    ['tokPerSec', 'ttft', ['model-a', 'model-b'], ['model-b', 'model-a']],
  ] as const)('updates the inactive metric sort with chart %s', async (metric, sort, before, after) => {
    renderPage(`m=${metric}&sort=${sort}`);
    const modelOrder = () => screen.getAllByRole('row').slice(1).map(row => row.querySelector('td')?.textContent);
    expect(modelOrder()).toEqual(before);
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    expect(modelOrder()).toEqual(after);
    expect(screen.getByRole('columnheader', { name: sort === 'ttft' ? 'TTFT p99' : 'Worst 1% speed' }).getAttribute('aria-sort')).toBe('descending');
  });

  it('opens the breakdown and sort the URL names', () => {
    renderPage('tab=operation&sort=errors&dir=ascending');

    expect(screen.getByRole('tab', { name: 'By Operation' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('table', { name: 'By Operation' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Errors' }).getAttribute('aria-sort')).toBe('ascending');
  });

  describe.each([
    { dimension: 'requestedServiceTier', facet: 'requestedServiceTiers', param: 'requested_tier', query: 'filter_requested_service_tier', label: 'Service tier (request)', groupLabel: 'By Service Tier (Request)', unknown: 'Unspecified / not recorded', all: 'All requested service tiers', otherParam: 'tier', otherQuery: 'filter_service_tier', otherLabel: 'Reported service tier (historical)' },
    { dimension: 'serviceTier', facet: 'serviceTiers', param: 'tier', query: 'filter_service_tier', label: 'Reported service tier (historical)', groupLabel: 'By Reported Service Tier (Historical)', unknown: 'Unreported / not recorded', all: 'All reported service tiers', otherParam: 'requested_tier', otherQuery: 'filter_requested_service_tier', otherLabel: 'Service tier (request)' },
  ] as const)('$dimension', ({ dimension, facet, param, query, label, groupLabel, unknown, all, otherParam, otherQuery, otherLabel }) => {
    it('groups and breaks down by tier while keeping the other tier filter', async () => {
      const requests: URL[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        requests.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost'));
        return Response.json({ ...overview, series: overview.axes[dimension] });
      }));
      const { router } = renderPage(`${dimension === 'serviceTier' ? 'g=serviceTier&' : ''}${param}=&${otherParam}=priority&ttft_p=p99&speed_p=p50`, dimension === 'serviceTier' ? { ...overview, series: overview.axes[dimension] } : overview);

      fireEvent.click(screen.getByRole('combobox', { name: 'Group by' }));
      fireEvent.click(screen.getByRole('option', { name: groupLabel }));
      await waitFor(() => expect(urlSearch(router).get('g')).toBe(dimension));
      if (dimension !== 'serviceTier') {
        expect(requests.at(-1)?.searchParams.get('group_by')).toBe(dimension);
        expect(requests.at(-1)?.searchParams.getAll(query)).toEqual(['']);
      }
      if (dimension !== 'serviceTier') expect(requests.at(-1)?.searchParams.getAll(otherQuery)).toEqual(['priority']);
      expect(urlSearch(router).getAll(param)).toEqual(['']);
      expect(urlSearch(router).getAll(otherParam)).toEqual(['priority']);
      expect(screen.getByRole('combobox', { name: label })).toBeTruthy();
      expect(screen.getByRole('combobox', { name: otherLabel })).toBeTruthy();
      expect(screen.getByText(`${groupLabel}: TTFT p99`)).toBeTruthy();
      expect(screen.getByRole('button', { name: unknown })).toBeTruthy();

      fireEvent.click(screen.getByRole('tab', { name: groupLabel }));
      await waitFor(() => expect(urlSearch(router).get('tab')).toBe(dimension));
      const table = screen.getByRole('table', { name: groupLabel });
      for (const name of [unknown, 'priority', 'default', 'standard', 'vendor/fast-v2']) {
        expect(within(table).getByRole('cell', { name })).toBeTruthy();
      }
      expect(within(table).getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
      expect(within(table).getByRole('columnheader', { name: 'Worst 1% speed' })).toBeTruthy();

      fireEvent.click(screen.getByRole('combobox', { name: otherLabel }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'vendor/fast-v2' }));
      await waitFor(() => expect(urlSearch(router).getAll(otherParam)).toEqual(['priority', 'vendor/fast-v2']));
      expect(requests.at(-1)?.searchParams.getAll(otherQuery)).toEqual(['priority', 'vendor/fast-v2']);
      expect(requests.at(-1)?.searchParams.get('group_by')).toBe(dimension);
    });

    it('selects unknown, preserves it on refresh and view changes, and distinguishes clearing', async () => {
      const requests: URL[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        requests.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost'));
        return Response.json(overview);
      }));
      const { router } = renderPage(`${dimension === 'serviceTier' ? 'tab=serviceTier&' : ''}${otherParam}=priority`);

      fireEvent.click(screen.getByRole('combobox', { name: label }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: unknown }));
      await waitFor(() => expect(urlSearch(router).getAll(param)).toEqual(['']));
      expect(requests.at(-1)?.searchParams.getAll(query)).toEqual(['']);
      expect(parsePerformanceUrlState(urlSearch(router)).filters[dimension]).toEqual(['']);

      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'vendor/fast-v2' }));
      await waitFor(() => expect(urlSearch(router).getAll(param)).toEqual(['', 'vendor/fast-v2']));
      expect(requests.at(-1)?.searchParams.getAll(query)).toEqual(['', 'vendor/fast-v2']);
      fireEvent.click(screen.getByRole('radio', { name: 'Output speed' }));
      await waitFor(() => expect(urlSearch(router).get('m')).toBe('tokPerSec'));
      const requestCount = requests.length;
      fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
      await waitFor(() => expect(requests.length).toBe(requestCount + 1));
      expect(requests.at(-1)?.searchParams.getAll(query)).toEqual(['', 'vendor/fast-v2']);
      expect(urlSearch(router).getAll(param)).toEqual(['', 'vendor/fast-v2']);
      await waitFor(() => expect(screen.getByRole('combobox', { name: label }).hasAttribute('disabled')).toBe(false));

      fireEvent.click(screen.getByRole('combobox', { name: label }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: all }));
      await waitFor(() => expect(urlSearch(router).has(param)).toBe(false));
      expect(requests.at(-1)?.searchParams.getAll(query)).toEqual([]);
      expect(urlSearch(router).getAll(otherParam)).toEqual(['priority']);
    });

    it('keeps selected unknown and raw tiers when facets have no matching samples', () => {
      renderPage(`${param}=&${param}=stale%2Fvendor`, { ...overview, dimensionValues: { ...overview.dimensionValues, [facet]: [] } });

      fireEvent.click(screen.getByRole('combobox', { name: label }));
      expect(screen.getByRole('menuitemcheckbox', { name: unknown }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('menuitemcheckbox', { name: 'stale/vendor' }).getAttribute('aria-checked')).toBe('true');
    });

    it('restores the selected unknown tier and other filter when a request fails', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Refresh failed' }, { status: 500 })));
      const { router } = renderPage(`${param}=&${otherParam}=priority`);

      fireEvent.click(screen.getByRole('combobox', { name: label }));
      expect(screen.getByRole('menuitemcheckbox', { name: unknown }).getAttribute('aria-checked')).toBe('true');
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'vendor/fast-v2' }));
      await waitFor(() => expect(screen.getByText('Refresh failed')).toBeTruthy());
      expect(urlSearch(router).getAll(param)).toEqual(['']);
      expect(urlSearch(router).getAll(otherParam)).toEqual(['priority']);
      expect(screen.getByRole('menuitemcheckbox', { name: unknown }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('menuitemcheckbox', { name: 'vendor/fast-v2' }).getAttribute('aria-checked')).toBe('false');
    });

    it('preserves the hidden unknown group on refresh and restores it from the URL', async () => {
      const fetch = vi.fn(async () => Response.json({ ...overview, series: overview.axes[dimension] }));
      vi.stubGlobal('fetch', fetch);
      const { router, unmount } = renderPage(`g=${dimension}`, { ...overview, series: overview.axes[dimension] });

      fireEvent.click(screen.getByRole('button', { name: unknown }));
      await waitFor(() => expect(urlSearch(router).getAll('hide')).toEqual(['']));
      expect(parsePerformanceUrlState(urlSearch(router)).hidden).toEqual(['']);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh performance' }).hasAttribute('disabled')).toBe(false));
      expect(screen.getByRole('button', { name: unknown }).className).toContain('line-through');
      const search = urlSearch(router).toString();
      unmount();
      renderPage(search, { ...overview, series: overview.axes[dimension] });
      expect(screen.getByRole('button', { name: unknown }).className).toContain('line-through');
    });
  });

  it('writes the breakdown tab and table sort to the URL', async () => {
    const { router } = renderPage('');

    expect(screen.getByRole('tab', { name: 'By Upstream' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'By Operation' })); });
    await waitFor(() => expect(urlSearch(router).get('tab')).toBe('operation'));

    const errors = screen.getByRole('columnheader', { name: 'Errors' }).querySelector<HTMLElement>('[role=button]')!;
    await act(async () => { fireEvent.click(errors); });
    await waitFor(() => expect(urlSearch(router).get('sort')).toBe('errors'));
    expect(urlSearch(router).get('dir')).toBeNull();

    await act(async () => { fireEvent.click(errors); });
    await waitFor(() => expect(urlSearch(router).get('dir')).toBe('ascending'));
  });
});
