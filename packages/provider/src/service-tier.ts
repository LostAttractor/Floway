export interface ServiceTierPolicy {
  enabled: boolean;
  tiers: string[];
}

export const normalizeServiceTierPolicy = (input: unknown): ServiceTierPolicy | null => {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('serviceTierPolicy must be an object or null');
  }
  const { enabled, tiers } = input as { enabled?: unknown; tiers?: unknown };
  if (typeof enabled !== 'boolean') throw new Error('serviceTierPolicy.enabled must be a boolean');
  if (!Array.isArray(tiers) || tiers.some(tier => typeof tier !== 'string' || tier.trim() === '')) {
    throw new Error('serviceTierPolicy.tiers must contain non-empty strings');
  }
  if (new Set(tiers).size !== tiers.length) throw new Error('serviceTierPolicy.tiers must not contain duplicates');
  if (enabled && tiers.length === 0) throw new Error('serviceTierPolicy.tiers must not be empty when enabled');
  return { enabled, tiers: [...tiers] as string[] };
};

export const isServiceTierAllowed = (policy: ServiceTierPolicy | null, value: unknown): boolean =>
  value == null || policy === null || (policy.enabled && typeof value === 'string' && policy.tiers.includes(value));

// A candidate refuses the requested tier before dispatching to the upstream.
export class ServiceTierRequestError extends Error {
  readonly code = 'unsupported_value';

  constructor(readonly param: string, message: string) {
    super(message);
  }

  asInputError(param = this.param) {
    return { message: this.message, param, code: this.code };
  }
}
