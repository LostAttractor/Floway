import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-monitor-performance';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

// The gateway admin-gates every /api/upstreams route; an operator's session
// gets 403 there while the overview supplies the authorized upstream metadata.
const gatewayForOperator = (input: RequestInfo | URL) => {
  const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
  if (path === '/api/upstreams') return Promise.resolve(Response.json({ error: 'Admin privileges required' }, { status: 403 }));
  if (path === '/api/runtime-info') return Promise.resolve(Response.json({ kind: 'node', runtimeLocation: 'LOCAL' }));
  return Promise.resolve(Response.json({
    series: [], axes: { none: [], model: [], upstream: [], operation: [], requestedServiceTier: [], serviceTier: [], runtimeLocation: [], keyId: [], userId: [] },
    dimensionValues: { models: [], upstreams: [], operations: [], requestedServiceTiers: [], serviceTiers: [], runtimeLocations: [], userIds: [], keyIds: [] },
    users: [], upstreams: [{ id: 'up-1', name: 'Copilot seat', hue: 210 }], keys: [],
  }));
};

describe('where the performance page reads upstream names from', () => {
  it('names an upstream for an operator, whose session may not read the admin upstream list', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } } });
    vi.stubGlobal('fetch', vi.fn(gatewayForOperator));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance') } as never);

    expect(data.overview?.upstreams).toEqual([{ id: 'up-1', name: 'Copilot seat', hue: 210 }]);
    expect(data.error).toBeNull();
  });

  it('makes API key grouping explicitly current-user scoped for an administrator', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } } });
    const performanceQueries: URL[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname === '/api/performance/overview') performanceQueries.push(url);
      return gatewayForOperator(input);
    }));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=keyId&tier=&tier=vendor%2Ffast-v2&requested_tier=&requested_tier=priority') } as never);

    expect(data.state.groupBy).toBe('keyId');
    expect(data.state.filters.userId).toEqual(['1']);
    expect(performanceQueries[0].searchParams.getAll('filter_user_id')).toEqual(['1']);
    expect(data.state.filters.serviceTier).toEqual(['', 'vendor/fast-v2']);
    expect(performanceQueries[0].searchParams.getAll('filter_service_tier')).toEqual(['', 'vendor/fast-v2']);
    expect(data.state.filters.requestedServiceTier).toEqual(['', 'priority']);
    expect(performanceQueries[0].searchParams.getAll('filter_requested_service_tier')).toEqual(['', 'priority']);
  });

  it('loads comparison, same-axis multiselects and hidden tuples through Node normalization', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } } });
    const performanceQueries: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      const response = await gatewayForOperator(input);
      if (url.pathname !== '/api/performance/overview') return response;
      performanceQueries.push(url);
      return Response.json({ ...await response.json(), comparison: { by: 'requestedServiceTier', groups: [], rows: [] } });
    }));
    const hidden = JSON.stringify(['model,b', 'priority']);
    const search = new URLSearchParams('compare=requestedServiceTier&fm=model-a&fm=model%2Cb&requested_tier=&requested_tier=priority&tier=historical&fr=SJC&hidev=2');
    search.append('hide', hidden);
    const data = await clientLoader({ request: new Request(`http://localhost/dashboard/monitor/performance?${search}`) } as never);
    expect(data.error).toBeNull();
    expect(performanceQueries).toHaveLength(2);
    for (const query of performanceQueries) {
      expect(query.searchParams.get('compare_by')).toBe('requestedServiceTier');
      expect(query.searchParams.get('group_by')).toBe('model');
      expect(query.searchParams.getAll('filter_model')).toEqual(['model-a', 'model,b']);
      expect(query.searchParams.getAll('filter_requested_service_tier')).toEqual(['', 'priority']);
      expect(query.searchParams.getAll('filter_service_tier')).toEqual(['historical']);
    }
    expect(performanceQueries[1].searchParams.getAll('filter_runtime_location')).toEqual([]);
    expect(data.state).toMatchObject({ compareBy: 'requestedServiceTier', breakdown: 'comparison', hidden: [hidden], filters: { model: ['model-a', 'model,b'], requestedServiceTier: ['', 'priority'], serviceTier: ['historical'], runtimeLocation: [] } });
    expect(data.overview?.comparison).toEqual({ by: 'requestedServiceTier', groups: [], rows: [] });
  });

  it('keeps user grouping and breakdown available to an operator like Usage', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewPermissions: false, canViewUpstreams: false, preferences: { quotaDisplay: 'remaining' as const, language: null } } });
    const performanceQueries: URL[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname === '/api/performance/overview') performanceQueries.push(url);
      return gatewayForOperator(input);
    }));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=userId&tab=userId') } as never);

    expect(data.state.groupBy).toBe('userId');
    expect(data.state.breakdown).toBe('userId');
    expect(performanceQueries[0].searchParams.get('group_by')).toBe('userId');
  });

  it('re-reads a Node overview after removing stale Region URL state', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } } });
    const fetch = vi.fn(gatewayForOperator);
    vi.stubGlobal('fetch', fetch);

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=runtimeLocation&fr=SJC') } as never);

    expect(data.regionAvailable).toBe(false);
    expect(data.state.groupBy).toBe('model');
    expect(data.state.filters.runtimeLocation).toEqual([]);
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/api/performance/overview')).toHaveLength(2);
  });

  it('keeps Region state on Cloudflare', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } } });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      return path === '/api/runtime-info'
        ? Promise.resolve(Response.json({ kind: 'cloudflare', runtimeLocation: 'SIN' }))
        : gatewayForOperator(input);
    });
    vi.stubGlobal('fetch', fetch);

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=runtimeLocation&fr=SJC') } as never);

    expect(data.regionAvailable).toBe(true);
    expect(data.state.groupBy).toBe('runtimeLocation');
    expect(data.state.filters.runtimeLocation).toEqual([]);
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/api/performance/overview')).toHaveLength(1);
  });

  it('preserves Region state when runtime capability cannot be determined', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } } });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      return path === '/api/runtime-info'
        ? Promise.resolve(Response.json({ error: 'Unavailable' }, { status: 500 }))
        : gatewayForOperator(input);
    });
    vi.stubGlobal('fetch', fetch);

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=runtimeLocation&fr=SJC') } as never);

    expect(data.regionAvailable).toBeNull();
    expect(data.state.groupBy).toBe('runtimeLocation');
    expect(data.state.filters.runtimeLocation).toEqual([]);
    expect(data.error?.message).toBe('Unavailable');
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/api/performance/overview')).toHaveLength(1);
  });
});
