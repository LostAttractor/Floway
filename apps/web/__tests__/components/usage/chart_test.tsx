import { screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ChartBucket } from '../../../src/components/charts/dashboard-time';
import { LinkedChartHoverProvider, useLinkedChartHover, type ChartHoverBucket } from '../../../src/components/charts/linked-hover';
import { UsageChart } from '../../../src/components/usage/chart';
import { buildTokenChart } from '../../../src/components/usage/plot';
import type { DisplayUsageRecord } from '../../../src/components/usage/types';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());

function HoverSource({ interval }: { interval: ChartHoverBucket }) {
  const { report } = useLinkedChartHover<ChartHoverBucket>([]);
  useEffect(() => {
    report(interval);
    return () => report(null);
  }, [interval, report]);
  return null;
}

it('renders its own callout and cursor for an assumed hover from another chart', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const hour = 3_600_000;
  const buckets: ChartBucket[] = [0, 1].map(index => ({
    key: `bucket-${index}`,
    label: `${index}:00 - ${index + 1}:00`,
    date: new Date(index * hour),
    start: index * hour,
    end: (index + 1) * hour,
  }));
  const records: DisplayUsageRecord[] = buckets.map((bucket, index) => ({
    bucket: bucket.key,
    group: 'key-1',
    requests: 1,
    metrics: { input_tokens: String((index + 1) * 10) },
    cost: null,
  }));
  const chart = buildTokenChart({
    records,
    dimensionOptions: [{ value: 'key-1', label: 'Key 1' }],
    metric: 'total',
    range: 'today',
    buckets,
  });
  const view = renderInApp(<LinkedChartHoverProvider>
    <HoverSource interval={{ start: hour - 60_000, end: hour + 60_000 }} />
    <UsageChart chart={chart} hidden={new Set()} valueFormatter={String} />
  </LinkedChartHoverProvider>);
  await waitFor(() => expect(view.container.querySelector('[data-chart-assumed-hover-cursor]')).not.toBeNull());
  expect(screen.getByRole('status').textContent).toContain('1:00 - 2:00');
  expect(screen.getByRole('status').textContent).toContain('20');
});
