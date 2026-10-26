import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import {
  clearCodexQuota,
  getCodexQuota,
  hasCodexQuotaReading,
  parseCodexQuotaHeaders,
  putCodexQuota,
} from '../src/quota.ts';
import type { CodexQuotaSnapshot, CodexQuotaSnapshotEntryMap, CodexUpstreamState } from '../src/state.ts';
import { parseCodexUsage } from '../src/usage-probe.ts';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';

const accountId = 'acc_1';
const upstreamId = 'up_a';

test('hasCodexQuotaReading ignores an observation timestamp without quota data', () => {
  expect(hasCodexQuotaReading({ observed_at: '2026-01-01T00:00:00Z' })).toBe(false);
  expect(hasCodexQuotaReading({ observed_at: '2026-01-01T00:00:00Z', plan_type: 'plus' })).toBe(false);
});

const makeRecord = (state: CodexUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'codex',
  name: 'Codex',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: accountId, chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  serviceTierPolicy: null,
  modelsCache: null,
  hue: 210,
});

const baseAccount = {
  chatgptAccountId: accountId,
  refresh_token: 'rt_v1',
  state: 'active' as const,
  state_updated_at: '2026-06-01T00:00:00.000Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  accessToken: null,
  quotaSnapshot: null as CodexQuotaSnapshotEntryMap | null,
};

let current: UpstreamRecord | null;
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current!, state: state as CodexUpstreamState };
  });
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

