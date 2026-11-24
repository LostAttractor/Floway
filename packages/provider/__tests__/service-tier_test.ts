import { expect, test } from 'vitest';

import { isServiceTierAllowed, normalizeServiceTierPolicy } from '../src/service-tier.ts';

const policy = { enabled: true, tiers: ['priority', 'default', 'vendor/Tier'] };

test('Floway service tier policies default to passthrough and retain operator strings verbatim', () => {
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

test.each([undefined, null, '', 'priority', 'vendor/Tier', 'vendor/tier', 7])('Floway checks explicit policies and leaves passthrough unrestricted: %s', value => {
  expect(isServiceTierAllowed(null, value)).toBe(true);
  expect(isServiceTierAllowed(policy, value)).toBe(value == null || (typeof value === 'string' && policy.tiers.includes(value)));
  expect(isServiceTierAllowed({ ...policy, enabled: false }, value)).toBe(value == null);
});
