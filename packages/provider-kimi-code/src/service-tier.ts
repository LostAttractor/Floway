import type { ServiceTierPolicy } from '@floway-dev/provider';

// Preserve the standard and fast lanes advertised by the coding-service catalog.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
export const defaultKimiCodeServiceTierPolicy = (): ServiceTierPolicy => ({
  enabled: true,
  tiers: ['priority', 'fast', 'default', 'standard'],
});
