import type { ServiceTierPolicy } from '@floway-dev/provider';

// Fast uses speed, not service_tier; paid plans still need usage credits and org/model access.
// https://code.claude.com/docs/en/fast-mode#requirements
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
const FAST_SUBSCRIPTION_TYPES = new Set(['pro', 'max', 'team', 'enterprise']);

export const defaultClaudeCodeServiceTierPolicy = (subscriptionType: string | null | undefined): ServiceTierPolicy => ({
  enabled: false,
  tiers: subscriptionType !== null && subscriptionType !== undefined && FAST_SUBSCRIPTION_TYPES.has(subscriptionType) ? ['fast'] : [],
});
