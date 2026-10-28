import { expect, test } from 'vitest';

import { defaultCodexServiceTierPolicy } from '../src/service-tier.ts';

test.each([
  'plus', 'pro', 'prolite', 'promax', 'team', 'self_serve_business_prolite', 'self_serve_business_usage_based',
  'business', 'ent26', 'enterprise', 'hc', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based',
  'edu', 'education', 'edu_plus', 'edu_pro', 'PRO',
])('suggests priority without enabling it for %s', plan => {
  expect(defaultCodexServiceTierPolicy(plan)).toEqual({ enabled: false, tiers: ['priority'] });
});

test.each([undefined, null, '', 'free', 'go', 'pro_future', 'sci', 'sci_plus'])('keeps unconfirmed plan %s disabled and empty', plan => {
  expect(defaultCodexServiceTierPolicy(plan)).toEqual({ enabled: false, tiers: [] });
});

test('returns isolated policy objects and lists', () => {
  const policy = defaultCodexServiceTierPolicy('pro');
  policy.enabled = true;
  policy.tiers.push('custom');
  expect(defaultCodexServiceTierPolicy('pro')).toEqual({ enabled: false, tiers: ['priority'] });
});
