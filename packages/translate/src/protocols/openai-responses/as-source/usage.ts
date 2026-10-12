import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';

export const usageFromIR = (usage: IRUsage): Record<string, any> => {
  const count = (key: keyof IRUsage): number | undefined => usage[key] === undefined ? undefined : requireTokenCount(key, usage[key]);
  const input = count('input_tokens_inclusive') ?? 0;
  const output = count('output_tokens_inclusive') ?? 0;
  const inputDetails: Record<string, any> = {};
  const outputDetails: Record<string, any> = {};
  if (usage.cached_input_tokens !== undefined) inputDetails.cached_tokens = count('cached_input_tokens');
  if (usage.cache_creation_input_tokens !== undefined) inputDetails.cache_write_tokens = count('cache_creation_input_tokens');
  if (usage.reasoning_tokens !== undefined) outputDetails.reasoning_tokens = count('reasoning_tokens');

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: count('total_tokens') ?? input + output,
    ...(Object.keys(inputDetails).length === 0 ? {} : { input_tokens_details: inputDetails }),
    ...(Object.keys(outputDetails).length === 0 ? {} : { output_tokens_details: outputDetails }),
  };
};
