import { api, callApi } from '../../api/client';
import type { UpstreamOption } from '../../api/types';
import { nextCalendarDate, parseCalendarDate } from '../../lib/calendar-date';
import type { DashboardRange } from '../charts/dashboard-time';

const presetDays = { today: 1, '7d': 7, '30d': 30 } as const;
export type UpstreamMetricsMetadata = Pick<UpstreamOption, 'id' | 'name' | 'kind' | 'hue'>;

export const upstreamMetricsInterval = (range: DashboardRange, now: number) => typeof range === 'string'
  ? { start: now - presetDays[range] * 24 * 60 * 60 * 1000, end: now + 1 }
  : { start: parseCalendarDate(range.start).getTime(), end: parseCalendarDate(nextCalendarDate(range.end)).getTime() };

export const loadUpstreamMetrics = async (upstreamId: string, range: DashboardRange, now: number, signal?: AbortSignal) => {
  const { start, end } = upstreamMetricsInterval(range, now);
  return await callApi(() => api.api['upstream-metrics'].$get({ query: { upstream_id: upstreamId, start, end } }, { init: { signal } }));
};
