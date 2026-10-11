import type { UpstreamUsageMetadata } from './data';
import type { TranslationKey, useTranslation } from '../../i18n/translation';
import type { UsageMetricDisplay } from '@floway-dev/provider/browser';
import { resolveUsageMetricDisplayName as claudeCodeDisplay } from '@floway-dev/provider-claude-code/browser';
import { resolveUsageMetricDisplayName as codexDisplay } from '@floway-dev/provider-codex/browser';
import { resolveUsageMetricDisplayName as copilotDisplay } from '@floway-dev/provider-copilot/browser';
import { resolveUsageMetricDisplayName as ollamaDisplay } from '@floway-dev/provider-ollama/browser';

type Translate = ReturnType<typeof useTranslation>['t'];

const names = new Map<string, Exclude<Extract<TranslationKey, `dashboard.upstreamMetrics.metrics.${string}`>, 'dashboard.upstreamMetrics.metrics.window'>>([
  ['five_hour', 'dashboard.upstreamMetrics.metrics.fiveHour'],
  ['seven_day', 'dashboard.upstreamMetrics.metrics.sevenDay'],
  ['seven_day_sonnet', 'dashboard.upstreamMetrics.metrics.sevenDaySonnet'],
  ['seven_day_opus', 'dashboard.upstreamMetrics.metrics.sevenDayOpus'],
  ['overage', 'dashboard.upstreamMetrics.metrics.overage'],
  ['extra_usage', 'dashboard.upstreamMetrics.metrics.extraUsage'],
  ['premium_interactions', 'dashboard.upstreamMetrics.metrics.premiumInteractions'],
  ['chat', 'dashboard.upstreamMetrics.metrics.chat'],
  ['completions', 'dashboard.upstreamMetrics.metrics.completions'],
  ['session', 'dashboard.upstreamMetrics.metrics.session'],
  ['weekly', 'dashboard.upstreamMetrics.metrics.sevenDay'],
  ['last_4_weeks', 'dashboard.upstreamMetrics.metrics.pastMonth'],
  ['cost_last_4_weeks', 'dashboard.upstreamMetrics.metrics.pastMonthCost'],
  ['cost_24h', 'dashboard.upstreamMetrics.metrics.past24HoursCost'],
  ['cost_7d', 'dashboard.upstreamMetrics.metrics.past7DaysCost'],
  ['cost_30d', 'dashboard.upstreamMetrics.metrics.past30DaysCost'],
  ['included', 'dashboard.upstreamMetrics.metrics.includedBalance'],
  ['purchased', 'dashboard.upstreamMetrics.metrics.purchasedBalance'],
  ['credits_balance', 'dashboard.upstreamMetrics.metrics.credits'],
]);

export const resolveUsageMetricDisplayName = (
  upstreamId: string,
  key: string,
  upstreams: ReadonlyMap<string, UpstreamUsageMetadata>,
  t: Translate,
): UsageMetricDisplay => {
  const upstream = upstreams.get(upstreamId)!;
  let display: UsageMetricDisplay;
  switch (upstream.kind) {
  case 'codex': display = codexDisplay(key); break;
  case 'copilot': display = copilotDisplay(key); break;
  case 'claude-code': display = claudeCodeDisplay(key); break;
  case 'ollama': display = ollamaDisplay(key); break;
  default: throw new TypeError('Provider does not expose upstream usage metrics');
  }
  const translation = names.get(display.name);
  const name = translation === undefined ? display.name : t(translation);
  if (display.windowMinutes === null) return { ...display, name };
  const minutes = display.windowMinutes;
  const window = minutes % 1440 === 0 ? t('dashboard.upstreamMetrics.windows.days', { count: minutes / 1440 })
    : minutes % 60 === 0 ? t('dashboard.upstreamMetrics.windows.hours', { count: minutes / 60 })
      : t('dashboard.upstreamMetrics.windows.minutes', { count: minutes });
  return {
    ...display,
    name: name === '' ? window : t('dashboard.upstreamMetrics.metrics.window', { name, window }),
  };
};
