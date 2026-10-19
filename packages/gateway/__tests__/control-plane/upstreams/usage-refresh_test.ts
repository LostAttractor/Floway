import { expect, test, vi } from 'vitest';

import { buildCodexUpstreamRecord, buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { readClaudeCodeUpstreamState } from '@floway-dev/provider-claude-code';
import { readCodexUpstreamState } from '@floway-dev/provider-codex';
import { readCopilotUpstreamState } from '@floway-dev/provider-copilot';
import { readOllamaUpstreamState } from '@floway-dev/provider-ollama';
import { withMockedFetch } from '@floway-dev/test-utils';

const PATH = '/api/upstreams/usage/refresh';
const action = (session: string): RequestInit => ({ method: 'POST', headers: { 'x-floway-session': session } });
const codexBody = { rate_limit: { secondary_window: { used_percent: 85, limit_window_seconds: 604800, reset_at: 1900000000 } } };
const claudeBody = { seven_day: { utilization: 85, resets_at: '2030-01-01T00:00:00Z' } };

const setup = async () => {
  const context = await setupAppTest();
  await context.repo.upstreams.deleteAll();
  const codex = buildCodexUpstreamRecord({ enabled: false, usageRefreshIntervalMinutes: 0 });
  const claude = buildCustomUpstreamRecord({
    id: 'up_claude', kind: 'claude-code', enabled: false,
    config: { accounts: [{ accountUuid: 'claude-account', email: 'claude@example.com', organizationUuid: null, subscriptionType: 'pro', rateLimitTier: null }] },
    state: {
      accounts: [{
        accountUuid: 'claude-account', tokenKind: 'oauth', refreshToken: 'claude-private-refresh', state: 'active', stateUpdatedAt: '2026-01-01T00:00:00Z',
        accessToken: { token: 'claude-private-access', expiresAt: Date.parse('2100-01-01T00:00:00Z'), refreshedAt: '2026-01-01T00:00:00Z' },
        quotaSnapshot: null, usageProbeSnapshot: null,
      }],
    },
  });
  for (const record of [codex, claude]) await context.repo.upstreams.insertForModels(record);
  return { ...context, codex, claude };
};

test('Floway refreshes all saved accounts with server-owned credentials and preserves reset times', async () => {
  const { repo, adminSession, codex, claude } = await setup();
  const paths: string[] = [];
  await withMockedFetch(request => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    expect(request.method).toBe('GET');
    if (path === '/backend-api/wham/usage') {
      expect(request.headers.get('authorization')).toBe('Bearer codex-access-token');
      return Response.json(codexBody);
    }
    expect(path).toBe('/api/oauth/usage');
    expect(request.headers.get('authorization')).toBe('Bearer claude-private-access');
    return Response.json(claudeBody);
  }, async () => {
    const response = await requestApp(PATH, action(adminSession));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: expect.arrayContaining([
        { id: codex.id, status: 'refreshed' }, { id: claude.id, status: 'refreshed' },
      ]),
    });
    const savedCodex = await repo.upstreams.getById(codex.id);
    expect(readCodexUpstreamState(savedCodex?.state).accounts[0].quotaSnapshot?.codex.data.secondary_used_percent).toBe(85);
    expect(readClaudeCodeUpstreamState((await repo.upstreams.getById(claude.id))?.state).accounts[0].usageProbeSnapshot?.data).toEqual(claudeBody);
    expect(savedCodex?.enabled).toBe(false);
    expect(savedCodex?.usageRefreshIntervalMinutes).toBe(0);
    expect(JSON.stringify(await (await requestApp('/api/upstreams', { headers: action(adminSession).headers })).json())).not.toContain('claude-private-access');
  });
  expect(paths.sort()).toEqual(['/api/oauth/usage', '/backend-api/wham/usage']);
});

test('Floway requires administrator authentication for batch refresh', async () => {
  const { apiKey } = await setup();
  await withMockedFetch(() => { throw new Error('No upstream query is authorized'); }, async () => {
    expect((await requestApp(PATH, { method: 'POST' })).status).toBe(401);
    expect((await requestApp(PATH, { method: 'POST', headers: { authorization: `Bearer ${apiKey.key}` } })).status).toBe(403);
  });
});

test('Floway continues after individual failures, redacts credentials, and retains previous readings', async () => {
  const { repo, adminSession, codex, claude } = await setup();
  await withMockedFetch(request => Response.json(new URL(request.url).pathname.includes('wham') ? codexBody : claudeBody), async () => {
    await requestApp(PATH, action(adminSession));
  });
  const before = readCodexUpstreamState((await repo.upstreams.getById(codex.id))?.state);
  await withMockedFetch(request => new URL(request.url).pathname.includes('wham')
    ? new Response('denied codex-access-token rt_v1', { status: 429 })
    : Response.json(claudeBody), async () => {
    const response = await requestApp(PATH, action(adminSession));
    const result = await response.json();
    expect(result.results).toContainEqual({ id: claude.id, status: 'refreshed' });
    expect(result.results).toContainEqual({ id: codex.id, status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('429') }) });
    expect(JSON.stringify(result)).not.toMatch(/codex-access-token|rt_v1|claude-private/);
    expect(readCodexUpstreamState((await repo.upstreams.getById(codex.id))?.state)).toEqual(before);
  });
});

