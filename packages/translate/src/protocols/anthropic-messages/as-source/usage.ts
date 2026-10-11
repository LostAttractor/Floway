import type { IRUsage } from '../../../ir/types.ts';
import { createAnthropicMessagesUsage } from '@floway-dev/protocols/anthropic-messages';
export const usageFromIR = (usage: IRUsage): Record<string, any> => {
  const input = usage.input_tokens_inclusive ?? 0;
  const output = usage.output_tokens_inclusive ?? 0;
  return {
    ...createAnthropicMessagesUsage(input - (usage.cached_input_tokens ?? 0) - (usage.cache_creation_input_tokens ?? 0), output),
    cache_read_input_tokens: usage.cached_input_tokens ?? null,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
    output_tokens_details: usage.reasoning_tokens === undefined ? null : { thinking_tokens: usage.reasoning_tokens },
  };
};
