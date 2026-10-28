import { expect, test } from 'vitest';

import { applyServiceTierPolicy, normalizeServiceTierPolicy } from '../src/service-tier.ts';

const policy = { enabled: true, tiers: ['priority', 'default', 'vendor/Tier'] };

test('Floway service tier policies default off and retain operator strings verbatim', () => {
  expect(normalizeServiceTierPolicy(undefined)).toBeNull();
  expect(normalizeServiceTierPolicy(null)).toBeNull();
  expect(normalizeServiceTierPolicy(policy)).toEqual(policy);
  expect(normalizeServiceTierPolicy({ enabled: false, tiers: ['priority'] })).toEqual({ enabled: false, tiers: ['priority'] });
  expect(normalizeServiceTierPolicy({ enabled: false, tiers: [] })).toEqual({ enabled: false, tiers: [] });
});

test.each([
  false, [], {}, { enabled: 1, tiers: [] }, { enabled: true, tiers: [] },
  { enabled: false, tiers: [''] }, { enabled: false, tiers: [' '] },
  { enabled: true, tiers: [1] }, { enabled: true, tiers: ['priority', 'priority'] },
])('Floway rejects malformed service tier policy: %j', value => {
  expect(() => normalizeServiceTierPolicy(value)).toThrow();
});

test('Floway filters only native top-level fields without mutating a shared request', () => {
  const body = { speed: 'fast', service_tier: 'priority', messages: [{ service_tier: 'user-content' }] };
  expect(applyServiceTierPolicy(body, ['speed', 'service_tier'], null)).toEqual({ messages: body.messages });
  expect(applyServiceTierPolicy(body, ['speed', 'service_tier'], { ...policy, enabled: false })).toEqual({ messages: body.messages });
  expect(applyServiceTierPolicy(body, ['speed', 'service_tier'], policy)).toEqual({ service_tier: 'priority', messages: body.messages });
  expect(body).toEqual({ speed: 'fast', service_tier: 'priority', messages: [{ service_tier: 'user-content' }] });
});

test.each(['priority', 'default', 'vendor/Tier', 'vendor/tier', '', null, undefined])('Floway matches raw request tier exactly: %s', service_tier => {
  const body = applyServiceTierPolicy({ service_tier }, ['service_tier'], policy);
  if (typeof service_tier === 'string' && policy.tiers.includes(service_tier)) expect(body).toEqual({ service_tier });
  else expect(body).not.toHaveProperty('service_tier');
});
