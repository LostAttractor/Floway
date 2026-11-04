import { isFastServiceTier } from '../common/aliases.ts';

// Fast Mode uses speed independently of the scheduling service_tier.
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
export const anthropicMessagesTierFields = (tier: string) =>
  isFastServiceTier(tier) ? { speed: 'fast' as const } : { service_tier: tier };

export const anthropicMessagesServiceTier = (fields: {
  readonly speed?: string | null;
  readonly service_tier?: string | null;
}): string | null | undefined => fields.speed !== undefined ? fields.speed : fields.service_tier;
