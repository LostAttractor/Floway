import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { UpstreamUsageChartSection } from '../../../src/components/upstream-usage/chart';
import type { UpstreamUsageChart } from '../../../src/components/upstream-usage/plot';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 40, 12)));

const chart: UpstreamUsageChart = {
  id: 'seat', title: 'Seat', hiddenByDefault: new Set(),
  entries: [{ id: 'usage', label: 'English meter', unit: 'percent', form: 'line', hue: 210 }],
  values: new Map([['usage', [{ timestamp: 1_000, value: 25 }, { timestamp: 60_000, value: 25 }]]]),
};

it('keeps an active native tooltip valid while series labels are updated', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamUsageChartSection chart={chart} start={0} end={60_000} />);
  const application = await screen.findByRole('application', { name: 'Seat' });
  fireEvent.focus(application);
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('25%'));
  expect(screen.getByRole('status').textContent).toContain('English meter');
  view.rerender(<UpstreamUsageChartSection chart={{ ...chart, entries: [{ ...chart.entries[0]!, label: 'Chinese meter' }] }} start={0} end={60_000} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Chinese meter'));
  expect(screen.getByRole('status').textContent).toContain('25%');
});

it('shows the two highest-priority unit axes while retaining every curve and tooltip value', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamUsageChart = {
    ...chart,
    entries: [...chart.entries, { id: 'cost', label: 'Cost', unit: 'usd', form: 'line', hue: 30 }, { id: 'credits', label: 'Balance', unit: 'credits', form: 'line', hue: 150 }],
    values: new Map([...chart.values, ['cost', [{ timestamp: 1_000, value: 3 }, { timestamp: 60_000, value: 3 }]], ['credits', [{ timestamp: 1_000, value: 200 }, { timestamp: 60_000, value: 200 }]]]),
  };
  const view = renderInApp(<UpstreamUsageChartSection chart={multi} start={0} end={60_000} />);
  const application = await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelectorAll('.recharts-yAxis-tick-labels')[0]!.textContent).toContain('100%'));
  const axes = view.container.querySelectorAll('.recharts-yAxis');
  expect(axes).toHaveLength(2);
  const ticks = view.container.querySelectorAll('.recharts-yAxis-tick-labels');
  expect(ticks[1]!.textContent).toContain('$3.00');
  expect(ticks[0]!.querySelector('text')!.getAttribute('text-anchor')).toBe('end');
  expect(ticks[1]!.querySelector('text')!.getAttribute('text-anchor')).toBe('start');
  expect(view.container.querySelectorAll('.recharts-label')).toHaveLength(0);
  const gridLines = view.container.querySelectorAll('.recharts-cartesian-grid-horizontal line');
  expect(gridLines.length).toBeGreaterThanOrEqual(4);
  for (const line of gridLines) expect(line.getAttribute('y1')).toBe(line.getAttribute('y2'));
  const tickYs = [...view.container.querySelectorAll('.recharts-yAxis-tick-labels')[0]!.querySelectorAll('text')].map(tick => tick.getAttribute('y'));
  for (const y of tickYs) expect([...gridLines].some(line => line.getAttribute('y1') === y)).toBe(true);
  expect(view.container.querySelectorAll('.recharts-line-curve')).toHaveLength(3);
  expect(view.container.querySelectorAll('.recharts-wrapper')).toHaveLength(1);
  expect(view.container.textContent).toContain('100%');
  expect(view.container.textContent).toContain('$3.00');
  expect(view.container.textContent).not.toContain('200');
  fireEvent.focus(application);
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('200'));
  expect(screen.getByRole('status').textContent).not.toContain('credits');
  expect(screen.getByRole('status').textContent).toContain('$3.00');
  expect(screen.getByRole('status').textContent).toContain('25%');
});

it('places the highest-priority available unit on the left when percent is absent', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamUsageChart = {
    ...chart,
    entries: [{ id: 'credits', label: 'Balance', unit: 'credits', form: 'line', hue: 150 }, { id: 'cost', label: 'Cost', unit: 'usd', form: 'line', hue: 30 }],
    values: new Map([['credits', [{ timestamp: 1_000, value: 200 }, { timestamp: 60_000, value: 200 }]], ['cost', [{ timestamp: 1_000, value: 3 }, { timestamp: 60_000, value: 3 }]]]),
  };
  const view = renderInApp(<UpstreamUsageChartSection chart={multi} start={0} end={60_000} />);
  await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelectorAll('.recharts-yAxis-tick-labels')[0]!.textContent).toContain('$3.00'));
  const axes = view.container.querySelectorAll('.recharts-yAxis');
  expect(axes).toHaveLength(2);
  expect(view.container.querySelectorAll('.recharts-yAxis-tick-labels')[1]!.textContent).toContain('200');
  expect(view.container.querySelectorAll('.recharts-label')).toHaveLength(0);
});

it('lets the reader restore an initially hidden empty metric through its legend', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamUsageChartSection chart={{ ...chart, hiddenByDefault: new Set(['usage']) }} start={0} end={60_000} />);
  const legend = screen.getByText('English meter');
  expect(legend.closest('button')!.className).toContain('line-through');
  expect(view.container.querySelector('.recharts-line-curve')).toBeNull();
  fireEvent.click(legend);
  await waitFor(() => expect(view.container.querySelector('.recharts-line-curve')).not.toBeNull());
});

it('overlays areas independently, connects interior missing points, and leaves outer ranges blank', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamUsageChart = {
    ...chart,
    entries: [{ id: 'area', label: 'Usage', unit: 'percent', form: 'area', hue: 210 }, { id: 'line', label: 'Balance', unit: 'percent', form: 'line', hue: 30 }],
    values: new Map([
      ['area', [{ timestamp: 10_000, value: 20 }, { timestamp: 50_000, value: 40 }]],
      ['line', [{ timestamp: 30_000, value: 80 }, { timestamp: 50_000, value: 80 }]],
    ]),
  };
  const view = renderInApp(<UpstreamUsageChartSection chart={multi} start={0} end={60_000} />);
  await waitFor(() => expect(view.container.querySelector('.recharts-area-curve')).not.toBeNull());
  expect(view.container.querySelectorAll('.recharts-area-area')).toHaveLength(1);
  expect(view.container.querySelectorAll('.recharts-line-curve')).toHaveLength(1);
  const points = [...view.container.querySelectorAll('.recharts-area-dots circle')];
  expect(points).toHaveLength(2);
  expect(Number(points[0]!.getAttribute('cx'))).toBeGreaterThan(54);
  expect(Number(points[1]!.getAttribute('cx'))).toBeLessThan(720);
  expect(view.container.querySelector('.recharts-area-curve')!.getAttribute('d')!.match(/M/g)).toHaveLength(1);
});

it.each([Number.MIN_VALUE, -Number.MIN_VALUE, 1e308, -1e308])('renders finite axis progression for %s', async value => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamUsageChartSection chart={{ ...chart, entries: [{ ...chart.entries[0]!, unit: 'usd' }], values: new Map([['usage', [{ timestamp: 1_000, value }, { timestamp: 60_000, value }]]]) }} start={0} end={60_000} />);
  await screen.findByRole('application', { name: 'Seat' });
  expect(view.container.innerHTML).not.toContain('Infinity');
});
