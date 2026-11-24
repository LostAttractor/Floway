import { isFastServiceTier } from '@floway-dev/protocols/common';
import { isServiceTierAllowed, ServiceTierRequestError, type ModelCandidate } from '@floway-dev/provider';

export const matchesAliasServiceTier = (requested: string, configured: string): boolean =>
  requested === configured || (isFastServiceTier(requested) && isFastServiceTier(configured));

export const requireServiceTierPolicy = <T extends object>(
  candidate: ModelCandidate,
  body: T,
  ...fields: readonly (Extract<keyof T, string>)[]
): void => {
  const policy = candidate.provider.serviceTierPolicy;
  for (const field of fields) {
    const value = body[field];
    if (!isServiceTierAllowed(policy, value)) {
      const tier = typeof value === 'string' ? ` ${JSON.stringify(value)}` : '';
      throw new ServiceTierRequestError(field, `The upstream service tier policy disallows the requested tier${tier}.`);
    }
  }
};