describe('parseCodexQuotaHeaders', () => {
  test.each(['premium', 'codex_future', '', 'constructor'])('uses header families independently of active-limit %s', active => {
    const snapshots = parseCodexQuotaHeaders(new Headers({
      'x-codex-active-limit': active,
      'x-codex-primary-used-percent': '45',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-future-secondary-used-percent': '100',
      'x-codex-future-secondary-window-minutes': '300',
      'x-codex-future-secondary-reset-after-seconds': '60',
      'x-codex-credits-balance': '0',
    }), { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(Object.keys(snapshots).sort()).toEqual(['codex', 'codex_future']);
    expect(snapshots.codex).toMatchObject({ primary_used_percent: 45, credits_balance: 0 });
    expect(snapshots.codex.ratelimited_until).toBeUndefined();
    expect(snapshots.codex_future).toEqual({
      observed_at: '2026-06-05T00:00:00.000Z', secondary_used_percent: 100,
      secondary_window_minutes: 300, secondary_reset_after_at: '2026-06-05T00:01:00.000Z', ratelimited_until: '2026-06-05T00:01:00.000Z',
    });
  });

  test.each<Record<string, string>>([
    {},
    { 'x-codex-active-limit': 'premium', 'x-codex-plan-type': 'pro' },
    { 'x-codex-primary-used-percent': '0', 'x-codex-primary-window-minutes': '0' },
    { 'x-codex-primary-used-percent': 'NaN', 'x-codex-primary-reset-after-seconds': '60' },
  ])('omits responses without a quota reading: %j', headers => {
    expect(parseCodexQuotaHeaders(new Headers(headers), { now: new Date(), isRateLimited: false })).toEqual({});
  });

  test('keeps a zero credit balance without inventing a window', () => {
    const now = new Date();
    expect(parseCodexQuotaHeaders(new Headers({ 'x-codex-credits-has-credits': 'false', 'x-codex-credits-balance': '0' }), { now, isRateLimited: false }))
      .toEqual({ codex: { observed_at: now.toISOString(), credits_has_credits: false, credits_balance: 0 } });
  });

  test('parses a 200 snapshot (no ratelimited_until)', () => {
    const headers = new Headers({
      'x-codex-active-limit': 'premium',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
      'x-codex-secondary-used-percent': '94',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '486400',
      'x-codex-credits-has-credits': 'False',
      'x-codex-credits-balance': '0',
    });
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: observedAt, isRateLimited: false });
    expect(snapshot).toMatchObject({
      observed_at: '2026-06-05T00:00:00.000Z',
      plan_type: 'plus',
      primary_used_percent: 42,
      primary_window_minutes: 300,
      primary_reset_after_at: '2026-06-05T05:00:00.000Z',
      secondary_used_percent: 94,
      secondary_window_minutes: 10080,
      credits_has_credits: false,
      credits_balance: 0,
    });
    expect(snapshot.ratelimited_until).toBeUndefined();
  });

  // Upstream added `-reset-at` on 2025-10-17 and kept sending the offset it
  // replaced, so the absolute instant wins and the offset is the fallback.
  test('prefers the absolute reset instant over the offset it replaced', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-reset-at': '1780272000',
      'x-codex-primary-reset-after-seconds': '18000',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.primary_reset_after_at).toBe(new Date(1780272000 * 1000).toISOString());
    // No absolute instant for the secondary, so the offset still dates it.
    expect(snapshot.secondary_reset_after_at).toBe('2026-06-05T02:00:00.000Z');
  });

  // Builds from the three days after the header landed sent RFC 3339 instead of
  // epoch seconds, which is why every client that reads it accepts both.
  test('reads an absolute reset instant sent as RFC 3339', () => {
    const headers = new Headers({ 'x-codex-primary-used-percent': '42', 'x-codex-primary-reset-at': '2026-06-05T05:00:00.000Z' });
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.primary_reset_after_at).toBe('2026-06-05T05:00:00.000Z');
  });

  // A plan whose secondary window is zero minutes wide reports a blank instant
  // beside a zero offset. That is "no such window", not "it resets now".
  test('reports no reset for a window this plan does not have', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '42',
      'x-codex-secondary-window-minutes': '0',
      'x-codex-secondary-reset-at': '',
      'x-codex-secondary-reset-after-seconds': '0',
    });
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.secondary_reset_after_at).toBeUndefined();
  });

  // `Number('')` is 0, so a blank reading would otherwise land as a confident
  // zero balance rather than as nothing observed.
  test('reads a blank numeric header as absent rather than as zero', () => {
    const headers = new Headers({ 'x-codex-credits-balance': '', 'x-codex-secondary-used-percent': '  ' });
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot).toBeUndefined();
  });

  test('dates a 429 from the exhausted windows when only absolute reset headers arrive', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-secondary-used-percent': '100',
      'x-codex-primary-reset-at': '1780272000',
      'x-codex-secondary-reset-at': '1780358400',
    });
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot.ratelimited_until).toBe(new Date(1780358400 * 1000).toISOString());
  });

  test('sets ratelimited_until from the latest exhausted reset window on 429', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-secondary-used-percent': '101',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: observedAt, isRateLimited: true });
    expect(snapshot.ratelimited_until).toBe('2026-06-05T02:00:00.000Z');
  });

  test.each([
    ['primary only', '100', '35', '2026-06-05T01:00:00.000Z'],
    ['secondary only', '35', '100', '2026-06-05T02:00:00.000Z'],
    ['both', '100', '100', '2026-06-05T02:00:00.000Z'],
    ['neither', '99.9', '35', undefined],
    ['zero usage', '0', '0', undefined],
    ['blank usage', '', ' ', undefined],
    ['invalid usage', 'NaN', 'Infinity', undefined],
    ['absent usage', undefined, undefined, undefined],
    ['unknown primary', undefined, '100', '2026-06-05T02:00:00.000Z'],
    ['unknown secondary', '100', undefined, '2026-06-05T01:00:00.000Z'],
  ])('uses only known exhausted windows: %s', (_name, primary, secondary, expected) => {
    const headers = new Headers({
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    if (primary !== undefined) headers.set('x-codex-primary-used-percent', primary);
    if (secondary !== undefined) headers.set('x-codex-secondary-used-percent', secondary);
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot?.ratelimited_until).toBe(expected);
  });

  test.each(['primary', 'secondary'] as const)('retains the known horizon when the other exhausted %s window has no reset', missing => {
    const known = missing === 'primary' ? 'secondary' : 'primary';
    const { codex: snapshot } = parseCodexQuotaHeaders(new Headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-secondary-used-percent': '100',
      [`x-codex-${known}-reset-after-seconds`]: '3600',
    }), { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot.ratelimited_until).toBe('2026-06-05T01:00:00.000Z');
    expect(snapshot.primary_used_percent).toBe(100);
    expect(snapshot.secondary_used_percent).toBe(100);
    expect(snapshot[`${missing}_reset_after_at`]).toBeUndefined();
  });

  test.each([undefined, '', '0', 'invalid'])('does not guess an expiry without a usable exhausted reset: %s', reset => {
    const headers = new Headers({ 'x-codex-primary-used-percent': '100' });
    if (reset !== undefined) {
      headers.set('x-codex-primary-reset-at', reset);
      headers.set('x-codex-primary-reset-after-seconds', reset);
    }
    const { codex: snapshot } = parseCodexQuotaHeaders(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot.ratelimited_until).toBeUndefined();
    expect(snapshot.primary_used_percent).toBe(100);
  });

  test.each([
    ['epoch', '1780621200', '9999'],
    ['RFC 3339', '2026-06-05T03:00:00+02:00', '9999'],
    ['offset', '', '3600'],
  ])('uses the supported %s exhausted reset format', (_name, at, after) => {
    const { codex: snapshot } = parseCodexQuotaHeaders(new Headers({
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-at': at,
      'x-codex-primary-reset-after-seconds': after,
    }), { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot.ratelimited_until).toBe('2026-06-05T01:00:00.000Z');
  });

  test('normalizes string headers at the provider boundary', () => {
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const { codex: snapshot } = parseCodexQuotaHeaders(new Headers({
      'x-codex-active-limit': '  premium  ',
      'x-codex-plan-type': ' plus ',
      'x-codex-primary-used-percent': '42',
    }), { now: observedAt, isRateLimited: false });
    expect(snapshot).toEqual({ observed_at: '2026-06-05T00:00:00.000Z', plan_type: 'plus', primary_used_percent: 42 });
  });
});

