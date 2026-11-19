import { chatgptCodexModelMetadata } from './models.ts';
import type { ProviderModel, ServiceTierPolicy } from '@floway-dev/provider';

export const chatgptModelServiceTierPolicy = (model: ProviderModel): ServiceTierPolicy | null => {
  if (model.kind !== 'chat') return null;
  const tiers = chatgptCodexModelMetadata(model).service_tiers;
  return tiers?.length ? { enabled: true, tiers: tiers.map(tier => tier.id) } : null;
};
