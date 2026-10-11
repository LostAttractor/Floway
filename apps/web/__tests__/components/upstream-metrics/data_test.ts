import { afterEach, expect, it, vi } from 'vitest';

import { loadUpstreamMetrics, upstreamUsageInterval } from '../../../src/components/upstream-metrics/data';
import { stubLocalStorage } from '../../local-storage-stub';

stubLocalStorage();
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('queries exact elapsed ranges without rounding minute-resolution history to hours', () => {
  const now = Date.UTC(2026, 9, 11, 12, 34, 56, 789);
  for (const [range, days] of [['today', 1], ['7d', 7], ['30d', 30]] as const) {
    expect(upstreamUsageInterval(range, now)).toEqual({ start: now - days * 86_400_000, end: now + 1 });
  }
});

it('includes complete custom calendar days in a time zone with a half-hour offset', () => {
  vi.stubEnv('TZ', 'Asia/Kolkata');
  expect(upstreamUsageInterval({ start: '2026-10-10', end: '2026-10-11' }, 0)).toEqual({ start: Date.UTC(2026, 9, 9, 18, 30), end: Date.UTC(2026, 9, 11, 18, 30) });
});

it('requests only the selected upstream and threads the cancellation signal', async () => {
  const history = { start: 0, end: 60_000, records: [{ upstreamId: 'seat', key: '["quota","premium_interactions"]', value: 25, timestamp: 1_000 }] };
  const fetcher = vi.fn(async () => Response.json(history));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  expect(await loadUpstreamMetrics('seat', 'today', 60_000, controller.signal)).toEqual({ data: history });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [request, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(new URL(request, 'http://localhost').searchParams.get('upstream_id')).toBe('seat');
  expect(init.signal).toBe(controller.signal);
});

it('exposes metric-query failures without substituting an empty result', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'History unavailable' }, { status: 500 })));
  expect(await loadUpstreamMetrics('seat', 'today', 60_000)).toMatchObject({ error: { status: 500, message: 'History unavailable' } });
});