describe('parseCodexUsage', () => {
  test('does not turn plan metadata or null windows into an empty quota family', () => {
    expect(parseCodexUsage({ plan_type: 'pro', rate_limit: null, additional_rate_limits: [{ metered_feature: 'images', rate_limit: null }] }, new Date())).toEqual({});
  });

  test('retains upstream-owned family ids and zero readings', () => {
    const now = new Date();
    expect(parseCodexUsage({
      credits: { has_credits: false, balance: '0' },
      additional_rate_limits: [{ metered_feature: 'future.family/v2', rate_limit: { secondary_window: { used_percent: 0, limit_window_seconds: 300, reset_at: 1792649803 } } }],
    }, now)).toEqual({
      codex: { observed_at: now.toISOString(), credits_has_credits: false, credits_balance: 0 },
      'future.family/v2': { observed_at: now.toISOString(), secondary_used_percent: 0, secondary_window_minutes: 5, secondary_reset_after_at: new Date(1792649803_000).toISOString() },
    });
  });
});

describe('getCodexQuota', () => {
  test('returns null when the upstream row is missing', async () => {
    current = null;
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('returns null when the account has no snapshot', async () => {
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('returns the quota map when buckets are fresh', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 10 };
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { codex: { fetchedAt: Date.now(), data: snap } } }] });
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({ codex: snap });
  });

  test('projects legacy expiry per family without changing stored observations or successful snapshots', async () => {
    const primary: CodexQuotaSnapshot = {
      observed_at: '2026-06-05T00:00:00.000Z',
      primary_used_percent: 100,
      primary_reset_after_at: '2026-06-05T01:00:00.000Z',
      secondary_used_percent: 35,
      secondary_reset_after_at: '2026-06-09T00:00:00.000Z',
      ratelimited_until: '2026-06-09T00:00:00.000Z',
    };
    const secondary: CodexQuotaSnapshot = { ...primary, primary_used_percent: 35, secondary_used_percent: 100 };
    const unknown: CodexQuotaSnapshot = { ...primary, primary_used_percent: undefined, secondary_used_percent: undefined };
    const partial: CodexQuotaSnapshot = { ...secondary, primary_used_percent: 100, secondary_reset_after_at: undefined };
    const neither: CodexQuotaSnapshot = { ...primary, primary_used_percent: 35 };
    const untimed: CodexQuotaSnapshot = { ...primary, primary_reset_after_at: undefined };
    const invalid: CodexQuotaSnapshot = { ...primary, primary_reset_after_at: 'invalid' };
    const { ratelimited_until: _until, ...successful } = primary;
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        quotaSnapshot: Object.fromEntries(
          Object.entries({ primary, secondary, unknown, partial, neither, untimed, invalid, successful }).map(([key, data]) => [key, { fetchedAt: 1, data }]),
        ),
      }],
    });
    const stored = structuredClone(current);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-06T00:00:00.000Z'));
    const { ratelimited_until: _unknownUntil, ...unknownReading } = unknown;
    const { ratelimited_until: _neitherUntil, ...neitherReading } = neither;
    const { ratelimited_until: _untimedUntil, ...untimedReading } = untimed;
    const { ratelimited_until: _invalidUntil, ...invalidReading } = invalid;
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({
      primary: { ...primary, ratelimited_until: primary.primary_reset_after_at },
      secondary,
      unknown: unknownReading,
      partial: { ...partial, ratelimited_until: primary.primary_reset_after_at },
      neither: neitherReading,
      untimed: untimedReading,
      invalid: invalidReading,
      successful,
    });
    expect(current).toEqual(stored);
    expect(repo.writes).toEqual([]);
  });

  test('reads quota from the null account slot', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 42 };
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        chatgptAccountId: null,
        quotaSnapshot: { codex: { fetchedAt: Date.now(), data: snap } },
      }],
    });
    expect(await getCodexQuota(upstreamId, null)).toEqual({ codex: snap });
  });

  // An old reading rendered with the instant it was taken tells an operator
  // more than an empty card, so age withholds nothing -- the dashboard is the
  // only reader, and traffic on the upstream replaces what it shows.
  test('returns every bucket however long ago it was observed', async () => {
    const recent: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 42 };
    const ancient: CodexQuotaSnapshot = { observed_at: '2026-06-01T00:00:00.000Z', primary_used_percent: 20 };
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        quotaSnapshot: {
          recent: { fetchedAt: Date.now(), data: recent },
          ancient: { fetchedAt: Date.now() - 90 * 24 * 60 * 60 * 1000, data: ancient },
        },
      }],
    });
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({ recent, ancient });
  });

  test('returns null when the account has an empty snapshot map', async () => {
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: {} }] });
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('returns null when the requested account is not in the pool', async () => {
    expect(await getCodexQuota(upstreamId, 'acc_other')).toBeNull();
  });
});

