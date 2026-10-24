import { beforeEach, expect, test } from 'vitest';

import { settle, settleUsageMeasurement } from '../../../../src/data-plane/shared/telemetry/settle.ts';
import { tokenUsageMeasurement } from '../../../../src/data-plane/shared/telemetry/usage.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { TelemetryModelIdentity } from '@floway-dev/provider';
import { assertEquals, mockPerfTelemetryContext } from '@floway-dev/test-utils';

const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'claude-test',
  upstream: 'copilot:1',
  modelKey: 'claude-test-raw',
  pricing: null,
};

const testPerformanceContext = mockPerfTelemetryContext({
  keyId: '',
  model: 'claude-test',
  upstream: 'copilot:1',
  runtimeLocation: 'SJC',
});

let repo: InMemoryRepo;
let background: Promise<unknown>[];
const ctx = ({ firstOutputTokenAt = null, upstreamCallStartedAt = null }: {
  firstOutputTokenAt?: number | null;
  upstreamCallStartedAt?: number | null;
} = {}) => mockGatewayCtx({
  apiKeyId: 'key_a',
  backgroundScheduler: promise => { background.push(promise); },
  attempt: { timing: { firstOutputTokenAt, upstreamCallStartedAt }, telemetry: undefined },
});

beforeEach(() => {
  repo = new InMemoryRepo();
  initRepo(repo);
  background = [];
});

// ── settle ──

test('settle records a usage row when the figure carries a billable metric', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, { input: 10, output: 5 }, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].keyId, 'key_a');
  assertEquals(tokenCountsFromUsage(rows[0]), { input: 10, output: 5 });
  assertEquals(rows[0].requests, 1);
});

test('settle records the request without metrics when usage is null', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, null, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].metrics, []);
});

test('settle records the request when usage carries no billable metric', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, {}, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].metrics, []);
});

for (const useMeasurement of [false, true]) {
  test(`settle${useMeasurement ? 'UsageMeasurement' : ''} separates response tiers, including partial failures and neutral requests`, async () => {
    const settleUsage = (tier: string | undefined, output: number, failed: boolean) => {
      const gatewayCtx = ctx({ upstreamCallStartedAt: 10, firstOutputTokenAt: 30 });
      const usage = { input: 10, output, ...(tier ? { tier } : {}) };
      if (useMeasurement) {
        settleUsageMeasurement(gatewayCtx, testPerformanceContext, testTelemetryModelIdentity, tokenUsageMeasurement(usage), failed, 80);
      } else {
        settle(gatewayCtx, testPerformanceContext, testTelemetryModelIdentity, usage, failed, 80);
      }
    };
    settleUsage('priority', 3, false);
    settleUsage('flex', 3, true);
    settleUsage(undefined, 3, false);
    settleUsage('future-tier', 0, true);
    await Promise.all(background);
    const rows = await repo.performance.listAll();
    expect(rows).toHaveLength(4);
    expect(rows.find(row => row.serviceTier === 'priority')).toMatchObject({ ttftSamplesOk: 1, ttftMsSum: 20, tpotUsSum: 25_000 });
    expect(rows.find(row => row.serviceTier === 'flex')).toMatchObject({ errorsWithOutput: 1, tpotSamples: 1 });
    expect(rows.find(row => row.serviceTier === undefined)).toMatchObject({ ttftSamplesOk: 1 });
    expect(rows.find(row => row.serviceTier === 'future-tier')).toMatchObject({ errorsNoOutput: 1, buckets: [] });

    const measurement = tokenUsageMeasurement({ tier: 'fast' });
    if (useMeasurement) {
      settleUsageMeasurement(ctx(), testPerformanceContext, testTelemetryModelIdentity, measurement, false);
    } else {
      settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, { tier: 'fast' }, false);
    }
    await Promise.all(background);
    expect((await repo.performance.listAll()).find(row => row.serviceTier === 'fast')).toMatchObject({ neutral: 1, buckets: [] });
  });
}

// TPOT reflects the token stream, not the D1 write that follows it.
// `settle` fires the usage record through backgroundScheduler and records
// the perf sample synchronously — so a slow persistence path cannot leak
// its latency into `tpotUs`. Regressing this (turning the usage record
// back into an in-band await, or moving the perf record past the
// scheduler call) would fold persistence latency into every stream's
// per-token interval.
test('settle records the perf sample without waiting on the usage write', async () => {
  const originalRecord = repo.usage.record.bind(repo.usage);
  const persistenceDelayMs = 200;
  repo.usage.record = async row => {
    await new Promise(resolve => setTimeout(resolve, persistenceDelayMs));
    await originalRecord(row);
  };

  const beforeSettle = performance.now();
  const gatewayCtx = ctx({ upstreamCallStartedAt: beforeSettle - 10, firstOutputTokenAt: beforeSettle });

  settle(gatewayCtx, testPerformanceContext, testTelemetryModelIdentity, { input: 5, output: 3 }, false);
  await Promise.all(background);

  const rows = await repo.performance.listAll();
  assertEquals(rows.length, 1);
  // TPOT = (requestFinishedAt - firstOutputTokenAt) * 1000 / (outputTokens - 1).
  // Recorded synchronously at settle entry: tpotUs reflects only the
  // sub-millisecond gap between ctx construction and settle. Fold the
  // 200ms usage write into it (in-band await) and tpotUs would be
  // ~100_000us (200ms / 2). 50_000us fences the regression while
  // tolerating scheduler jitter.
  expect(rows[0].tpotUsSum).toBeLessThan(50_000);
});
