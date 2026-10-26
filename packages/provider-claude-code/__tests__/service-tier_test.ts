import { expect, test } from 'vitest';

import { defaultClaudeCodeServiceTierPolicy } from '../src/service-tier.ts';

test.each(['pro', 'max', 'team', 'enterprise'])('suggests speed fast without enabling it for %s', plan => {
  expect(defaultClaudeCodeServiceTierPolicy(plan)).toEqual({ enabled: false, tiers: ['fast'] });
});

test.each([undefined, null, '', 'free', 'unknown', 'default_claude_max_5x', 'default_claude_max_20x'])('does not infer access from %s', plan => {
  expect(defaultClaudeCodeServiceTierPolicy(plan)).toEqual({ enabled: false, tiers: [] });
});

test('returns isolated policy objects and lists', () => {
  const policy = defaultClaudeCodeServiceTierPolicy('max');
  policy.enabled = true;
  policy.tiers.push('priority');
  expect(defaultClaudeCodeServiceTierPolicy('max')).toEqual({ enabled: false, tiers: ['fast'] });
});
