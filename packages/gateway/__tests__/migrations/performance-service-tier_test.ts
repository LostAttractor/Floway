import { expect, test } from 'vitest';

import { SqlRepo } from '../../src/repo/sql.ts';
import { createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../repo/test-sqlite.ts';

test('service-tier migration preserves historical counters, histograms, and query indexes', async () => {
  const db = await createSqlJsDatabase();
  try {
    const migration = '0097_performance_service_tier.sql';
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === migration) break;
      db.run(sql);
    }
    db.run(`INSERT INTO performance_summary (
      hour, key_id, model, upstream, operation, runtime_location,
      requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral,
      tpot_samples, ttft_ms_sum, tpot_us_sum
    ) VALUES ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 4, 1, 1, 1, 1, 2, 60, 500)`);
    db.run(`INSERT INTO performance_buckets (
      hour, key_id, model, upstream, operation, runtime_location, metric, lower, upper, count
    ) VALUES
      ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 'ttft_ms', 0, 50, 2),
      ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 'tpot_us', 0, 500, 2)`);
    const indexes = () => db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('performance_summary', 'performance_buckets') ORDER BY name");
    const beforeIndexes = indexes();
    const sql = migrationSqlByFilename.find(([filename]) => filename === migration)?.[1];
    expect(sql).toBeDefined();
    db.run(sql!);
    expect(indexes()).toEqual(beforeIndexes);

    const repo = new SqlRepo(wrapSqlJsDatabase(db)).performance;
    const [historical] = await repo.listAll();
    expect(historical).toEqual({
      hour: '2026-10-24T10', keyId: 'key', model: 'model', upstream: 'upstream', operation: 'chat', runtimeLocation: 'LOCAL',
      requests: 4, ttftSamplesOk: 1, errorsWithOutput: 1, errorsNoOutput: 1, neutral: 1,
      tpotSamples: 2, ttftMsSum: 60, tpotUsSum: 500,
      buckets: [
        { metric: 'tpot_us', lower: 0, upper: 500, count: 2 },
        { metric: 'ttft_ms', lower: 0, upper: 50, count: 2 },
      ],
    });
    await repo.recordSample({ ...historical, serviceTier: 'priority', ttftMs: 20, tpotUs: 200, success: true });
    expect(await repo.listAll()).toHaveLength(2);
    expect((await repo.listAll()).find(row => row.serviceTier === undefined)).toEqual(historical);
  } finally {
    db.close();
  }
});
