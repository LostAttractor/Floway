import type { ServiceTierPolicy } from '@floway-dev/provider';

// Fast is offered on paid plans; these are suggestions, not account/model entitlements.
// https://learn.chatgpt.com/docs/pricing
// https://github.com/openai/codex/blob/812d9a3e9a84ec83e9f6ddd01ffefb177463f26d/codex-rs/protocol/src/auth.rs#L73-L157
const FAST_PLAN_TYPES = new Set([
  'plus', 'pro', 'prolite', 'promax', 'team',
  'self_serve_business_prolite', 'self_serve_business_usage_based',
  'business', 'ent26', 'enterprise', 'hc',
  'enterprise_cbp_automation', 'enterprise_cbp_usage_based',
  'edu', 'education', 'edu_plus', 'edu_pro',
]);

// Codex's Fast setting uses priority on the wire.
// https://github.com/openai/codex/blob/812d9a3e9a84ec83e9f6ddd01ffefb177463f26d/codex-rs/protocol/src/config_types.rs#L539-L552
export const defaultCodexServiceTierPolicy = (planType: string | null | undefined): ServiceTierPolicy => ({
  enabled: false,
  tiers: planType !== null && planType !== undefined && FAST_PLAN_TYPES.has(planType.toLowerCase()) ? ['priority'] : [],
});
