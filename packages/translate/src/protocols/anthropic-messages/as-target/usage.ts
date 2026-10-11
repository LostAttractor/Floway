import type { IRUsage } from '../../../ir/types.ts';
import { splitAnthropicMessagesCacheCreationTokens } from '@floway-dev/protocols/anthropic-messages';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';

export const usageToIR = (usage: Record<string, any>): IRUsage => {
  const result: Partial<Record<keyof IRUsage, number>> = {};
  const put = (key: keyof IRUsage, value: number | undefined | null): void => { if (value != null) result[key] = value; };
  const { cacheWrite, cacheWrite1h } = splitAnthropicMessagesCacheCreationTokens({
    ...(usage.cache_creation_input_tokens == null ? {} : { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
    ...(usage.cache_creation == null ? {} : { cache_creation: usage.cache_creation }),
  });
  const write = cacheWrite + cacheWrite1h;
  if (usage.input_tokens != null) put('input_tokens_inclusive', usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + write);
  put('output_tokens_inclusive', usage.output_tokens);
  put('cached_input_tokens', usage.cache_read_input_tokens);
  if (usage.cache_creation_input_tokens != null || usage.cache_creation != null) put('cache_creation_input_tokens', write);
  put('reasoning_tokens', usage.output_tokens_details?.thinking_tokens);
  if (result.input_tokens_inclusive !== undefined) splitInclusiveInputTokens(result.input_tokens_inclusive, result.cached_input_tokens ?? 0, result.cache_creation_input_tokens ?? 0);
  return result;
};
