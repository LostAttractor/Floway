import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import { splitInclusiveOutputTokens } from '@floway-dev/protocols/common';

export const usageFromIR = (usage: IRUsage): Record<string, any> => {
  const count = (key: keyof IRUsage): number | undefined => usage[key] === undefined ? undefined : requireTokenCount(key, usage[key]);
  const input = count('input_tokens_inclusive') ?? 0;
  const output = count('output_tokens_inclusive') ?? 0;
  const reasoning = count('reasoning_tokens');
  const split = splitInclusiveOutputTokens(output, reasoning);
  return {
    promptTokenCount: input,
    candidatesTokenCount: split.output,
    totalTokenCount: count('total_tokens') ?? input + output,
    ...(usage.cached_input_tokens === undefined ? {} : { cachedContentTokenCount: count('cached_input_tokens') }),
    ...(reasoning === undefined ? {} : { thoughtsTokenCount: reasoning }),
    ...(['input', 'output'] as const).reduce<Record<string, any>>((details, direction) => {
      const tokens = ['audio', 'image', 'text'].flatMap(modality => {
        const count = usage[`${direction}_${modality}_tokens` as keyof IRUsage];
        return count === undefined ? [] : [{ modality: modality.toUpperCase(), tokenCount: requireTokenCount(`${direction}_${modality}_tokens`, count) }];
      });
      if (tokens.length > 0) details[direction === 'input' ? 'promptTokensDetails' : 'candidatesTokensDetails'] = tokens;
      return details;
    }, {}),
  };
};
