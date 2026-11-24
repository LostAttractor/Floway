import { chatgptCodexModelMetadata } from './models.ts';
import type { ProviderModel } from '@floway-dev/provider';

export const chatgptModelServiceTiers = (model: ProviderModel) =>
  model.kind === 'chat' ? chatgptCodexModelMetadata(model).service_tiers ?? [] : [];
