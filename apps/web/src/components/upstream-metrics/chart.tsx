import { useEffect, useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';

import { upstreamMetricsPlotRows, type UpstreamMetricsChart } from './plot';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { numericDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { ChartCalloutTable } from '../charts/callout-table';
import { formatAxisDate } from '../charts/dashboard-time';
import { chartCalloutStyle, chartTickStyle } from '../charts/frame-styles';
import { ChartHost } from '../charts/host';
import { chartMargins } from '../charts/layout';
import { colorForHue } from '../charts/palette';
import { ChartSection } from '../charts/section';
import { withUniqueSeriesLegends } from '../charts/series-legends';
import type { UpstreamMetricUnit } from '@floway-dev/provider/browser';

const unitAxes: Record<UpstreamMetricUnit, { priority: number; width: number }> = {
  percent: { priority: 3, width: chartMargins.left },
  usd: { priority: 2, width: 80 },
  credits: { priority: 1, width: chartMargins.left },
};
const calloutStyle = {
  ...chartCalloutStyle,
  border: '1px solid var(--winui-surface-stroke-flyout)',
  borderRadius: 'var(--borderRadiusMedium)',
  boxShadow: 'var(--shadow16)',
};
const { Popover, PopoverSurface } = fluentComponents;

const metricAxis = (values: readonly number[], unit: UpstreamMetricUnit) => {
  const minimum = values.reduce((bound, value) => Math.min(bound, value), 0);
  const maximum = values.reduce((bound, value) => Math.max(bound, value), unit === 'percent' ? 100 : 0);
  const upper = minimum === maximum ? maximum + 1 : maximum;
  const interval = upper / 4 - minimum / 4;
  const step = Math.max(Number.MIN_VALUE, interval >= 1 ? Math.ceil(interval) : interval);
  const ticks = [minimum < 0 ? 0 : minimum];
  if (minimum < 0) {
    while (ticks.at(-1)! > minimum) ticks.push(Math.max(minimum, ticks.at(-1)! - step));
    ticks.reverse();
  }
  while (ticks.at(-1)! < upper) ticks.push(Math.min(upper, ticks.at(-1)! + step));
  return { ticks, domain: [ticks[0]!, ticks.at(-1)!] as [number, number] };
};

function MetricsCallout({ active, coordinate, label, payload, element, formatters }: TooltipContentProps & { element: HTMLElement; formatters: Record<UpstreamMetricUnit, (value: number) => string> }) {
  const { t } = useTranslation();
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const move = (event: MouseEvent) => setPointer({ x: event.clientX, y: event.clientY });
    const keyboard = () => setPointer(null);
    element.addEventListener('mousemove', move);
    element.addEventListener('keydown', keyboard);
    element.addEventListener('mouseleave', keyboard);
    return () => {
      element.removeEventListener('mousemove', move);
      element.removeEventListener('keydown', keyboard);
      element.removeEventListener('mouseleave', keyboard);
    };
  }, [element]);
  if (!active || coordinate === undefined) return null;
  const rect = element.getBoundingClientRect();
  const point = pointer ?? { x: rect.left + coordinate.x, y: rect.top + coordinate.y };
  const target = { getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) };
  return <Popover inline open positioning={{ target, autoSize: 'always', offset: 20, coverTarget: false }}>
    <PopoverSurface aria-live="polite" role="status" style={calloutStyle}>
      <ChartCalloutTable
        columns={[{ key: 'value', label: t('dashboard.upstreamMetrics.value') }]}
        rows={payload.map(value => ({ key: value.graphicalItemId, label: value.name, color: value.color!, values: [formatters[value.unit as UpstreamMetricUnit](value.value as number)] }))}
        title={formatAxisDate(new Date(Number(label)))}
      />
    </PopoverSurface>
  </Popover>;
}

