import type { IRUsage } from '../../../ir/types.ts';
import { splitInclusiveOutputTokens } from '@floway-dev/protocols/common';

export const usageFromIR = (usage: IRUsage): Record<string, any> => {
  const input = usage.input_tokens_inclusive ?? 0;
  const output = usage.output_tokens_inclusive ?? 0;
  const split = splitInclusiveOutputTokens(output, usage.reasoning_tokens);
  return {
    promptTokenCount: input,
    candidatesTokenCount: split.output,
    totalTokenCount: usage.total_tokens ?? input + output,
    ...(usage.cached_input_tokens === undefined ? {} : { cachedContentTokenCount: usage.cached_input_tokens }),
    ...(usage.reasoning_tokens === undefined ? {} : { thoughtsTokenCount: usage.reasoning_tokens }),
    ...(['input', 'output'] as const).reduce<Record<string, any>>((details, direction) => {
      const tokens = ['audio', 'image', 'text'].flatMap(modality => {
        const count = usage[`${direction}_${modality}_tokens` as keyof IRUsage];
        return count === undefined ? [] : [{ modality: modality.toUpperCase(), tokenCount: count }];
      });
      if (tokens.length > 0) details[direction === 'input' ? 'promptTokensDetails' : 'candidatesTokensDetails'] = tokens;
      return details;
    }, {}),
  };
};
