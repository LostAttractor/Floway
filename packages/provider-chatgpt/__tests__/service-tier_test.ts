import { expect, test } from 'vitest';

import { chatgptImageProviderModel, chatgptRawToProviderModel } from '../src/models.ts';
import { chatgptModelServiceTierPolicy } from '../src/service-tier.ts';

const model = chatgptRawToProviderModel({ id: 'm', display_name: 'M', context_window: 100 }, new Set());
const policy = (codex: unknown) => chatgptModelServiceTierPolicy({ ...model, providerData: { contextWindow: 100, codex } });

test('inherits open tier IDs from the model, independent of a price or plan table', () => {
  const ids = ['priority', 'ultrafast', 'future-tier'];
  expect(policy({ service_tiers: ids.map(id => ({ id, name: id, description: '' })) })).toEqual({ enabled: true, tiers: ids });
});

test('uses legacy Fast only in the absence of an explicit tier list', () => {
  expect(policy({ additional_speed_tiers: ['fast'] })).toEqual({ enabled: true, tiers: ['priority'] });
  expect(policy({ service_tiers: [], additional_speed_tiers: ['fast'] })).toBeNull();
  expect(policy(undefined)).toBeNull();
  expect(chatgptModelServiceTierPolicy(chatgptImageProviderModel(new Set()))).toBeNull();
});
