import { assertCodexUpstreamRecord } from './config.ts';
import { CODEX_DEFAULT_FLAGS } from './defaults.ts';
import { createCodexProvider } from './provider.ts';
import { defaultCodexServiceTierPolicy } from './service-tier.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const codexProviderModule: ProviderModule = {
  create: createCodexProvider,
  defaultFlags: CODEX_DEFAULT_FLAGS,
  defaultServiceTierPolicy: record => {
    assertCodexUpstreamRecord(record);
    return defaultCodexServiceTierPolicy(record.config.accounts[0].planType);
  },
};

export { defaultCodexServiceTierPolicy } from './service-tier.ts';

export * from './access-token.ts';
export * from './auth/credential.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './constants.ts';
export * from './config.ts';
export * from './state.ts';
export * from './quota.ts';
export * from './rate-limit-resets.ts';
export { fetchCodexUsage } from './usage-probe.ts';
export { pricingForCodexModelKey } from './pricing.ts';
export { codexModelContextWindow, type CodexContextWindow } from './models.ts';
