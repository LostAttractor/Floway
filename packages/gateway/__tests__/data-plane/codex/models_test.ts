import { describe, expect, test } from 'vitest';

import { assembleCodexCatalog } from '../../../src/data-plane/codex/models.ts';
import type { AddressableIdEntry } from '../../../src/data-plane/shared/listing/addressable.ts';
import type { InternalModel } from '@floway-dev/provider';
import { stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';

const bundled = {
  models: [
    // Catalog entries carry user-facing service-tier metadata. Floway exposes
    // only registry-priced ids while preserving these names and descriptions.
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, priority: 1, visibility: 'list', extra: 'keep', service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }] },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, priority: 2, visibility: 'list', service_tiers: [{ id: 'priority', name: 'Accelerated', description: 'Model-specific speed tier' }] },
  ],
};

const chat = (id: string, displayName?: string, ctx = 100000): Extract<InternalModel, { providerModels: unknown }> => ({
  id,
  ...(displayName === undefined ? {} : { display_name: displayName }),
  kind: 'chat',
  limits: { max_context_window_tokens: ctx },
  endpoints: { openaiChatCompletions: {} },
  providerModels: {},
});

const entry = (model: InternalModel, unlisted?: true): AddressableIdEntry => ({
  id: model.id,
  unlisted,
  model,
  upstreams: [],
});

const entries = (...models: ReturnType<typeof chat>[]): AddressableIdEntry[] => models.map(model => {
  const provider = { ...stubModelCandidate().provider, serviceTierPolicy: { enabled: true, tiers: ['priority', 'turbo'] } };
  return { ...entry({ ...model, providerModels: { [provider.upstreamId]: stubProviderModel({ endpoints: model.endpoints }) } }), upstreams: [provider] };
});

