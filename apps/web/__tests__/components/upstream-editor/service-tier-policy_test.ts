import { expect, test } from 'vitest';

import { createBody, defaultServiceTierPolicyForRecord, hasUnsavedDiscoveryInputs, mergeProviderRecordPatch, previewRecord, updateBody, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { upstreamRecord } from '../../api/upstream-fixture';

test('Codex default display follows matching token and quota observations without changing configuration', () => {
  const record = upstreamRecord('up_tier', {
    kind: 'codex',
    config: { accounts: [{ email: null, chatgptAccountId: 'account', chatgptUserId: null, planType: 'pro' }] },
    state: {
      accounts: [{
        chatgptAccountId: 'other-account', state: 'active', state_updated_at: '2026-10-27T00:00:00Z',
        accessToken: { expiresAt: null, refreshedAt: '2026-10-27T01:00:00Z', planType: 'free' },
      }],
    },
  });
  if (record.kind !== 'codex') throw new Error('Expected Codex fixture');
  expect(defaultServiceTierPolicyForRecord(record)).toEqual({ enabled: false, tiers: ['priority'] });
  record.state.accounts[0].chatgptAccountId = 'account';
  expect(defaultServiceTierPolicyForRecord(record)).toEqual({ enabled: false, tiers: [] });
  record.codex_quota = { codex: { observed_at: '2026-10-27T02:00:00Z', plan_type: 'plus' } };
  expect(defaultServiceTierPolicyForRecord(record)).toEqual({ enabled: false, tiers: ['priority'] });
  record.codex_quota.codex.plan_type = 'future-plan';
  expect(defaultServiceTierPolicyForRecord(record)).toEqual({ enabled: false, tiers: [] });
  expect(record.config.accounts[0].planType).toBe('pro');
  expect(record.service_tier_policy).toBeNull();
});

test('out-of-order state patches do not regress the observed plan or carry quota into a replacement account', () => {
  const record = upstreamRecord('up_tier', {
    kind: 'codex', config: { accounts: [{ email: null, chatgptAccountId: 'account', chatgptUserId: null, planType: 'pro' }] },
    state: { accounts: [{ chatgptAccountId: 'account', state: 'active', state_updated_at: '', accessToken: { expiresAt: null, refreshedAt: '2026-10-27T02:00:00Z', planType: 'free' } }] },
  });
  if (record.kind !== 'codex') throw new Error('Expected Codex fixture');
  const before = structuredClone(record);
  const delayed = mergeProviderRecordPatch(record, { state: { accounts: [{ ...record.state.accounts[0], accessToken: { expiresAt: null, refreshedAt: '2026-10-27T01:00:00Z', planType: 'pro' } }] } });
  expect(defaultServiceTierPolicyForRecord(delayed)).toEqual({ enabled: false, tiers: [] });
  expect(record).toEqual(before);
  record.codex_quota = { codex: { observed_at: '2026-10-27T03:00:00Z', plan_type: 'pro' } };
  const replaced = mergeProviderRecordPatch(record, {
    config: { accounts: [{ ...record.config.accounts[0], chatgptAccountId: 'replacement', planType: 'free' }] },
    state: { accounts: [] },
  });
  expect(defaultServiceTierPolicyForRecord(replaced)).toEqual({ enabled: false, tiers: [] });
  expect(replaced.service_tier_policy).toBeNull();
});

test('Claude default display follows the current profile without materializing its policy', () => {
  const record = upstreamRecord('up_tier', {
    kind: 'claude-code',
    config: { accounts: [{ email: null, accountUuid: 'account', organizationUuid: null, subscriptionType: 'max', rateLimitTier: null }] },
    state: { accounts: [] },
  });
  if (record.kind !== 'claude-code') throw new Error('Expected Claude fixture');
  expect(defaultServiceTierPolicyForRecord(record)).toEqual({ enabled: false, tiers: ['fast'] });
  record.config.accounts[0].subscriptionType = null;
  expect(defaultServiceTierPolicyForRecord(record)).toEqual({ enabled: false, tiers: [] });
  expect(record.service_tier_policy).toBeNull();
});

test.each([null, { enabled: false, tiers: ['priority'] }, { enabled: true, tiers: ['priority', 'vendor/Tier'] }])('Floway editor preserves tier policy across drafts and full writes: %j', service_tier_policy => {
  const record = upstreamRecord('up_tier', {
    kind: 'custom', state: null, service_tier_policy,
    config: { baseUrl: 'https://tier.invalid', authStyle: 'none', endpoints: { openaiResponses: {} }, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] },
  });
  const values = valuesFromRecord(record);
  expect(values.serviceTierPolicy).toEqual(service_tier_policy);
  expect(createBody(record, values).service_tier_policy).toEqual(service_tier_policy);
  expect(updateBody(record, values, 'full').service_tier_policy).toEqual(service_tier_policy);
  expect(previewRecord(record, values).service_tier_policy).toEqual(service_tier_policy);
  expect(updateBody(record, values, 'models')).not.toHaveProperty('service_tier_policy');
  expect(hasUnsavedDiscoveryInputs({ serviceTierPolicy: true })).toBe(false);
  if (values.serviceTierPolicy) {
    values.serviceTierPolicy.tiers.push('other');
    expect(record.service_tier_policy?.tiers).not.toContain('other');
  }
});
