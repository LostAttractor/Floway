import { expect, test } from 'vitest';

import { chatgptPlanObservation, latestPlanObservation, resolveChatGPTPlanType } from '../src/plan.ts';

const older = '2026-10-27T00:00:00.000Z';
const newer = '2026-10-27T01:00:00.000Z';

test('uses the latest token or quota plan instead of the imported identity', () => {
  const token = { planType: 'free', planObservedAt: older, refreshedAt: newer };
  expect(resolveChatGPTPlanType('pro', token, [])).toBe('free');
  expect(resolveChatGPTPlanType('pro', token, [{ observed_at: newer, plan_type: 'plus' }])).toBe('plus');
  expect(resolveChatGPTPlanType('pro', token, [{ observed_at: newer, plan_type: 'unknown-plan' }])).toBe('unknown-plan');
});

test('quota refresh and token refresh do not renew an older plan observation', () => {
  const token = { planType: 'free', planObservedAt: newer, refreshedAt: newer };
  expect(resolveChatGPTPlanType('pro', token, [{ observed_at: '2026-10-27T02:00:00Z', plan_type: 'pro', plan_observed_at: older }])).toBe('free');
  expect(chatgptPlanObservation({ planType: 'pro', refreshedAt: older })).toEqual({ planType: 'pro', observedAt: older });
});

test('keeps timestamp-less observations and falls back only when no observation exists', () => {
  expect(resolveChatGPTPlanType('pro', null, [])).toBe('pro');
  expect(resolveChatGPTPlanType(null, null, [])).toBeNull();
  expect(latestPlanObservation({ planType: 'free' }, { planType: 'pro' })).toEqual({ planType: 'free' });
  expect(latestPlanObservation({ planType: 'pro', observedAt: 'invalid' }, { planType: 'free', observedAt: older })?.planType).toBe('free');
});
