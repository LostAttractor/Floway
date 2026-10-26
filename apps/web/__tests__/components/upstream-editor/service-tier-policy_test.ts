import { expect, test } from 'vitest';

import { createBody, hasUnsavedDiscoveryInputs, previewRecord, updateBody, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { upstreamRecord } from '../../api/upstream-fixture';

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
