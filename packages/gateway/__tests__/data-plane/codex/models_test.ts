import { describe, expect, test } from 'vitest';

import { assembleCodexCatalog } from '../../../src/data-plane/codex/models.ts';
import type { AddressableIdEntry } from '../../../src/data-plane/shared/listing/addressable.ts';
import { buildChatGPTUpstreamRecord } from '../../test-utils/app.ts';
import type { InternalModel } from '@floway-dev/provider';
import { chatgptProviderModule } from '@floway-dev/provider-chatgpt';
import { stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';

const bundled = {
  models: [
    // The client catalog supplies display metadata for declared tier IDs.
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

const served = (model: ReturnType<typeof chat>, tiers: string[] = []): AddressableIdEntry => {
  const provider = { ...stubModelCandidate().provider, serviceTierPolicy: tiers.length > 0 ? { enabled: true, tiers } : null };
  return { ...entry({ ...model, providerModels: { [provider.upstreamId]: stubProviderModel({ endpoints: model.endpoints }) } }), upstreams: [provider] };
};

const entries = (...models: ReturnType<typeof chat>[]): AddressableIdEntry[] => models.map(model => served(model));

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
    const subscription = chatgptProviderModule.create(buildChatGPTUpstreamRecord());
    const model = {
      ...chat('shared'),
      providerModels: {
        [native.upstreamId]: stubProviderModel({ endpoints: { openaiResponses: {} } }),
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
    const undeclared = { ...native, serviceTierPolicy: null };
    expect(assembleCodexCatalog(bundled, [{ ...entry(model), upstreams: [subscription, undeclared] }]).models[0].service_tiers).toEqual([]);
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

  test('uses bundled metadata to label an administrator-declared tier without a price', () => {
    const out = assembleCodexCatalog(bundled, [served(chat('openrouter/gpt-5.5:nitro'), ['priority'])]);
    expect(out.models[0].service_tiers).toEqual([{ id: 'priority', name: 'Fast', description: '1.5x speed' }]);
  });

  test('only advertises declared tiers available on every fallback, including legacy Fast', () => {
    const provider = stubModelCandidate().provider;
    const both = { ...provider, serviceTierPolicy: { enabled: true, tiers: ['priority', 'ultrafast'] } };
    const fast = { ...provider, upstreamId: 'secondary', serviceTierPolicy: { enabled: true, tiers: ['priority'] } };
    const catalog = { models: [{ slug: 'gpt', additional_speed_tiers: ['fast'] }] };
    const model = { ...chat('gpt'), providerModels: { [both.upstreamId]: stubProviderModel(), [fast.upstreamId]: stubProviderModel() } };
    const listed = (upstreams: AddressableIdEntry['upstreams']) => assembleCodexCatalog(catalog, [{ ...entry(model), upstreams }]).models[0];
    expect(listed([both]).service_tiers?.map(tier => tier.id)).toEqual(['priority', 'ultrafast']);
    expect(listed([both, fast])).toMatchObject({ service_tiers: [{ id: 'priority' }], additional_speed_tiers: ['fast'] });
    expect(listed([both, { ...fast, serviceTierPolicy: null }])).toMatchObject({ service_tiers: [], additional_speed_tiers: [] });
  });

  test('unmatched model reuses service-tier metadata from another catalog model', () => {
    const out = assembleCodexCatalog(bundled, [served(chat('custom-model'), ['priority'])]);
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
      ...chat('gpt'), providerModels: {
        [primary.upstreamId]: stubProviderModel({ endpoints: { openaiResponses: {} } }),
        [secondary.upstreamId]: stubProviderModel({ endpoints }),
      },
    };
    const catalog = { models: [{ slug: 'gpt', additional_speed_tiers: ['fast'] }] };
    const row = assembleCodexCatalog(catalog, [{ ...entry(model), upstreams: [primary, secondary] }]).models[0];
    expect(row.service_tiers?.map(t => t.id)).toEqual(expected ? ['priority'] : []);
    expect(row.additional_speed_tiers).toEqual(expected ? ['fast'] : []);
  });

  test('pricing and bundled tiers do not declare a tier', () => {
    const model = {
      ...chat('gpt-5.5'),
      pricing: { entries: [{ selector: { serviceTier: 'priority' }, rates: { input_tokens: '1' } }] },
    };
    const out = assembleCodexCatalog(bundled, entries(model));
    expect(out.models[0]).toMatchObject({ service_tiers: [], additional_speed_tiers: [] });
  });

  test('aliases intersect reachable target tiers with each target’s fixed tier', () => {
    const addressable = [
      served(chat('sol'), ['priority', 'ultrafast']),
      served(chat('astra'), ['priority']),
    ];
    const alias: Extract<InternalModel, { aliasedFrom: unknown }> = {
      id: 'review',
      kind: 'chat',
      limits: {},
      endpoints: { openaiChatCompletions: {} },
      aliasedFrom: {
        selection: 'first-available',
        targets: [{ target_model_id: 'sol', rules: {} }, { target_model_id: 'astra', rules: {} }],
      },
    };
    const listed = (targets = alias.aliasedFrom.targets) => assembleCodexCatalog(bundled, addressable, {}, [{ model: alias, aliasTargets: targets }]).models[0];
    const row = listed();
    expect(row).toMatchObject({ slug: 'review', service_tiers: [{ id: 'priority' }], additional_speed_tiers: ['fast'] });
    expect(listed([{ target_model_id: 'sol', rules: {} }, { target_model_id: 'astra', rules: { serviceTier: 'fast' } }]))
      .toMatchObject({ service_tiers: [{ id: 'priority' }], additional_speed_tiers: ['fast'] });
    expect(listed([{ target_model_id: 'sol', rules: { serviceTier: 'ultrafast' } }, { target_model_id: 'astra', rules: {} }]))
      .toMatchObject({ service_tiers: [], additional_speed_tiers: [] });
  });
});
