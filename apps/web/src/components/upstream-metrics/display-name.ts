import type { UpstreamMetricsMetadata } from './data';
import type { TranslationKey, useTranslation } from '../../i18n/translation';
import { copilotQuotaName } from '../upstreams/copilot-quota';
import { upstreamMetricAxisPriority, type UpstreamMetricDisplay, type UpstreamMetricIdentity } from '@floway-dev/provider/browser';
import { resolveUpstreamMetricDisplay as claudeCodeDisplay } from '@floway-dev/provider-claude-code/browser';
import { resolveUpstreamMetricDisplay as codexDisplay } from '@floway-dev/provider-codex/browser';
import { resolveUpstreamMetricDisplay as copilotDisplay } from '@floway-dev/provider-copilot/browser';
import { resolveUpstreamMetricDisplay as ollamaDisplay } from '@floway-dev/provider-ollama/browser';

type Translate = ReturnType<typeof useTranslation>['t'];

const names = new Map<string, Exclude<Extract<TranslationKey, `dashboard.upstreamMetrics.metrics.${string}`>, 'dashboard.upstreamMetrics.metrics.window'>>([
  ['five_hour', 'dashboard.upstreamMetrics.metrics.fiveHour'],
  ['seven_day', 'dashboard.upstreamMetrics.metrics.sevenDay'],
  ['seven_day_sonnet', 'dashboard.upstreamMetrics.metrics.sevenDaySonnet'],
  ['seven_day_opus', 'dashboard.upstreamMetrics.metrics.sevenDayOpus'],
  ['extra_usage', 'dashboard.upstreamMetrics.metrics.extraUsage'],
  ['session', 'dashboard.upstreamMetrics.metrics.session'],
  ['weekly', 'dashboard.upstreamMetrics.metrics.sevenDay'],
  ['cost_24h', 'dashboard.upstreamMetrics.metrics.past24HoursCost'],
  ['cost_7d', 'dashboard.upstreamMetrics.metrics.past7DaysCost'],
  ['cost_30d', 'dashboard.upstreamMetrics.metrics.past30DaysCost'],
  ['included', 'dashboard.upstreamMetrics.metrics.includedBalance'],
  ['included_allowance', 'dashboard.upstreamMetrics.metrics.includedAllowance'],
  ['purchased', 'dashboard.upstreamMetrics.metrics.purchasedBalance'],
  ['credits_balance', 'dashboard.upstreamMetrics.metrics.credits'],
]);

// Identities a provider does not decode render in Prometheus exposition notation.
export const formatUpstreamMetricIdentity = ({ name, labels }: UpstreamMetricIdentity): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`).join(',')}}`;
};

const decodeProviderMetric = (kind: UpstreamMetricsMetadata['kind'], identity: UpstreamMetricIdentity): UpstreamMetricDisplay | null => {
  switch (kind) {
  case 'codex': return codexDisplay(identity);
  case 'copilot': return copilotDisplay(identity);
  case 'claude-code': return claudeCodeDisplay(identity);
  case 'ollama': return ollamaDisplay(identity);
  default: return null;
  }
};

export const resolveUpstreamMetricDisplay = (
  upstream: UpstreamMetricsMetadata,
  identity: UpstreamMetricIdentity,
  t: Translate,
): UpstreamMetricDisplay => {
  const display = decodeProviderMetric(upstream.kind, identity);
  if (display === null) {
    return { name: formatUpstreamMetricIdentity(identity), unit: 'none', axisPriority: upstreamMetricAxisPriority.unknown, windowSeconds: null, emptyValue: null, form: 'line', toDisplayValue: value => value };
  }
  const copilotQuantity = upstream.kind === 'copilot' ? display.name.startsWith('entitlement_') ? 'allowance' : 'balance' : null;
  const metricName = copilotQuantity === null ? display.name : display.name.slice(display.name.indexOf('_') + 1);
  const translation = names.get(metricName);
  const name = copilotQuantity !== null ? copilotQuotaName(t, metricName, copilotQuantity) : translation === undefined ? metricName : t(translation);
  if (display.windowSeconds === null) return { ...display, name };
  const seconds = display.windowSeconds;
  const window = seconds % 86_400 === 0 ? t('dashboard.upstreamMetrics.windows.days', { count: seconds / 86_400 })
    : seconds % 3_600 === 0 ? t('dashboard.upstreamMetrics.windows.hours', { count: seconds / 3_600 })
      : seconds % 60 === 0 ? t('dashboard.upstreamMetrics.windows.minutes', { count: seconds / 60 })
        : t('dashboard.upstreamMetrics.windows.seconds', { count: seconds });
  return {
    ...display,
    name: name === '' ? window : t('dashboard.upstreamMetrics.metrics.window', { name, window }),
  };
};
