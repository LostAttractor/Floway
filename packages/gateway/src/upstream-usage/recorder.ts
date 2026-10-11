import type { Repo } from '../repo/types.ts';
import { normalizeUsageMetricKey } from '@floway-dev/provider';

export const createUpstreamUsageRecorder = (repo: Repo) => async (upstreamId: string, key: string, value: number, timestamp: number): Promise<void> => {
  if (!Number.isFinite(value) || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('Invalid upstream usage metric observation');
  await repo.upstreamUsageMetrics.record({ upstreamId, key: normalizeUsageMetricKey(key), value, timestamp });
};
