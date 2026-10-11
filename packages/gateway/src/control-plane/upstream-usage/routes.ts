import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamUsageQuery } from '../schemas.ts';

export const upstreamUsage = async (c: CtxWithQuery<typeof upstreamUsageQuery>) => {
  const { upstream_id, start, end } = c.req.valid('query');
  return c.json({ records: await getRepo().upstreamUsageMetrics.query(start, end, upstream_id), start, end });
};
