import { openaiResponsesTarget } from '../chat/shared/target-picker.ts';
import type { AddressableIdEntry } from '../shared/listing/addressable.ts';
import { matchesAliasServiceTier } from '../shared/service-tier-policy.ts';
import { anthropicMessagesTierFields } from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER, type AliasTarget } from '@floway-dev/protocols/common';
import { isServiceTierAllowed, type ChatTargetApi, type InternalModel, type ModelServiceTier } from '@floway-dev/provider';

const wireTier = (id: string, target: ChatTargetApi): string => {
  if (target !== 'anthropicMessages') return id;
  const fields = anthropicMessagesTierFields(id);
  return fields.service_tier ?? fields.speed;
};

export const listedServiceTiers = (
  model: InternalModel,
  addressableById: ReadonlyMap<string, AddressableIdEntry>,
  aliasTargets: readonly AliasTarget[] | undefined,
): ModelServiceTier[] => {
  const targets = aliasTargets?.map(target => ({
    id: target.target_model_id,
    fixed: target.rules.serviceTier,
  })) ?? [{ id: model.id, fixed: undefined }];
  const routes = targets.flatMap(({ id, fixed }) => {
    const entry = addressableById.get(id);
    if (entry === undefined) return [];
    return entry.upstreams.flatMap(upstream => {
      const providerModel = entry.model.providerModels?.[upstream.upstreamId];
      if (providerModel === undefined) throw new Error(`Catalog model ${id} has no provider model for ${upstream.upstreamId}`);
      if (providerModel.kind !== model.kind) return [];
      const target = openaiResponsesTarget.find(providerModel.endpoints);
      if (target === null) return [];

      const policy = upstream.serviceTierPolicy;
      const declared = upstream.modelServiceTiers?.(providerModel, target);
      const tiers: readonly ModelServiceTier[] = declared ?? (policy?.enabled ? policy.tiers.map(id => ({ id })) : []);
      const allowed = tiers.filter(({ id }) => isServiceTierAllowed(policy, id));
      return [{ target, fixed, tiers: new Map(allowed.map(tier => [tier.id, tier])) }];
    });
  });
  const ids = new Set(routes.flatMap(({ target, tiers }) => Array.from(tiers.keys(), id =>
    target === 'anthropicMessages' && id === 'fast' ? FAST_SERVICE_TIER : id)));
  return [...ids].flatMap(id => {
    const shared = routes.map(({ target, fixed, tiers }) =>
      fixed === undefined || matchesAliasServiceTier(id, fixed) ? tiers.get(wireTier(id, target)) : undefined);
    if (shared.some(tier => tier === undefined)) return [];
    return [{ ...shared.find(tier => tier?.name !== undefined), id }];
  });
};
