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

    const historical = db.exec('SELECT * FROM performance_summary');
    expect(historical[0]?.values).toEqual([
      ['2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', '', 4, 1, 1, 1, 1, 2, 60, 500],
    ]);
    expect(db.exec('SELECT * FROM performance_buckets ORDER BY metric')[0]?.values).toEqual([
      ['2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', '', 'tpot_us', 0, 500, 2],
      ['2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', '', 'ttft_ms', 0, 50, 2],
    ]);
    db.run(`INSERT INTO performance_summary (
      hour, key_id, model, upstream, operation, runtime_location, service_tier,
      requests, ttft_samples_ok, tpot_samples, ttft_ms_sum, tpot_us_sum
    ) VALUES ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 'priority', 1, 1, 1, 20, 200)`);
    db.run(`INSERT INTO performance_buckets (
      hour, key_id, model, upstream, operation, runtime_location, service_tier, metric, lower, upper, count
    ) VALUES
      ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 'priority', 'ttft_ms', 0, 100, 1),
      ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 'priority', 'tpot_us', 0, 500, 1)`);
    expect(db.exec('SELECT COUNT(*) FROM performance_summary')[0]?.values).toEqual([[2]]);
    expect(db.exec("SELECT * FROM performance_summary WHERE service_tier = ''")).toEqual(historical);
    expect(db.exec('SELECT COUNT(*) FROM performance_buckets')[0]?.values).toEqual([[4]]);
  } finally {
    db.close();
  }
});

test('requested-tier migration preserves reported tiers, counters, histograms, and query indexes', async () => {
  const db = await createSqlJsDatabase();
  try {
    const migration = '0098_performance_requested_service_tier.sql';
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === migration) break;
      db.run(sql);
    }
    for (const tier of ['', 'priority', 'default', ' Custom雪 ']) {
      db.run(`INSERT INTO performance_summary (
        hour, key_id, model, upstream, operation, runtime_location, service_tier,
        requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral,
        tpot_samples, ttft_ms_sum, tpot_us_sum
      ) VALUES ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', ?, 4, 1, 1, 1, 1, 2, 60, 500)`, [tier]);
      db.run(`INSERT INTO performance_buckets (
        hour, key_id, model, upstream, operation, runtime_location, service_tier, metric, lower, upper, count
      ) VALUES
        ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', ?, 'ttft_ms', 0, 50, 2),
        ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', ?, 'tpot_us', 0, 500, 2)`, [tier, tier]);
    }
    const summaryColumns = 'hour, key_id, model, upstream, operation, runtime_location, service_tier, requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral, tpot_samples, ttft_ms_sum, tpot_us_sum';
    const bucketColumns = 'hour, key_id, model, upstream, operation, runtime_location, service_tier, metric, lower, upper, count';
    const summaries = () => db.exec(`SELECT ${summaryColumns} FROM performance_summary ORDER BY service_tier`);
    const buckets = () => db.exec(`SELECT ${bucketColumns} FROM performance_buckets ORDER BY service_tier, metric`);
    const indexes = () => db.exec("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN ('performance_summary', 'performance_buckets') ORDER BY name");
    const before = { summaries: summaries(), buckets: buckets(), indexes: indexes() };
    const sql = migrationSqlByFilename.find(([filename]) => filename === migration)?.[1];
    expect(sql).toBeDefined();
    db.run(sql!);
    expect({ summaries: summaries(), buckets: buckets(), indexes: indexes() }).toEqual(before);
    for (const table of ['performance_summary', 'performance_buckets']) {
      expect(db.exec(`SELECT DISTINCT requested_service_tier FROM ${table}`)[0]?.values).toEqual([['']]);
    }

    // Only use the current repository after all later migrations have run.
    for (const [filename, sql] of migrationSqlByFilename) if (filename > migration) db.run(sql);
    const repo = new SqlRepo(wrapSqlJsDatabase(db)).performance;
    const historical = await repo.listAll();
    expect(historical).toHaveLength(4);
    const reported = historical.find(row => row.serviceTier === 'priority')!;
    await repo.recordSample({ ...reported, requestedServiceTier: 'priority', ttftMs: 20, tpotUs: 200, success: true });
    const rows = await repo.listAll();
    expect(rows).toHaveLength(5);
    expect(rows.filter(row => row.requestedServiceTier === undefined)).toEqual(historical);
    expect(rows.find(row => row.requestedServiceTier === 'priority')).toMatchObject({
      serviceTier: 'priority', requests: 1, ttftSamplesOk: 1, tpotSamples: 1, ttftMsSum: 20, tpotUsSum: 200,
      buckets: [
        { metric: 'tpot_us', lower: 0, upper: 500, count: 1 },
        { metric: 'ttft_ms', lower: 0, upper: 100, count: 1 },
      ],
    });
  } finally {
    db.close();
  }
});