export function UpstreamMetricsChartSection({ chart, start, end }: { chart: UpstreamMetricsChart; start: number; end: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(chart.hiddenByDefault));
  const units = (Object.keys(unitAxes) as UpstreamMetricUnit[])
    .filter(unit => chart.entries.some(entry => entry.unit === unit))
    .sort((left, right) => unitAxes[right].priority - unitAxes[left].priority);
  const data = useMemo(() => upstreamMetricsPlotRows(chart, start, end), [chart, end, start]);
  const axes = useMemo(() => new Map(units.map(unit => [unit, metricAxis(chart.entries.filter(entry => entry.unit === unit).flatMap(entry => data.flatMap(row => entry.id in row.values ? [row.values[entry.id]!] : [])), unit)])), [chart.entries, data, units]);
  const series = withUniqueSeriesLegends(chart.entries);
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const formatters: Record<UpstreamMetricUnit, (value: number) => string> = {
    percent: value => `${numberFormat.format(value)}%`,
    usd: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 5 }).format,
    credits: numberFormat.format,
  };
  return <ChartSection controlsLabel={chart.title} emptyText={t('dashboard.upstreamMetrics.empty')} entries={series} hidden={hidden} onHiddenChange={setHidden} title={chart.title}>
    <ChartHost className="" emptyText={t('dashboard.upstreamMetrics.empty')} hasData={chart.entries.some(entry => !hidden.has(entry.id) && data.some(row => entry.id in row.values))}>
      {({ element, size }) => {
        const plotWidth = size.width - units.slice(0, 2).reduce((width, unit) => width + unitAxes[unit].width, 0);
        const tickCount = Math.max(2, Math.min(7, Math.floor(plotWidth / 120)));
        return <ComposedChart
          accessibilityLayer
          aria-label={chart.title}
          data={data}
          height={size.height}
          margin={{ top: chartMargins.top, right: 0, bottom: 0, left: 0 }}
          width={size.width}
        >
          <CartesianGrid stroke="var(--colorNeutralForeground1)" strokeOpacity={0.2} strokeWidth={1} vertical={false} yAxisId={units[0]!} />
          <XAxis
            axisLine={false}
            dataKey="timestamp"
            domain={[start, end]}
            height={chartMargins.bottom}
            interval="preserveStartEnd"
            scale="time"
            tick={chartTickStyle}
            tickFormatter={value => plotWidth < 240 ? numericDate(new Date(value)) : formatAxisDate(new Date(value))}
            tickLine={false}
            ticks={Array.from({ length: tickCount }, (_, index) => start + (end - start) * index / (tickCount - 1))}
            type="number"
          />
          {units.map((unit, index) => <YAxis
            axisLine={false}
            domain={axes.get(unit)!.domain}
            includeHidden
            hide={index >= 2}
            key={unit}
            orientation={index === 0 ? 'left' : 'right'}
            tick={chartTickStyle}
            tickFormatter={formatters[unit]}
            tickLine={false}
            ticks={axes.get(unit)!.ticks}
            width={index < 2 ? unitAxes[unit].width : 0}
            yAxisId={unit}
          />)}
          <Tooltip
            content={props => <MetricsCallout {...props} element={element} formatters={formatters} />}
            cursor={{ stroke: 'var(--colorNeutralStroke1)', strokeDasharray: '5,5' }}
            filterNull
            isAnimationActive={false}
            itemSorter="dataKey"
            portal={element}
            wrapperStyle={{ position: 'static', transform: 'none' }}
          />
          {series.toSorted((left, right) => Number(left.form === 'line') - Number(right.form === 'line')).map(entry => {
            const Series = entry.form === 'area' ? Area : Line;
            return <Series
              activeDot={{ r: 4 }}
              connectNulls
              dataKey={(row: (typeof data)[number]) => row.values[entry.id]}
              dot={{ r: 2 }}
              hide={hidden.has(entry.id)}
              isAnimationActive={false}
              key={entry.id}
              name={entry.legend}
              stroke={colorForHue(entry.hue)}
              strokeWidth={2}
              fill={colorForHue(entry.hue)}
              fillOpacity={0.16}
              type="monotoneX"
              unit={entry.unit}
              yAxisId={entry.unit}
            />;
          })}
        </ComposedChart>;
      }}
    </ChartHost>
  </ChartSection>;
}
