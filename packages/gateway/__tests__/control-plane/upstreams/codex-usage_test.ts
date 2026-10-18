import { expect, test, vi } from 'vitest';

import { upstreamRecordToFullJson } from '../../../src/control-plane/upstreams/serialize.ts';
import { buildCodexUpstreamRecord, MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { readCodexUpstreamState } from '@floway-dev/provider-codex';
import { withMockedFetch } from '@floway-dev/test-utils';

const PATH = '/api/upstreams/codex/usage';
const body = () => ({
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3600 },
    secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 86_400 },
  },
  credits: { has_credits: true, balance: '123.5' },
  additional_rate_limits: [{ metered_feature: 'code_review', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }],
});

const setup = async () => {
  const context = await setupAppTest();
  await context.repo.upstreams.deleteAll();
  const record = buildCodexUpstreamRecord({ enabled: false, usageRefreshIntervalMinutes: 0 });
  await context.repo.upstreams.insertForModels(record);
  return { ...context, record };
};

const action = (session: string, record: unknown): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json', 'x-floway-session': session },
  body: JSON.stringify({ record }),
});

test('Floway refreshes Codex quota immediately and persists every family without model calls', async () => {
  const { repo, adminSession, record } = await setup();
  let calls = 0;
  await withMockedFetch(async request => {
    calls += 1;
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/backend-api/wham/usage');
    expect(request.headers.get('authorization')).toBe('Bearer codex-access-token');
    expect(request.headers.get('chatgpt-account-id')).toBe('acc');
    return Response.json(body());
  }, async () => {
    // The stored identity and credential govern the action, even if the caller
    // supplies only the envelope required by the shared action contract.
    const response = await requestApp(PATH, action(adminSession, {
      id: record.id, kind: 'codex', config: null, state: null,
    }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      codex: { primary_used_percent: 25, primary_window_minutes: 300, secondary_used_percent: 40, secondary_window_minutes: 10080, credits_balance: 123.5 },
      code_review: { primary_used_percent: 10 },
    });
    const stored = await repo.upstreams.getById(record.id);
    const snapshots = readCodexUpstreamState(stored?.state).accounts[0].quotaSnapshot;
    expect(snapshots?.codex.data).toEqual(result.codex);
    expect(snapshots?.code_review.data).toEqual(result.code_review);
    const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
    expect((await list.json())[0].codex_quota).toEqual(result);
    // An explicit action does not inherit the disabled/background cadence gates.
    expect(stored?.enabled).toBe(false);
    expect(stored?.usageRefreshIntervalMinutes).toBe(0);
  });
  expect(calls).toBe(1);
});