test('Floway reports storage failures with their original error chain while refreshing other accounts', async () => {
  const { repo, adminSession, codex, claude } = await setup();
  const original = repo.upstreams.saveState.bind(repo.upstreams);
  const save = vi.spyOn(repo.upstreams, 'saveState').mockImplementation(async (id, mutate) => {
    if (id === codex.id) throw new Error('Quota write failed', { cause: new Error('database unavailable') });
    return await original(id, mutate);
  });
  try {
    await withMockedFetch(request => Response.json(new URL(request.url).pathname.includes('wham') ? codexBody : claudeBody), async () => {
      const result = await (await requestApp(PATH, action(adminSession))).json();
      expect(result.results).toContainEqual({ id: codex.id, status: 'failed', error: expect.objectContaining({ message: 'Quota write failed', stack: expect.any(String), cause: expect.objectContaining({ message: 'database unavailable' }) }) });
      expect(result.results).toContainEqual({ id: claude.id, status: 'refreshed' });
    });
  } finally {
    save.mockRestore();
  }
});

test('Floway refreshes Copilot and Ollama Cloud and skips unsupported configurations', async () => {
  const { repo, adminSession } = await setup();
  await repo.upstreams.deleteAll();
  const copilot = buildCustomUpstreamRecord({ id: 'copilot', kind: 'copilot', config: { githubHost: 'github.com', githubToken: 'github-private', user: { id: 1, login: 'test', avatar_url: '', name: null } } });
  const cloud = buildCustomUpstreamRecord({ id: 'cloud', kind: 'ollama', config: { baseUrl: 'https://ollama.com', apiKey: 'ollama-private', cloudUsage: true, models: [] }, state: null });
  const local = { ...cloud, id: 'local', config: { ...cloud.config as object, cloudUsage: false } };
  for (const record of [copilot, cloud, local, buildCustomUpstreamRecord()]) await repo.upstreams.insertForModels(record);
  const paths: string[] = [];
  await withMockedFetch(request => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    switch (path) {
    case '/copilot_internal/user': return Response.json({ copilot_plan: 'individual', quota_reset_date_utc: '2030-01-01T00:00:00Z', quota_snapshots: { premium_interactions: { entitlement: 300, overage_count: 0, overage_permitted: false, percent_remaining: 90, quota_remaining: 270, unlimited: false } } });
    case '/api/usage': return Response.json({ range: '7d', scope: 'self', from: '2026-10-01T00:00:00Z', until: '2026-10-08T00:00:00Z', totals: { request_count: 15, usage_usd: 3.5 } });
    case '/api/balance': return Response.json({ included: { balance_usd: 42, allowance_usd: 60, period: { from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' } }, purchased: { balance_usd: 25 } });
    case '/api/me': return Response.json({ name: 'Tester', email: 'test@example.com', plan: 'pro' });
    default: throw new Error(`Unexpected query: ${path}`);
    }
  }, async () => {
    const result = await (await requestApp(PATH, action(adminSession))).json();
    expect(result.results).toContainEqual({ id: copilot.id, status: 'refreshed' });
    expect(result.results).toContainEqual({ id: cloud.id, status: 'refreshed' });
    expect(result.results).toContainEqual({ id: local.id, status: 'unsupported' });
    expect(readCopilotUpstreamState((await repo.upstreams.getById(copilot.id))?.state).quotaSnapshot?.data.quotas.premium_interactions.percent_remaining).toBe(90);
    expect(readOllamaUpstreamState((await repo.upstreams.getById(cloud.id))?.state).usageProbe?.observation?.data).toMatchObject({ balance: { purchased: { balance_usd: 25 } } });
  });
  expect(paths.sort()).toEqual(['/api/balance', '/api/me', '/api/usage', '/copilot_internal/user']);
});

test('Floway reports no targets as a completed empty refresh', async () => {
  const { repo, adminSession } = await setup();
  await repo.upstreams.deleteAll();
  expect(await (await requestApp(PATH, action(adminSession))).json()).toEqual({ results: [] });
});

test('Floway respects saved proxy policy and inactive credential state during batch refresh', async () => {
  const { repo, adminSession, codex } = await setup();
  await repo.upstreams.deleteAll();
  const inactive = buildCodexUpstreamRecord({
    id: 'inactive',
    state: { accounts: [{ ...readCodexUpstreamState(codex.state).accounts[0], state: 'session_terminated', accessToken: null }] },
  });
  await repo.upstreams.insertForModels(inactive);
  await repo.upstreams.insertForModels({ ...codex, proxyFallbackList: [{ id: 'missing-proxy' }] });
  let calls = 0;
  await withMockedFetch(() => { calls += 1; throw new Error('Unexpected direct egress'); }, async () => {
    const result = await (await requestApp(PATH, action(adminSession))).json();
    expect(result.results).toHaveLength(2);
    expect(result.results).toContainEqual({ id: 'inactive', status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('session_terminated') }) });
    expect(result.results).toContainEqual({ id: codex.id, status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('missing-proxy') }) });
  });
  expect(calls).toBe(0);
});
