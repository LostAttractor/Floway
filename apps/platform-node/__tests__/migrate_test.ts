import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { SqlRepo } from '@floway-dev/gateway';
import { migrationsDir } from '@floway-dev/gateway/migrations-dir';
import type { SqlDatabase } from '@floway-dev/platform';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const withTemp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('applies all real migration files against a fresh sqlite', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'real.db'));
  await applyMigrations(db);

  // Schema check: a stable table from migration 0001 exists with expected columns.
  const apiKeyCols = await db.prepare('PRAGMA table_info(api_keys)').all<{ name: string }>();
  const colNames = apiKeyCols.results.map(r => r.name).toSorted();
  assertEquals(colNames.includes('id'), true);
  assertEquals(colNames.includes('key'), true);
  assertEquals(colNames.includes('server_secret'), true);

  // Every migration was recorded.
  const recorded = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();
  assertEquals(recorded !== null && recorded.n > 0, true);
}));

test('rerun is a no-op once all migrations are applied', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'idempotent.db'));
  await applyMigrations(db);
  const firstCount = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();

  await applyMigrations(db);
  const secondCount = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();
  assertEquals(secondCount?.n, firstCount?.n);
}));

test('mid-migration failure rolls back and leaves no partial schema', () => withTemp(async dir => {
  const migrationsDir = join(dir, 'migrations');
  await rm(migrationsDir, { recursive: true, force: true });
  await mkdir(migrationsDir, { recursive: true });

  // First statement creates a table; second is invalid SQL — the transaction
  // must roll back so the table from the first statement does not survive.
  await writeFile(
    join(migrationsDir, '0001_bad.sql'),
    'CREATE TABLE only_in_failed_migration (id INTEGER);\n'
    + 'NOT VALID SQL HERE;\n',
  );

  const db = createNodeSqliteDatabase(join(dir, 'rollback.db'));
  await assertRejects(() => applyMigrations(db, migrationsDir));

  const tables = await db.prepare(
    'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?',
  ).bind('only_in_failed_migration').all<{ name: string }>();
  assertEquals(tables.results, []);

  const recorded = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  assertEquals(recorded.results, []);
}));