test('Floway restricts Codex usage refresh to administrator callers', async () => {
  const { adminSession, apiKey, record } = await setup();
  let calls = 0;
  await withMockedFetch(async () => { calls += 1; throw new Error('Unexpected upstream query'); }, async () => {
    const unauthenticated = await requestApp(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthenticated.status).toBe(401);
    const unauthorized = await requestApp(PATH, {
      ...action(adminSession, upstreamRecordToFullJson(record)),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.key}` },
    });
    expect(unauthorized.status).toBe(403);
  });
  expect(calls).toBe(0);
});

test('Floway rejects draft, missing, mismatched and inactive Codex targets before querying usage', async () => {
  const { repo, adminSession, record } = await setup();
  let calls = 0;
  await withMockedFetch(async () => { calls += 1; throw new Error('Unexpected upstream query'); }, async () => {
    for (const [id, kind, expected] of [['', 'codex', 400], ['missing', 'codex', 404], [record.id, 'custom', 400]] as const) {
      const response = await requestApp(PATH, action(adminSession, { id, kind, config: null, state: null }));
      expect(response.status).toBe(expected);
    }
    await repo.upstreams.saveState(record.id, current => {
      const state = readCodexUpstreamState(current);
      return { accounts: [{ ...state.accounts[0], state: 'session_terminated', accessToken: null }] };
    });
    const inactive = await requestApp(PATH, action(adminSession, upstreamRecordToFullJson(record)));
    expect(inactive.status).toBe(400);
    expect(await inactive.json()).toMatchObject({ error: expect.stringContaining('session_terminated') });
  });
  expect(calls).toBe(0);
});

test('Floway honors the Codex usage action proxy override and rejects unknown proxies', async () => {
  const { adminSession, record } = await setup();
  let calls = 0;
  await withMockedFetch(async () => { calls += 1; return Response.json(body()); }, async () => {
    const bad = await requestApp(PATH, action(adminSession, { ...upstreamRecordToFullJson(record), proxy_fallback_list: [{ id: 'missing-proxy' }] }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.stringContaining('unknown proxy id') });
    const good = await requestApp(PATH, action(adminSession, { ...upstreamRecordToFullJson(record), proxy_fallback_list: MOCKED_FETCH_EGRESS }));
    expect(good.status).toBe(200);
  });
  expect(calls).toBe(1);
});

test.each([403, 429, 500])('Floway preserves existing quota and credential health after upstream HTTP %i', async status => {
  const { repo, adminSession, record } = await setup();
  await withMockedFetch(async () => Response.json(body()), async () => {
    expect((await requestApp(PATH, action(adminSession, upstreamRecordToFullJson(record)))).status).toBe(200);
  });
  const before = readCodexUpstreamState((await repo.upstreams.getById(record.id))?.state);
  await withMockedFetch(async () => new Response('denied codex-access-token', { status }), async () => {
    const response = await requestApp(PATH, action(adminSession, upstreamRecordToFullJson(record)));
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.error).toContain(String(status));
    expect(result.error).not.toContain('codex-access-token');
    expect(readCodexUpstreamState((await repo.upstreams.getById(record.id))?.state)).toEqual(before);
  });
});

test('Floway surfaces usage persistence failures with their original internal error', async () => {
  const { repo, adminSession, record } = await setup();
  const error = new Error('Codex quota storage failed', { cause: new Error('database unavailable') });
  const save = vi.spyOn(repo.upstreams, 'saveState').mockRejectedValueOnce(error);
  try {
    await withMockedFetch(async () => Response.json(body()), async () => {
      const response = await requestApp(PATH, action(adminSession, upstreamRecordToFullJson(record)));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { message: error.message, stack: expect.any(String), cause: { message: 'database unavailable' } } });
    });
    expect(save).toHaveBeenCalledOnce();
  } finally {
    save.mockRestore();
  }
});

test('Floway retains saved Codex readings when usage reports no allowance', async () => {
  const { repo, adminSession, record } = await setup();
  await withMockedFetch(async () => Response.json(body()), async () => {
    expect((await requestApp(PATH, action(adminSession, upstreamRecordToFullJson(record)))).status).toBe(200);
  });
  const before = readCodexUpstreamState((await repo.upstreams.getById(record.id))?.state);
  await withMockedFetch(async () => Response.json({ rate_limit: null, credits: null }), async () => {
    const response = await requestApp(PATH, action(adminSession, upstreamRecordToFullJson(record)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(readCodexUpstreamState((await repo.upstreams.getById(record.id))?.state)).toEqual(before);
  });
});

test('Floway fails malformed Codex usage without publishing a fabricated observation', async () => {
  const { repo, adminSession, record } = await setup();
  await withMockedFetch(async () => Response.json({ rate_limit: { primary_window: { used_percent: '25' } } }), async () => {
    const response = await requestApp(PATH, action(adminSession, upstreamRecordToFullJson(record)));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('finite number') });
    expect(readCodexUpstreamState((await repo.upstreams.getById(record.id))?.state).accounts[0].quotaSnapshot).toBeNull();
  });
});

test('Floway omits the account header for a persisted Codex identity without an account id', async () => {
  const { repo, adminSession, record } = await setup();
  const state = readCodexUpstreamState(record.state);
  const next = buildCodexUpstreamRecord({
    config: { accounts: [{ email: null, chatgptAccountId: null, chatgptUserId: null, planType: 'plus' }] },
    state: { accounts: [{ ...state.accounts[0], chatgptAccountId: null }] },
  });
  await repo.upstreams.deleteAll();
  await repo.upstreams.insertForModels(next);
  await withMockedFetch(async request => {
    expect(request.headers.has('chatgpt-account-id')).toBe(false);
    return Response.json(body());
  }, async () => {
    expect((await requestApp(PATH, action(adminSession, upstreamRecordToFullJson(next)))).status).toBe(200);
    expect(readCodexUpstreamState((await repo.upstreams.getById(next.id))?.state).accounts[0].quotaSnapshot?.codex.data.credits_balance).toBe(123.5);
  });
});
