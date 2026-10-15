import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertCodexUpstreamState, type CodexUpstreamState } from '@floway-dev/provider-codex';

const MIGRATION = '0091_codex_quota_families.sql';
const entry = (at: string, data: Record<string, unknown>) => ({ fetchedAt: Date.parse(at), data: { observed_at: at, ...data } });
const older = '2026-10-15T18:58:25.000Z';
const newer = '2026-10-15T18:58:59.000Z';
const reset = '2026-10-22T06:16:43.000Z';
const window = { primary_used_percent: 44, primary_window_minutes: 10080, primary_reset_after_at: reset };
const credits = { credits_has_credits: true, credits_balance: 62358.03278 };
const extra = entry(older, { active_limit: 'codex_future', secondary_used_percent: 80, secondary_window_minutes: 300 });
const account = {
  chatgptAccountId: 'account', refresh_token: 'refresh', openaiDeviceId: 'device',
  state: 'active', state_updated_at: older, accessToken: null,
};

test('Floway migrates duplicate and empty Codex snapshots and historical gauges without losing independent quotas', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename >= MIGRATION) break;
      db.exec(sql);
    }
    const insert = db.prepare("INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, hue) VALUES (?, ?, ?, '', '', '{}', ?, 210)");
    const seed = (id: string, snapshots: unknown, provider = 'codex') => {
      insert.run(id, provider, id, JSON.stringify({ accounts: [{ ...account, quotaSnapshot: snapshots }] }));
    };
    const screenshot = {
      codex: entry(older, { active_limit: 'codex', plan_type: 'pro', ...window, ...credits }),
      premium: entry(newer, { active_limit: 'premium', plan_type: 'pro', ...window, ...credits, secondary_used_percent: 0, secondary_window_minutes: 0 }),
      unknown: entry('2026-10-15T18:49:47.040Z', {}),
      codex_future: extra,
    };
    seed('screenshot', screenshot);
    seed('newer-usage', { premium: entry(older, { ...window, primary_used_percent: 100, ratelimited_until: reset }), codex: entry(newer, { ...window, primary_used_percent: 12 }) });
    seed('omitted-credits', { codex: entry(older, { ...window, ...credits }), premium: entry(newer, window) });
    seed('zero-credits', { codex: entry(older, { ...window, ...credits }), premium: entry(newer, { credits_has_credits: false, credits_balance: 0 }) });
    seed('unknown-reading', { unknown: entry(older, window) });
    seed('empty', { unknown: entry(newer, {}), codex: entry(older, { active_limit: 'codex', plan_type: 'pro' }) });
    seed('null', null);
    seed('unusual-key', { 'quote"key': entry(older, window) });
    seed('other-provider', screenshot, 'custom');

    const metric = db.prepare('INSERT INTO upstream_metrics VALUES (?, ?, ?, ?, ?, ?)');
    const addMetric = (limit: string, timestamp: number, value: number, upstream = 'screenshot') => {
      metric.run(upstream, 'quota.window.used_percent', JSON.stringify({ limit, window_seconds: 604800 }), 1, timestamp, value);
    };
    addMetric('codex', 100, 40);
    addMetric('premium', 120, 44);
    addMetric('', 110, 42);
    addMetric('codex_future', 110, 80);
    addMetric('premium', 120, 44, 'other-provider');

    const sql = migrationSqlByFilename.find(([filename]) => filename === MIGRATION)![1];
    db.exec(sql);
    const state = (id: string): CodexUpstreamState => {
      const row = db.prepare('SELECT state_json FROM upstreams WHERE id = ?').get(id) as { state_json: string };
      const state: unknown = JSON.parse(row.state_json);
      assertCodexUpstreamState(state);
      return state;
    };
    const { active_limit: _extraIdentity, ...extraData } = extra.data as typeof extra.data & { active_limit: string };
    const { active_limit: _identity, ...latestData } = screenshot.premium.data as typeof screenshot.premium.data & { active_limit: string };
    expect(state('screenshot').accounts[0]).toEqual({
      ...account,
      quotaSnapshot: { codex: { fetchedAt: Date.parse(newer), data: latestData }, codex_future: { ...extra, data: extraData } },
    });
    expect(state('newer-usage').accounts[0].quotaSnapshot).toEqual({ codex: entry(newer, { ...window, primary_used_percent: 12 }) });
    expect(state('omitted-credits').accounts[0].quotaSnapshot).toEqual({ codex: entry(newer, { ...window, ...credits }) });
    expect(state('zero-credits').accounts[0].quotaSnapshot).toEqual({ codex: entry(newer, { credits_has_credits: false, credits_balance: 0 }) });
    expect(state('unknown-reading').accounts[0].quotaSnapshot).toEqual({ codex: entry(older, window) });
    expect(state('empty').accounts[0].quotaSnapshot).toBeNull();
    expect(state('null').accounts[0].quotaSnapshot).toBeNull();
    expect(state('unusual-key').accounts[0].quotaSnapshot).toEqual({ 'quote"key': entry(older, window) });
    expect(state('other-provider').accounts[0].quotaSnapshot).toEqual(screenshot);
    const metrics = db.prepare('SELECT upstream_id, metric_labels, timestamp, value FROM upstream_metrics ORDER BY upstream_id, metric_labels').all();
    expect(metrics).toEqual([
      { upstream_id: 'other-provider', metric_labels: JSON.stringify({ limit: 'premium', window_seconds: 604800 }), timestamp: 120, value: 44 },
      { upstream_id: 'screenshot', metric_labels: JSON.stringify({ limit: 'codex', window_seconds: 604800 }), timestamp: 120, value: 44 },
      { upstream_id: 'screenshot', metric_labels: JSON.stringify({ limit: 'codex_future', window_seconds: 604800 }), timestamp: 110, value: 80 },
    ]);
    const migrated = db.prepare('SELECT * FROM upstreams ORDER BY id').all();
    db.exec(sql);
    expect(db.prepare('SELECT * FROM upstreams ORDER BY id').all()).toEqual(migrated);
    expect(db.prepare('SELECT upstream_id, metric_labels, timestamp, value FROM upstream_metrics ORDER BY upstream_id, metric_labels').all()).toEqual(metrics);
  } finally {
    db.close();
  }
});