test('skips already-applied migrations on partial state', () => withTemp(async dir => {
  const migrationsDir = join(dir, 'migrations');
  await mkdir(migrationsDir, { recursive: true });
  await writeFile(join(migrationsDir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
  await writeFile(join(migrationsDir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);');

  const db = createNodeSqliteDatabase(join(dir, 'partial.db'));
  await applyMigrations(db, migrationsDir);

  // Add a third migration; rerun. Only the new one should execute — the first
  // two would error if re-run because the tables already exist.
  await writeFile(join(migrationsDir, '0003_c.sql'), 'CREATE TABLE c (id INTEGER);');
  await applyMigrations(db, migrationsDir);

  const recorded = await db.prepare('SELECT name FROM _migrations ORDER BY name').all<{ name: string }>();
  assertEquals(recorded.results.map(r => r.name), ['0001_a.sql', '0002_b.sql', '0003_c.sql']);
}));

for (const policyApplied of [false, true]) {
  test(`consolidated service-tier migration preserves legacy ledgers and data (policy applied: ${policyApplied})`, () => withTemp(async dir => {
    const source = fileURLToPath(migrationsDir);
    const legacyDir = join(dir, 'legacy');
    await mkdir(legacyDir);
    for (const name of await readdir(source)) {
      if (name.endsWith('.sql') && name < '0097_') await copyFile(join(source, name), join(legacyDir, name));
    }
    const legacy = createNodeSqliteDatabase(join(dir, 'legacy.db'));
    const fresh = createNodeSqliteDatabase(join(dir, 'fresh.db'));
    for (const db of [legacy, fresh]) {
      await applyMigrations(db, legacyDir);
      await db.exec(`INSERT INTO performance_summary (
        hour, key_id, model, upstream, operation, runtime_location,
        requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral,
        tpot_samples, ttft_ms_sum, tpot_us_sum
      ) VALUES ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 4, 1, 1, 1, 1, 2, 60, 500);
      INSERT INTO performance_buckets (
        hour, key_id, model, upstream, operation, runtime_location, metric, lower, upper, count
      ) VALUES
        ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 'ttft_ms', 0, 50, 2),
        ('2026-10-24T10', 'key', 'model', 'upstream', 'chat', 'LOCAL', 'tpot_us', 0, 500, 2);`);
    }
    const fixtures = new URL('./fixtures/service-tier-migrations/', import.meta.url);
    const reported = '0097_performance_service_tier.sql';
    const requested = '0098_performance_requested_service_tier.sql';
    const policy = '0099_upstream_service_tier_policy.sql';
    await copyFile(new URL(reported, fixtures), join(legacyDir, reported));
    await applyMigrations(legacy, legacyDir);
    const partial = await legacy.prepare('PRAGMA table_info(performance_summary)').all<{ name: string }>();
    assertEquals(partial.results.some(row => row.name === 'requested_service_tier'), false);
    const reportedSample = `INSERT INTO performance_summary (
      hour, key_id, model, upstream, operation, runtime_location, service_tier, requests, neutral
    ) VALUES ('2026-10-24T10', 'key', 'reported-model', 'upstream', 'chat', 'LOCAL', ' Custom雪 ', 3, 3);
    INSERT INTO performance_buckets (
      hour, key_id, model, upstream, operation, runtime_location, service_tier, metric, lower, upper, count
    ) VALUES ('2026-10-24T10', 'key', 'reported-model', 'upstream', 'chat', 'LOCAL', ' Custom雪 ', 'ttft_ms', 0, 50, 3);`;
    await legacy.exec(reportedSample);

    // The original 0098 is required before a 0097-only preview can switch to the consolidated chain.
    await copyFile(new URL(requested, fixtures), join(legacyDir, requested));
    await applyMigrations(legacy, legacyDir);
    const snapshot = async (db: SqlDatabase) => ({
      schema: (await db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name IN ('performance_summary', 'performance_buckets') ORDER BY name").all()).results,
      summary: (await db.prepare('SELECT * FROM performance_summary ORDER BY service_tier, requested_service_tier').all()).results,
      buckets: (await db.prepare('SELECT * FROM performance_buckets ORDER BY service_tier, requested_service_tier, metric, lower').all()).results,
    });
    await applyMigrations(fresh);
    await fresh.exec(reportedSample);
    assertEquals(await snapshot(legacy), await snapshot(fresh));
    if (policyApplied) {
      await copyFile(join(source, policy), join(legacyDir, policy));
      await applyMigrations(legacy, legacyDir);
    }
    const repo = new SqlRepo(legacy).performance;
    const dimensions = {
      hour: '2026-10-24T10', keyId: 'key', model: 'model', upstream: 'upstream',
      operation: 'chat' as const, runtimeLocation: 'LOCAL',
    };
    for (const tier of ['priority', 'default', ' Custom雪 ']) {
      await repo.recordSample({ ...dimensions, serviceTier: tier, requestedServiceTier: 'priority', ttftMs: 20, tpotUs: 200, success: true });
    }
    const before = await snapshot(legacy);
    const oldLedger = (await legacy.prepare('SELECT name FROM _migrations ORDER BY name').all<{ name: string }>()).results;
    await applyMigrations(legacy);
    assertEquals(await snapshot(legacy), before);
    const newLedger = (await legacy.prepare('SELECT name FROM _migrations ORDER BY name').all<{ name: string }>()).results;
    assertEquals(newLedger.map(row => row.name), [...oldLedger.map(row => row.name), ...policyApplied ? [] : [policy]].toSorted());
    assertEquals(newLedger.some(row => row.name === requested), true);
    const policyColumn = await legacy.prepare("SELECT name FROM pragma_table_info('upstreams') WHERE name = 'service_tier_policy'").first();
    assertEquals(policyColumn?.name, 'service_tier_policy');
    await applyMigrations(legacy);
    assertEquals(await snapshot(legacy), before);
    assertEquals((await legacy.prepare('SELECT name FROM _migrations ORDER BY name').all()).results, newLedger);

    const effective = { ...dimensions, requestedServiceTier: 'priority' };
    await repo.recordNeutral(effective);
    await repo.recordZeroOutputError(effective);
    await repo.recordSample({ ...effective, ttftMs: 20, tpotUs: 200, success: true });
    const current = (await repo.listAll()).find(row => row.serviceTier === undefined && row.requestedServiceTier === 'priority');
    assertEquals(current?.requests, 3);
    assertEquals(current?.neutral, 1);
    assertEquals(current?.errorsNoOutput, 1);
    assertEquals(current?.ttftSamplesOk, 1);
    assertEquals(current?.buckets.length, 2);
  }));
}
