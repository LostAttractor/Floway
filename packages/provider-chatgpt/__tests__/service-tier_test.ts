import { expect, test } from 'vitest';

import { chatgptImageProviderModel, chatgptRawToProviderModel } from '../src/models.ts';
import { chatgptModelServiceTiers } from '../src/service-tier.ts';

const model = chatgptRawToProviderModel({ id: 'm', display_name: 'M', context_window: 100 }, new Set());
const tiers = (codex: unknown) => chatgptModelServiceTiers({ ...model, providerData: { contextWindow: 100, codex } }).map(tier => tier.id);

test('advertises open tier IDs from the model, independent of a price or plan table', () => {
  const ids = ['priority', 'ultrafast', 'future-tier'];
  expect(tiers({ service_tiers: ids.map(id => ({ id, name: id, description: '' })) })).toEqual(ids);
});

test('uses legacy Fast only in the absence of an explicit tier list', () => {
  expect(tiers({ additional_speed_tiers: ['fast'] })).toEqual(['priority']);
  expect(tiers({ service_tiers: [], additional_speed_tiers: ['fast'] })).toEqual([]);
  expect(tiers(undefined)).toEqual([]);
  expect(chatgptModelServiceTiers(chatgptImageProviderModel(new Set()))).toEqual([]);
});
