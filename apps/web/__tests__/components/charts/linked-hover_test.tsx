import { act, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { assumedChartHoverBucket, LinkedChartAssumedHover, LinkedChartHoverProvider, useLinkedChartHover, type ChartHoverBucket } from '../../../src/components/charts/linked-hover';
import { renderInApp } from '../../render';

it('maps a hover interval by rounding its right edge up to the target bucket', () => {
  const minute = 60_000;
  const target = [
    { id: '09', start: 9 * 60 * minute, end: 10 * 60 * minute },
    { id: '10', start: 10 * 60 * minute, end: 11 * 60 * minute },
  ];
  expect(assumedChartHoverBucket(target, {
    start: 9 * 60 * minute + 59 * minute,
    end: 10 * 60 * minute + minute,
  })?.id).toBe('10');
  expect(assumedChartHoverBucket(target, { start: 11 * 60 * minute, end: 11 * 60 * minute + minute })).toBeNull();
});

it('updates only the assumed-hover subscriber when another chart reports a bucket', async () => {
  const target = [{ id: 'target', start: 0, end: 60_000 }];
  let report: ((bucket: ChartHoverBucket | null) => void) | undefined;
  const chartRenders = vi.fn();
  function Source() {
    ({ report } = useLinkedChartHover<ChartHoverBucket>([]));
    return null;
  }
  function Target() {
    chartRenders();
    const { assumedStore } = useLinkedChartHover(target);
    return <LinkedChartAssumedHover store={assumedStore}>{bucket => bucket?.id ?? null}</LinkedChartAssumedHover>;
  }
  renderInApp(<LinkedChartHoverProvider><Source /><Target /></LinkedChartHoverProvider>);
  const initialChartRenders = chartRenders.mock.calls.length;
  act(() => report!({ start: 0, end: 30_000 }));
  expect(await screen.findByText('target')).not.toBeNull();
  expect(chartRenders).toHaveBeenCalledTimes(initialChartRenders);
});
