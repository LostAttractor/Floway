// Fast Mode uses speed independently of the scheduling service_tier.
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
export const anthropicMessagesServiceTier = (fields: {
  readonly speed?: string | null;
  readonly service_tier?: string | null;
}): string | null | undefined => fields.speed !== undefined ? fields.speed : fields.service_tier;
