import type { CodexAccessTokenEntry, CodexQuotaSnapshot } from './state.ts';

export interface CodexPlanObservation {
  planType: string;
  observedAt?: string;
}

type PlanToken = Pick<CodexAccessTokenEntry, 'planType' | 'planObservedAt' | 'refreshedAt'>;

export const codexPlanObservation = (entry: PlanToken | null | undefined): CodexPlanObservation | null =>
  entry?.planType === undefined
    ? null
    : { planType: entry.planType, observedAt: entry.planObservedAt ?? entry.refreshedAt };

export const codexQuotaPlanObservation = (snapshot: CodexQuotaSnapshot | null | undefined): CodexPlanObservation | null =>
  snapshot?.plan_type === undefined
    ? null
    : { planType: snapshot.plan_type, observedAt: snapshot.plan_observed_at ?? snapshot.observed_at };

export const hasCodexQuotaUsage = (snapshot: CodexQuotaSnapshot): boolean =>
  (snapshot.primary_used_percent !== undefined && snapshot.primary_window_minutes !== 0)
  || (snapshot.secondary_used_percent !== undefined && snapshot.secondary_window_minutes !== 0)
  || snapshot.credits_has_credits !== undefined
  || snapshot.credits_balance !== undefined;

const observationTime = (observation: CodexPlanObservation): number => {
  const parsed = observation.observedAt === undefined ? Number.NaN : Date.parse(observation.observedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

export const latestPlanObservation = (...values: (CodexPlanObservation | null | undefined)[]): CodexPlanObservation | null => {
  const observations = values.filter((value): value is CodexPlanObservation => value !== null && value !== undefined);
  if (observations.length === 0) return null;
  return observations.reduce((latest, candidate) =>
    observationTime(candidate) > observationTime(latest) ? candidate : latest);
};

export const resolveCodexPlan = (
  fallback: string | null | undefined,
  token: PlanToken | null | undefined,
  quota: readonly CodexQuotaSnapshot[] | null | undefined,
): CodexPlanObservation | null => latestPlanObservation(
  codexPlanObservation(token),
  ...(quota ?? []).map(codexQuotaPlanObservation),
  fallback === null || fallback === undefined ? null : { planType: fallback },
);

export const resolveCodexPlanType = (...args: Parameters<typeof resolveCodexPlan>): string | null => resolveCodexPlan(...args)?.planType ?? null;
