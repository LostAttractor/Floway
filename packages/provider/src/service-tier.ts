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

export const applyServiceTierPolicy = <T extends object>(
  body: T,
  fields: readonly (keyof T)[],
  policy: ServiceTierPolicy | null,
): T => {
  const result = { ...body };
  for (const field of fields) {
    const value = result[field];
    if (!policy?.enabled || typeof value !== 'string' || !policy.tiers.includes(value)) {
      delete result[field];
    }
  }
  return result;
};
