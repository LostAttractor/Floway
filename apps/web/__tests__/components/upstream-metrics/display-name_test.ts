import { afterEach, expect, it } from 'vitest';

import type { UpstreamMetricsMetadata } from '../../../src/components/upstream-metrics/data';
import { resolveUpstreamMetricDisplay } from '../../../src/components/upstream-metrics/display-name';
import { i18n, setLanguage } from '../../../src/i18n';
import type { TFunction } from '../../../src/i18n/translation';
import { normalizeUpstreamMetricIdentity } from '@floway-dev/provider/browser';

const t = i18n.t.bind(i18n) as unknown as TFunction;
const upstream = (kind: UpstreamMetricsMetadata['kind'], id = 'up-1'): UpstreamMetricsMetadata => ({ id, kind, name: 'Seat', hue: 210 });
afterEach(() => setLanguage('en'));

it('renders arbitrary label values independently of JavaScript object prototypes', () => {
  for (const quota of ['constructor', '__proto__', 'toString', 'future_metric']) {
    expect(resolveUpstreamMetricDisplay(upstream('copilot'), { name: 'quota.remaining', labels: { quota } }, t)).toMatchObject({ name: `${quota} balance`, unit: 'count', windowSeconds: null });
  }
});

it('selects each provider decoder from the current upstream', () => {
  expect(resolveUpstreamMetricDisplay(upstream('codex'), { name: 'credits.balance', labels: {} }, t).unit).toBe('credits');
  expect(resolveUpstreamMetricDisplay(upstream('copilot'), { name: 'quota.remaining', labels: { quota: 'premium_interactions' } }, t).unit).toBe('usd');
});

it('renders undecoded identities as unitless raw series', () => {
  for (const [kind, identity, name] of [
    ['copilot', { name: 'quota.overage', labels: { quota: 'chat "beta"', limit: 456, shared: true, scope: null } }, 'quota.overage{limit=456,quota="chat \\"beta\\"",scope=null,shared=true}'],
    ['claude-code', { name: 'quota.utilization', labels: { quota: 'five_hour', region: 'us' } }, 'quota.utilization{quota="five_hour",region="us"}'],
    ['azure', { name: 'tokens.remaining', labels: {} }, 'tokens.remaining'],
  ] as const) {
    const display = resolveUpstreamMetricDisplay(upstream(kind), normalizeUpstreamMetricIdentity(identity.name, identity.labels), t);
    expect(display).toMatchObject({ name, unit: 'none', windowSeconds: null, emptyValue: null, form: 'line' });
    expect(display.toDisplayValue(123.5)).toBe(123.5);
  }
});

it('formats duration labels from seconds', async () => {
  for (const [language, labels] of [
    ['en', ['7-day window', '5-hour window', '90-minute window', '125-second window']],
    ['zh-Hans', ['7 天窗口', '5 小时窗口', '90 分钟窗口', '125 秒窗口']],
  ] as const) {
    await setLanguage(language);
    const translate = i18n.getFixedT(language) as unknown as TFunction;
    for (const [index, seconds] of [604_800, 18_000, 5_400, 125].entries()) {
      for (const limit of ['', 'codex', 'review']) {
        const display = resolveUpstreamMetricDisplay(upstream('codex'), { name: 'quota.window.used_percent', labels: { limit, window_seconds: seconds } }, translate);
        expect(display.name).toBe(limit === 'review' ? `review ${labels[index]}` : labels[index]);
      }
    }
  }
});

it('renders equal fixed and encoded windows with consistent labels', async () => {
  for (const language of ['en', 'zh-Hans'] as const) {
    await setLanguage(language);
    for (const [quota, seconds] of [['five_hour', 18_000], ['seven_day', 604_800]] as const) {
      const fixed = resolveUpstreamMetricDisplay(upstream('claude-code'), { name: 'quota.utilization', labels: { quota } }, t);
      const encoded = resolveUpstreamMetricDisplay(upstream('codex'), { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: seconds } }, t);
      expect(fixed.name).toBe(encoded.name);
    }
  }
});

it('names Ollama activity costs for the response range', async () => {
  for (const [language, labels] of [
    ['en', ['Past 24 hours cost', 'Past 7 days cost', 'Past month cost']],
    ['zh-Hans', ['最近 24 小时费用', '最近 7 天费用', '最近一个月费用']],
  ] as const) {
    await setLanguage(language);
    for (const [index, range] of ['24h', '7d', '30d'].entries()) {
      const display = resolveUpstreamMetricDisplay(upstream('ollama'), { name: 'activity.cost_usd', labels: { range } }, t);
      expect(display.name).toBe(labels[index]);
      expect(display.unit).toBe('usd');
    }
  }
});

it('localizes allowance names without embedding units in metric labels', async () => {
  for (const [language, copilotName, ollamaName] of [
    ['en', 'Allowance', 'Included allowance'],
    ['zh-Hans', '额度', '套餐额度'],
  ] as const) {
    await setLanguage(language);
    expect(resolveUpstreamMetricDisplay(upstream('copilot'), { name: 'quota.entitlement', labels: { quota: 'premium_interactions' } }, t)).toMatchObject({ name: copilotName, unit: 'usd' });
    expect(resolveUpstreamMetricDisplay(upstream('ollama'), { name: 'allowance.usd', labels: { source: 'included' } }, t)).toMatchObject({ name: ollamaName, unit: 'usd' });
  }
});
