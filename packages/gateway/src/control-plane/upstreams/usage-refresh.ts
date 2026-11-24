import { chatgptActionAccess } from './chatgpt.ts';
import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { fetchChatGPTUsage, putChatGPTQuota } from '@floway-dev/provider-chatgpt';
import { ensureClaudeCodeAccessToken, fetchClaudeCodeUsageProbe, persistClaudeCodeUsageProbe } from '@floway-dev/provider-claude-code';
import { assertCopilotUpstreamRecord, fetchCopilotUsage, projectCopilotSeat, projectCopilotUsageResponse, putCopilotQuota, putCopilotSeat, type CopilotUsageResponse } from '@floway-dev/provider-copilot';
import { parseKimiCodeUpstreamConfig, refreshKimiCodeUsageProbe } from '@floway-dev/provider-kimi-code';
import { isOllamaUsageEnabled, parseOllamaUpstreamConfig, refreshOllamaAccount, refreshOllamaUsageProbe } from '@floway-dev/provider-ollama';

interface RefreshError {
  name: string;
  message: string;
  stack?: string;
  cause?: RefreshError;
  errors?: RefreshError[];
}

type RefreshResult =
  | { id: string; status: 'refreshed' | 'unsupported' }
  | { id: string; status: 'failed'; error: RefreshError };

// Error bodies can echo credentials. Keep the error chain and stack, while
// returning neither stored secrets nor credentials minted during this action.
const collectSecrets = (value: unknown, secrets: string[]): void => {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry !== '' && /token|secret|key|password|authorization/i.test(key)) secrets.push(entry);
    collectSecrets(entry, secrets);
  }
};

const refreshError = (error: unknown, secrets: readonly string[]): RefreshError => {
  const redact = (text: string): string => secrets.reduce((result, secret) => result.replaceAll(secret, '[credential]'), text);
  if (!(error instanceof Error)) return { name: 'Error', message: redact(String(error)) };
  return {
    name: error.name,
    message: redact(error.message),
    ...(error.stack !== undefined && { stack: redact(error.stack) }),
    ...(error.cause !== undefined && { cause: refreshError(error.cause, secrets) }),
    ...(error instanceof AggregateError ? { errors: error.errors.map(cause => refreshError(cause, secrets)) } : {}),
  };
};

const refreshSavedUsage = async (record: UpstreamRecord, request: Request, secrets: string[]): Promise<'refreshed' | 'unsupported'> => {
  if (record.kind === 'custom' || record.kind === 'azure') return 'unsupported';
  if (record.kind === 'ollama' && !isOllamaUsageEnabled(parseOllamaUpstreamConfig(record.config))) return 'unsupported';
  if (record.kind === 'chatgpt') {
    const access = await chatgptActionAccess({ record, request, actionLabel: 'ChatGPT usage actions' });
    secrets.push(access.accessToken);
    const snapshots = await fetchChatGPTUsage({ ...access, signal: request.signal });
    await putChatGPTQuota(record.id, access.accountId, snapshots);
    return 'refreshed';
  }
  const fetcher = await resolveControlPlaneFetcher({ upstreamId: record.id, runtimeLocation: getRuntimeLocation(request) });
  switch (record.kind) {
  case 'kimi-code':
    await refreshKimiCodeUsageProbe(record.id, parseKimiCodeUpstreamConfig(record.config), fetcher);
    return 'refreshed';
  case 'claude-code': {
    const access = await ensureClaudeCodeAccessToken({ upstreamId: record.id, repo: getRepo().upstreams, fetcher });
    secrets.push(access.entry.token);
    const probe = await fetchClaudeCodeUsageProbe(access.entry.token, fetcher);
    await persistClaudeCodeUsageProbe(record.id, probe);
    return 'refreshed';
  }
  case 'copilot': {
    const { config } = assertCopilotUpstreamRecord(record);
    if (!config.githubToken) throw new Error('Copilot upstream has no GitHub token');
    const response = await fetchCopilotUsage(config.githubHost, config.githubToken, fetcher);
    if (!response.ok) throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
    const body = await response.json() as CopilotUsageResponse;
    const now = new Date();
    const quota = projectCopilotUsageResponse(body, now);
    const seat = projectCopilotSeat(body, now);
    if (seat !== null) await putCopilotSeat(record.id, seat);
    if (quota !== null) await putCopilotQuota(record.id, quota);
    return 'refreshed';
  }
  case 'ollama': {
    const config = parseOllamaUpstreamConfig(record.config);
    // Account metadata is optional, as in the existing single-account action.
    const account = refreshOllamaAccount(record.id, config, fetcher).catch(() => null);
    await refreshOllamaUsageProbe(record.id, config, fetcher);
    await account;
    return 'refreshed';
  }
  }
};

// Manual refresh deliberately ignores enabled/background cadence settings.
// Two workers bound simultaneous provider calls, including Ollama's paired reads.
export const refreshUpstreamUsage = async (c: AuthedContext) => {
  const records = await getRepo().upstreams.list();
  const results: RefreshResult[] = new Array(records.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < records.length) {
      const index = next++;
      const record = records[index];
      const secrets: string[] = [];
      collectSecrets(record.config, secrets);
      collectSecrets(record.state, secrets);
      try {
        results[index] = { id: record.id, status: await refreshSavedUsage(record, c.req.raw, secrets) };
      } catch (error) {
        const detail = refreshError(error, secrets);
        console.error('Floway upstream usage refresh failed', record.id, detail);
        results[index] = { id: record.id, status: 'failed', error: detail };
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return c.json({ results });
};
