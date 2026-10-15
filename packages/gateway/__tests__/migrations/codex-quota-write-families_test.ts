import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';

const MIGRATION = '0092_codex_quota_write_families.sql';
const entry = (fetchedAt: number, data: Record<string, unknown>) => ({ fetchedAt, data: { observed_at: new Date(fetchedAt).toISOString(), ...data } });
const window = { primary_used_percent: 56, primary_window_minutes: 10080 };
const credits = { credits_has_credits: true, credits_balance: 62358.03278 };

test('Floway keeps quota families canonical while connections from both Worker versions write', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA recursive_triggers = ON');
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename >= MIGRATION) break;
      db.exec(sql);
    }
    const seed = db.prepare("INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, hue) VALUES (?, ?, '', '', '', '{}', ?, 210)");
    const state = (quotaSnapshot: unknown, refresh_token = 'original') => ({ accounts: [{ refresh_token, quotaSnapshot }] });
    const original = { codex: entry(1000, { ...window, ...credits }), premium: entry(2000, { active_limit: 'premium', ...window, primary_used_percent: 60 }) };
    seed.run('codex', 'codex', JSON.stringify(state(original)));
    seed.run('custom', 'custom', JSON.stringify(state(original)));
    const write = (snapshots: unknown, token?: string) => db.prepare('UPDATE upstreams SET state_json = ? WHERE id = ?').run(JSON.stringify(state(snapshots, token)), 'codex');
    const read = (id = 'codex') => JSON.parse((db.prepare('SELECT state_json FROM upstreams WHERE id = ?').get(id) as { state_json: string }).state_json) as { accounts: [{ refresh_token: string; quotaSnapshot: Record<string, ReturnType<typeof entry>> | null }] };
    const metric = db.prepare('INSERT INTO upstream_metrics VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (upstream_id, metric_name, metric_labels, bucket) DO UPDATE SET timestamp = excluded.timestamp, value = excluded.value');
    const labels = (limit: string) => JSON.stringify({ limit, window_seconds: 604800 });
    const addMetric = (limit: string, timestamp: number, value: number, upstreamId = 'codex') => metric.run(upstreamId, 'quota.window.used_percent', labels(limit), 1, timestamp, value);
    addMetric('codex', 1000, 56);
    addMetric('premium', 2000, 60);
    db.exec(migrationSqlByFilename.find(([filename]) => filename === MIGRATION)![1]);
    expect(read().accounts[0].quotaSnapshot).toEqual({ codex: entry(2000, { ...window, ...credits, primary_used_percent: 60 }) });
    expect(read('custom').accounts[0].quotaSnapshot).toEqual(original);

    // Old connections may refresh credentials and write empty observations too.
    write({ ...read().accounts[0].quotaSnapshot, premium: entry(3000, { active_limit: 'premium', ...window, primary_used_percent: 70 }), unknown: entry(4000, {}) }, 'rotated');
    expect(read().accounts[0]).toEqual({ refresh_token: 'rotated', quotaSnapshot: { codex: entry(3000, { ...window, ...credits, primary_used_percent: 70 }) } });
    addMetric('premium', 3000, 70);
    addMetric('premium', 2500, 65);
    addMetric('', 2900, 69);
    expect(db.prepare('SELECT metric_labels, timestamp, value FROM upstream_metrics WHERE upstream_id = ?').all('codex')).toEqual([{ metric_labels: labels('codex'), timestamp: 3000, value: 70 }]);

    // A late old response must not replace a newer canonical reading or zero credits.
    write({ codex: entry(5000, { ...window, credits_has_credits: false, credits_balance: 0 }), premium: entry(4000, { active_limit: 'premium', ...window, ...credits }) });
    expect(read().accounts[0].quotaSnapshot).toEqual({ codex: entry(5000, { ...window, credits_has_credits: false, credits_balance: 0 }) });

    // Open-string family IDs are preserved when written in the current shape.
    const independent = { codex: entry(6000, window), premium: entry(6000, { ...window, primary_used_percent: 20 }), unknown: entry(6000, { ...window, primary_used_percent: 30 }), 'quote"key': entry(6000, window) };
    write(independent);
    expect(read().accounts[0].quotaSnapshot).toEqual(independent);
    addMetric('premium', 6000, 20);
    addMetric('unknown', 6000, 30);
    addMetric('premium', 6000, 20, 'custom');
    expect(db.prepare('SELECT metric_labels, timestamp, value FROM upstream_metrics WHERE upstream_id = ? ORDER BY metric_labels').all('codex')).toEqual([
      { metric_labels: labels('codex'), timestamp: 3000, value: 70 },
      { metric_labels: labels('premium'), timestamp: 6000, value: 20 },
      { metric_labels: labels('unknown'), timestamp: 6000, value: 30 },
    ]);
    expect(db.prepare('SELECT metric_labels FROM upstream_metrics WHERE upstream_id = ?').all('custom')).toEqual([{ metric_labels: labels('premium') }]);
    write({ unknown: entry(7000, {}), codex: entry(7000, { active_limit: 'codex', primary_used_percent: 0, primary_window_minutes: 0 }) });
    expect(read().accounts[0].quotaSnapshot).toBeNull();
    write(null);
    expect(read().accounts[0].quotaSnapshot).toBeNull();
  } finally {
    db.close();
  }
});
