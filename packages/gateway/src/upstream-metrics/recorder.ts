import type { Repo } from '../repo/types.ts';
import { normalizeUpstreamMetricKey } from '@floway-dev/provider';

export const createUpstreamMetricsRecorder = (repo: Repo) => async (upstreamId: string, key: string, value: number, timestamp: number): Promise<void> => {
  if (!Number.isFinite(value) || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('Invalid upstream metric observation');
  await repo.upstreamMetrics.record({ upstreamId, key: normalizeUpstreamMetricKey(key), value, timestamp });
};