describe('putCodexQuota', () => {
  const now = new Date('2026-10-16T00:00:00.000Z');
  const reading: CodexQuotaSnapshot = { observed_at: now.toISOString(), primary_used_percent: 42, primary_window_minutes: 10080 };

  test.each(['premium', 'unknown', 'future_pool_7', 'base_model_inference'])('Floway identifies %s from protocol metadata across both observation sources', async family => {
    const recordUpstreamMetric = vi.fn();
    initProviderRepo(() => ({ upstreams: repo, recordUpstreamMetric }));
    const scheduled = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: 1792649803 } },
      additional_rate_limits: [{ metered_feature: family, rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 300, reset_at: 1792118803 } } }],
    }, now);
    await putCodexQuota(upstreamId, accountId, scheduled);
    const prefix = `x-${family.replaceAll('_', '-')}`;
    const response = parseCodexQuotaHeaders(new Headers({
      'x-codex-active-limit': 'unrelated-runtime-selector',
      [`${prefix}-primary-used-percent`]: '30',
      [`${prefix}-primary-window-minutes`]: '5',
    }), { now: new Date(now.getTime() + 1000), isRateLimited: false });
    expect(Object.keys(response)).toEqual([family]);
    await putCodexQuota(upstreamId, accountId, response);
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({ codex: scheduled.codex, [family]: response[family] });
    expect(recordUpstreamMetric).toHaveBeenLastCalledWith(upstreamId, 'quota.window.used_percent', { limit: family, window_seconds: 300 }, 30, now.getTime() + 1000);
  });

  test('unifies scheduled usage and response headers while retaining independent families', async () => {
    const scheduled = parseCodexUsage({
      plan_type: 'pro', credits: { has_credits: true, balance: '62358.03278' },
      rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: 1792649803 } },
      additional_rate_limits: [{ metered_feature: 'codex_future', rate_limit: { secondary_window: { used_percent: 70, limit_window_seconds: 18000, reset_at: 1792118803 } } }],
    }, now);
    await putCodexQuota(upstreamId, accountId, scheduled);
    const headers = parseCodexQuotaHeaders(new Headers({
      'x-codex-active-limit': 'premium',
      'x-codex-primary-used-percent': '45',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-at': '1792649803',
    }), { now: new Date(now.getTime() + 1000), isRateLimited: false });
    await putCodexQuota(upstreamId, accountId, headers);
    const written = (current!.state as CodexUpstreamState).accounts[0];
    expect(Object.keys(written.quotaSnapshot!).sort()).toEqual(['codex', 'codex_future']);
    expect(written.quotaSnapshot?.codex.data).toEqual({ ...headers.codex, credits_has_credits: true, credits_balance: 62358.03278 });
    expect(written.quotaSnapshot?.codex_future.data).toEqual(scheduled.codex_future);
    expect({ ...written, quotaSnapshot: null }).toEqual(baseAccount);
    expect(repo.saveState).toHaveBeenCalledTimes(2);
  });

  test('does not create empty or metadata-only snapshots or publish metrics for them', async () => {
    const recordUpstreamMetric = vi.fn();
    initProviderRepo(() => ({ upstreams: repo, recordUpstreamMetric }));
    await putCodexQuota(upstreamId, accountId, { codex: { observed_at: now.toISOString(), plan_type: 'pro' } });
    expect(repo.saveState).not.toHaveBeenCalled();
    expect(recordUpstreamMetric).not.toHaveBeenCalled();
  });

  test('persists quota into the null account slot', async () => {
    current = makeRecord({ accounts: [{ ...baseAccount, chatgptAccountId: null }] });
    await putCodexQuota(upstreamId, null, { codex: reading });
    expect((current!.state as CodexUpstreamState).accounts[0].quotaSnapshot?.codex.data).toEqual(reading);
  });

  test('does not let a delayed observation replace a newer reading', async () => {
    await putCodexQuota(upstreamId, accountId, { codex: reading });
    await putCodexQuota(upstreamId, accountId, { codex: { ...reading, observed_at: new Date(now.getTime() - 1000).toISOString(), primary_used_percent: 10 } });
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({ codex: reading });
    expect(repo.writes).toHaveLength(1);
  });

  test.each(['', ' ', '__proto__', 'constructor', 'prototype'])('rejects an invalid family key: %s', async key => {
    await expect(putCodexQuota(upstreamId, accountId, Object.fromEntries([[key, reading]]))).rejects.toThrow('Invalid Codex quota family');
    expect(repo.writes).toEqual([]);
  });

  test('rejects an invalid observation time before persisting', async () => {
    await expect(putCodexQuota(upstreamId, accountId, { codex: { ...reading, observed_at: 'invalid' } })).rejects.toThrow('Invalid Codex quota observation time');
    expect(repo.writes).toEqual([]);
  });

  test('throws when the upstream disappeared mid-flight', async () => {
    current = null;
    await expect(putCodexQuota(upstreamId, accountId, { codex: reading })).rejects.toThrow(/disappeared/);
    expect(repo.writes).toEqual([]);
  });

  test('throws when the requested account is not in the pool', async () => {
    await expect(putCodexQuota(upstreamId, 'acc_other', { codex: reading })).rejects.toThrow(/not found in upstream/);
    expect(repo.writes).toEqual([]);
  });
});

