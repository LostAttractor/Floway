// Codex-internal `/models` shape assembled for the shared catalog handler.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Pipeline: codex publishes a versioned catalog per release (see catalog.ts);
// for each chat-kind model the registry lists as addressable, we call
// `synthesizeCatalogEntry(model, base?)` with the segment-matched client
// catalog entry as `base` (or `undefined` when no catalog entry matches). The
// synthesizer builds the codex-shaped entry from that base, the registry-owned
// overlays it announces, and capabilities proven by the exact client catalog
// (see synthesize.ts for the exact field precedence rules).

import { resolveCodexCatalog, type CatalogModel, type CodexCatalog, type CodexCatalogCapabilities, type CodexServiceTier } from './catalog.ts';
import { synthesizeCatalogEntry } from './synthesize.ts';
import type { ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { User } from '../../repo/types.ts';
import { loadListedModels, type ListedModel } from '../models/load.ts';
import { listedServiceTiers } from '../models/service-tiers.ts';
import { listedRealModels, type AddressableIdEntry } from '../shared/listing/addressable.ts';
import { chatgptCodexModelMetadata } from '@floway-dev/provider-chatgpt';

// Pure transformation: client catalog + addressable entries →
// codex-shaped catalog (drops unlisted alternates and non-chat kinds).
// Extracted so tests can drive the mapping logic without standing up the
// addressable-enumeration pipeline.
export const assembleCodexCatalog = (
  catalog: CodexCatalog,
  addressable: readonly AddressableIdEntry[],
  capabilities: CodexCatalogCapabilities = {},
  listedModels: readonly ListedModel[] = listedRealModels(addressable).map(model => ({ model })),
): CodexCatalog => {
  const catalogBySlug = new Map<string, CatalogModel>();
  for (const model of catalog.models) catalogBySlug.set(model.slug.toLowerCase(), model);
  const catalogServiceTiers: CodexServiceTier[] = catalog.models.flatMap(model => model.service_tiers ?? []);
  const addressableById = new Map(addressable.map(entry => [entry.id, entry]));

  // Match against the client catalog by walking segments from the trailing leaf back
  // toward the prefix, so a publicId like `openrouter/gpt-5.5/gpt-5.4`
  // binds against `gpt-5.4` rather than the earlier `gpt-5.5` segment that
  // happens to collide with a catalog slug. Split on both `/` (model-prefix
  // segments) and `:` (OpenRouter-style `:variant` suffixes) — a variant
  // tag on the leaf falls through the walk without accidentally binding.
  const matchCatalog = (publicId: string): CatalogModel | undefined => {
    const segments = publicId.toLowerCase().split(/[/:]/);
    for (let i = segments.length - 1; i >= 0; i--) {
      const hit = catalogBySlug.get(segments[i]);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const models: CatalogModel[] = [];
  for (const { model, aliasTargets } of listedModels) {
    if (model.kind !== 'chat') continue;
    const primary = model.aliasedFrom === undefined ? addressableById.get(model.id)?.upstreams[0] : undefined;
    let metadata;
    if (primary?.kind === 'chatgpt') {
      const providerModel = model.providerModels?.[primary.upstreamId];
      if (providerModel === undefined) throw new Error(`Codex catalog model ${model.id} has no provider model for ${primary.upstreamId}`);
      metadata = chatgptCodexModelMetadata(providerModel);
    }
    const serviceTiers = listedServiceTiers(model, addressableById, aliasTargets);
    const entry = synthesizeCatalogEntry(model, matchCatalog(model.id), capabilities, catalogServiceTiers, { metadata, serviceTiers });
    if (entry.input_modalities?.length === 0) continue;
    models.push(entry);
  }
  return { models };
};

export const loadCodexCatalog = async (
  subject: User,
  userAgent: string | undefined,
  upstreamIds: readonly string[] | null,
  scheduleRefresh: ModelsRefreshScheduler,
  clientVersion?: string,
): Promise<CodexCatalog> => {
  const [resolution, { addressable, models }] = await Promise.all([
    resolveCodexCatalog(userAgent, clientVersion),
    loadListedModels(subject, upstreamIds, scheduleRefresh, getRepo().modelAliases),
  ]);
  return assembleCodexCatalog(resolution.catalog, addressable, resolution.capabilities, models);
};