describe('assembleCodexCatalog', () => {
  test('uses the primary ChatGPT provider default for a prefixed model without a matching client entry', () => {
    const provider = { ...stubModelCandidate().provider, kind: 'chatgpt' as const };
    const model = {
      ...chat('codex/future-model', 'Future', 600000),
      providerModels: {
        [provider.upstreamId]: stubProviderModel({
          limits: { max_context_window_tokens: 600000 },
          providerData: { contextWindow: 80000, useResponsesLite: false },
        }),
      },
    };
    const out = assembleCodexCatalog(bundled, [{ ...entry(model), upstreams: [provider] }]);
    expect(out.models[0]).toMatchObject({ slug: 'codex/future-model', context_window: 80000, max_context_window: 600000 });
  });

  test('a secondary ChatGPT provider cannot replace the primary provider budget', () => {
    const primary = stubModelCandidate().provider;
    const secondary = { ...primary, upstreamId: 'secondary', kind: 'chatgpt' as const };
    const model = {
      ...chat('gpt-5.5', 'Primary', 200000),
      providerModels: {
        [primary.upstreamId]: stubProviderModel({ limits: { max_context_window_tokens: 200000 } }),
        [secondary.upstreamId]: stubProviderModel({
          limits: { max_context_window_tokens: 872000 },
          providerData: { contextWindow: 272000, useResponsesLite: false },
        }),
      },
    };
    const out = assembleCodexCatalog(bundled, [{ ...entry(model), upstreams: [primary, secondary] }]);
    expect(out.models[0]).toMatchObject({ context_window: 200000, max_context_window: 200000 });
  });

  test.each([
    { codex: {}, expected: [] },
    { codex: { service_tiers: [], additional_speed_tiers: ['fast'] }, expected: [] },
    { codex: { additional_speed_tiers: ['fast'] }, expected: ['priority'] },
    { codex: { service_tiers: [{ id: 'ultrafast', name: 'Ultrafast', description: '' }] }, expected: ['ultrafast'] },
  ])('only lists tiers shared with the ChatGPT catalog $codex, in either routing order', ({ codex, expected }) => {
    const native = { ...stubModelCandidate().provider, kind: 'custom' as const, serviceTierPolicy: { enabled: true, tiers: ['priority', 'ultrafast'] } };
    const subscription = { ...native, kind: 'chatgpt' as const, upstreamId: 'subscription' };
    const pricing = { entries: ['priority', 'ultrafast'].map(serviceTier => ({ selector: { serviceTier }, rates: { input_tokens: '1' } })) };
    const model = {
      ...chat('shared'), pricing,
      providerModels: {
        [native.upstreamId]: stubProviderModel({ pricing, endpoints: { openaiResponses: {} } }),
        [subscription.upstreamId]: stubProviderModel({ providerData: { contextWindow: 100000, codex } }),
      },
    };
    for (const upstreams of [[native, subscription], [subscription, native]]) {
      const [row] = assembleCodexCatalog(bundled, [{ ...entry(model), upstreams }]).models;
      expect(row.service_tiers?.map(tier => tier.id)).toEqual(expected);
      expect(row.additional_speed_tiers).toEqual(expected.some(id => id === 'priority') ? ['fast'] : []);
    }
    const restricted = { ...subscription, serviceTierPolicy: { enabled: false, tiers: [] } };
    expect(assembleCodexCatalog(bundled, [{ ...entry(model), upstreams: [native, restricted] }]).models[0]).toMatchObject({ service_tiers: [], additional_speed_tiers: [] });
    model.providerModels[native.upstreamId] = stubProviderModel({ endpoints: { openaiResponses: {} } });
    expect(assembleCodexCatalog(bundled, [{ ...entry(model), upstreams: [subscription, native] }]).models[0].service_tiers).toEqual([]);
  });

  test('leaf-first segment match: trailing leaf beats colliding earlier segments', () => {
    // `openrouter/gpt-5.5/gpt-5.4` binds against gpt-5.4 — walking segments
    // leaf-first avoids binding against an earlier segment (`gpt-5.5`) that
    // happens to collide with a bundled slug.
    const out = assembleCodexCatalog(bundled, entries(chat('openrouter/gpt-5.5/gpt-5.4')));
    expect(out.models[0].priority).toBe(2);  // gpt-5.4's priority
  });

  test('non-chat models and unlisted addressable entries are dropped', () => {
    // A model reachable only via `modelPrefix.addressable` alternates (not
    // listed on /v1/models) also stays off the codex picker — the operator
    // opted out of the default listing surface on that side too.
    const out = assembleCodexCatalog(bundled, [
      entry({ id: 'text-embedding-3', display_name: 'emb', kind: 'embedding', limits: {}, endpoints: {} } as InternalModel),
      entry(chat('gpt-5.5'), true),
      entry(chat('gpt-5.4')),
    ]);
    expect(out.models.map(m => m.slug)).toEqual(['gpt-5.4']);
  });

  test('bundled reuse: registry pricing.entries selects and preserves bundled service-tier metadata', () => {
    const im: InternalModel = {
      ...chat('openrouter/gpt-5.5:nitro'),
      pricing: { entries: [{ rates: { input_tokens: '1' } }, { selector: { serviceTier: 'priority' }, rates: { input_tokens: '1' } }] },
    };
    const out = assembleCodexCatalog(bundled, entries(im));
    expect(out.models[0].service_tiers).toEqual([{ id: 'priority', name: 'Fast', description: '1.5x speed' }]);
  });

  test('only advertises priced tiers allowed on every fallback, including legacy Fast', () => {
    const provider = stubModelCandidate().provider;
    const both = { ...provider, serviceTierPolicy: { enabled: true, tiers: ['priority', 'ultrafast'] } };
    const fast = { ...provider, upstreamId: 'secondary', serviceTierPolicy: { enabled: true, tiers: ['priority'] } };
    const catalog = { models: [{ slug: 'gpt', additional_speed_tiers: ['fast'] }] };
    const model = { ...chat('gpt'), providerModels: { [both.upstreamId]: stubProviderModel(), [fast.upstreamId]: stubProviderModel() }, pricing: { entries: ['priority', 'ultrafast'].map(serviceTier => ({ selector: { serviceTier }, rates: {} })) } };
    const listed = (upstreams: AddressableIdEntry['upstreams']) => assembleCodexCatalog(catalog, [{ ...entry(model), upstreams }]).models[0];
    expect(listed([both]).service_tiers?.map(tier => tier.id)).toEqual(['priority', 'ultrafast']);
    expect(listed([both, fast])).toMatchObject({ service_tiers: [{ id: 'priority' }], additional_speed_tiers: ['fast'] });
    expect(listed([both, { ...fast, serviceTierPolicy: null }])).toMatchObject({ service_tiers: [], additional_speed_tiers: [] });
  });

  test('unmatched model reuses service-tier metadata from another catalog model', () => {
    const im: InternalModel = {
      ...chat('custom-model'),
      pricing: { entries: [{ rates: { input_tokens: '1' } }, { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } }] },
    };
    const out = assembleCodexCatalog(bundled, entries(im));
    expect(out.models[0].service_tiers).toEqual([{ id: 'priority', name: 'Fast', description: '1.5x speed' }]);
  });

  test.each([
    [{ anthropicMessages: {} }, 'fast', true],
    [{ anthropicMessages: {} }, 'priority', false],
    [{ openaiResponses: {}, anthropicMessages: {} }, 'fast', false],
    [{ openaiResponses: {}, anthropicMessages: {} }, 'priority', true],
  ] as const)('checks the tier carried by the selected fallback wire %j with %s', (endpoints, allowedTier, expected) => {
    const primary = { ...stubModelCandidate().provider, serviceTierPolicy: { enabled: true, tiers: ['priority'] } };
    const secondary = { ...primary, upstreamId: 'backup', serviceTierPolicy: { enabled: true, tiers: [allowedTier] } };
    const model = {
      ...chat('gpt'), pricing: { entries: [{ selector: { serviceTier: 'priority' }, rates: {} }] }, providerModels: {
        [primary.upstreamId]: stubProviderModel({ endpoints: { openaiResponses: {} } }),
        [secondary.upstreamId]: stubProviderModel({ endpoints }),
      },
    };
    const catalog = { models: [{ slug: 'gpt', additional_speed_tiers: ['fast'] }] };
    const row = assembleCodexCatalog(catalog, [{ ...entry(model), upstreams: [primary, secondary] }]).models[0];
    expect(row.service_tiers?.map(t => t.id)).toEqual(expected ? ['priority'] : []);
    expect(row.additional_speed_tiers).toEqual(expected ? ['fast'] : []);
  });

});