describe('clearCodexQuota', () => {
  test('invalidates every observed bucket without touching the credential', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 90 };
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { codex: { fetchedAt: 1, data: snap } } }] });
    await clearCodexQuota(upstreamId, accountId);
    expect((current!.state as CodexUpstreamState).accounts[0]).toEqual({ ...baseAccount, quotaSnapshot: null });
  });

  test('does not write when the quota slot is already empty', async () => {
    await clearCodexQuota(upstreamId, accountId);
    expect(repo.writes).toEqual([]);
  });
});

test('publishes self-contained usage observations with capture timestamps and retries failed delivery', async () => {
  const failure = new Error('Usage storage unavailable');
  const recordUpstreamMetric = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  initProviderRepo(() => ({ upstreams: repo, recordUpstreamMetric }));
  const snapshot = { observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 42, primary_window_minutes: 300 };
  await expect(putCodexQuota(upstreamId, accountId, { codex: snapshot })).rejects.toBe(failure);
  await putCodexQuota(upstreamId, accountId, { codex: snapshot });
  expect(recordUpstreamMetric).toHaveBeenCalledTimes(2);
  expect(recordUpstreamMetric).toHaveBeenLastCalledWith(upstreamId, 'quota.window.used_percent', { limit: 'codex', window_seconds: 18_000 }, 42, Date.parse(snapshot.observed_at));
});
