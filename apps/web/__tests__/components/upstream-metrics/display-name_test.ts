import { afterEach, expect, it } from 'vitest';

import type { UpstreamUsageMetadata } from '../../../src/components/upstream-metrics/data';
import { resolveUsageMetricDisplayName } from '../../../src/components/upstream-metrics/display-name';
import { i18n, setLanguage } from '../../../src/i18n';
import type { TFunction } from '../../../src/i18n/translation';

const t = i18n.t.bind(i18n) as unknown as TFunction;
const upstream = (kind: UpstreamUsageMetadata['kind'], id = 'up-1'): UpstreamUsageMetadata => ({ id, kind, name: 'Seat', hue: 210 });
afterEach(() => setLanguage('en'));

it('renders arbitrary metric names independently of JavaScript object prototypes', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'future_metric']) {
    for (const [metricKey, kind] of [[JSON.stringify(['quota', key]), 'copilot'], [JSON.stringify(['window', key]), 'ollama']] as const) {
      expect(resolveUsageMetricDisplayName(upstream(kind), metricKey, t)).toMatchObject({ name: key, unit: 'percent', windowMinutes: null });
    }
  }
});

it('selects each provider decoder from the current upstream', () => {
  expect(resolveUsageMetricDisplayName(upstream('codex'), '["balance","credits"]', t).unit).toBe('credits');
  expect(resolveUsageMetricDisplayName(upstream('copilot'), '["quota","premium_interactions"]', t).unit).toBe('percent');
});

it('renders whole days and hours without a redundant default Codex limit name', async () => {
  for (const [language, labels] of [
    ['en', ['7-day window', '5-hour window', '90-minute window']],
    ['zh-Hans', ['7 天窗口', '5 小时窗口', '90 分钟窗口']],
  ] as const) {
    await setLanguage(language);
    const translate = i18n.getFixedT(language) as unknown as TFunction;
    for (const [index, minutes] of [10080, 300, 90].entries()) {
      for (const name of ['', 'codex', 'review']) {
        const key = JSON.stringify(['window', name, minutes]);
        expect(resolveUsageMetricDisplayName(upstream('codex'), key, translate).name).toBe(name === 'review' ? `review ${labels[index]}` : labels[index]);
      }
    }
  }
});

it('localizes period names and gives costs their own metric name', async () => {
  const percentKey = JSON.stringify(['window', 'last_4_weeks']);
  const usdKey = JSON.stringify(['activity_cost', 'last_4_weeks']);
  const english = resolveUsageMetricDisplayName(upstream('ollama'), percentKey, t);
  expect(english.name).toBe('Past month');
  expect(resolveUsageMetricDisplayName(upstream('ollama'), usdKey, t).name).toBe('Past month cost');
  await setLanguage('zh-Hans');
  const chinese = resolveUsageMetricDisplayName(upstream('ollama'), percentKey, t);
  expect(chinese.name).toBe('最近一个月');
});

it('renders equal fixed and encoded windows with consistent labels', async () => {
  for (const language of ['en', 'zh-Hans'] as const) {
    await setLanguage(language);
    for (const [fixedKey, minutes] of [['five_hour', 300], ['seven_day', 10080]] as const) {
      const encodedKey = JSON.stringify(['window', 'codex', minutes]);
      const fixed = resolveUsageMetricDisplayName(upstream('claude-code'), JSON.stringify(['quota', fixedKey]), t);
      const encoded = resolveUsageMetricDisplayName(upstream('codex'), encodedKey, t);
      expect(fixed.name).toBe(encoded.name);
    }
  }
});

it('names Ollama activity costs for the documented response range independently of billing mode', async () => {
  for (const [language, labels] of [
    ['en', ['Past 24 hours cost', 'Past 7 days cost', 'Past 30 days cost']],
    ['zh-Hans', ['最近 24 小时费用', '最近 7 天费用', '最近 30 天费用']],
  ] as const) {
    await setLanguage(language);
    for (const [index, range] of ['24h', '7d', '30d'].entries()) {
      const display = resolveUsageMetricDisplayName(upstream('ollama'), JSON.stringify(['activity_cost', range]), t);
      expect(display.name).toBe(labels[index]);
      expect(display.unit).toBe('usd');
    }
  }
});
