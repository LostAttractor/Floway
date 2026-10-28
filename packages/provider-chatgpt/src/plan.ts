import type { ChatGPTAccessTokenEntry, ChatGPTQuotaSnapshot } from './state.ts';

export interface ChatGPTPlanObservation {
  planType: string;
  observedAt?: string;
}

type PlanToken = Pick<ChatGPTAccessTokenEntry, 'planType' | 'planObservedAt' | 'refreshedAt'>;

export const chatgptPlanObservation = (entry: PlanToken | null | undefined): ChatGPTPlanObservation | null =>
  entry?.planType === undefined
    ? null
    : { planType: entry.planType, observedAt: entry.planObservedAt ?? entry.refreshedAt };

export const chatgptQuotaPlanObservation = (snapshot: ChatGPTQuotaSnapshot | null | undefined): ChatGPTPlanObservation | null =>
  snapshot?.plan_type === undefined
    ? null
    : { planType: snapshot.plan_type, observedAt: snapshot.plan_observed_at ?? snapshot.observed_at };

export const hasChatGPTQuotaUsage = (snapshot: ChatGPTQuotaSnapshot): boolean =>
  (snapshot.primary_used_percent !== undefined && snapshot.primary_window_minutes !== 0)
  || (snapshot.secondary_used_percent !== undefined && snapshot.secondary_window_minutes !== 0)
  || snapshot.credits_has_credits !== undefined
  || snapshot.credits_balance !== undefined;

const observationTime = (observation: ChatGPTPlanObservation): number => {
  const parsed = observation.observedAt === undefined ? Number.NaN : Date.parse(observation.observedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

export const latestPlanObservation = (...values: (ChatGPTPlanObservation | null | undefined)[]): ChatGPTPlanObservation | null => {
  const observations = values.filter((value): value is ChatGPTPlanObservation => value !== null && value !== undefined);
  if (observations.length === 0) return null;
  return observations.reduce((latest, candidate) =>
    observationTime(candidate) > observationTime(latest) ? candidate : latest);
};

export const resolveChatGPTPlan = (
  fallback: string | null | undefined,
  token: PlanToken | null | undefined,
  quota: readonly ChatGPTQuotaSnapshot[] | null | undefined,
): ChatGPTPlanObservation | null => latestPlanObservation(
  chatgptPlanObservation(token),
  ...(quota ?? []).map(chatgptQuotaPlanObservation),
  fallback === null || fallback === undefined ? null : { planType: fallback },
);

export const resolveChatGPTPlanType = (...args: Parameters<typeof resolveChatGPTPlan>): string | null => resolveChatGPTPlan(...args)?.planType ?? null;
