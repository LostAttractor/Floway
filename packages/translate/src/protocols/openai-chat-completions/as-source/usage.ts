import type { IRUsage } from '../../../ir/types.ts';

export const usageFromIR = (usage: IRUsage): Record<string, any> => {
  const input = usage.input_tokens_inclusive ?? 0;
  const output = usage.output_tokens_inclusive ?? 0;
  const inputDetails: Record<string, any> = {};
  const outputDetails: Record<string, any> = {};
  if (usage.cached_input_tokens !== undefined) inputDetails.cached_tokens = usage.cached_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) inputDetails.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  if (usage.reasoning_tokens !== undefined) outputDetails.reasoning_tokens = usage.reasoning_tokens;
  for (const modality of ['audio', 'image', 'text']) {
    const inputCount = usage[`input_${modality}_tokens` as keyof IRUsage];
    const outputCount = usage[`output_${modality}_tokens` as keyof IRUsage];
    if (inputCount !== undefined) inputDetails[`${modality}_tokens`] = inputCount;
    if (outputCount !== undefined) outputDetails[`${modality}_tokens`] = outputCount;
  }
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage.total_tokens ?? input + output,
    ...(Object.keys(inputDetails).length === 0 ? {} : { prompt_tokens_details: inputDetails }),
    ...(Object.keys(outputDetails).length === 0 ? {} : { completion_tokens_details: outputDetails }),
  };
};
