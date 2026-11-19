import { describe, expect, it } from 'vitest';

import { changeTelemetryFilter, changeTelemetryGroupBy, scopeTelemetryIdentity, telemetryDimensionExcludedByGroup } from '../../../src/components/telemetry/filter-state';

const filters = { model: ['gpt-5'], upstream: ['up-1'], userId: ['2'], keyId: ['key-1'] };
const context = { currentUserId: '1', fallbackGroup: 'model' as const, userDimensionAvailable: true };

describe('telemetry filter state', () => {
  it('opts into same-axis filters without weakening identity scope or changing the default', () => {
    const comparisonContext = { ...context, sameAxisFilters: ['model', 'requestedServiceTier'] };
    expect(telemetryDimensionExcludedByGroup('model', 'model', comparisonContext.sameAxisFilters)).toBe(false);
    expect(telemetryDimensionExcludedByGroup('userId', 'keyId', comparisonContext.sameAxisFilters)).toBe(true);
    expect(changeTelemetryGroupBy({ groupBy: 'upstream', filters }, 'model', comparisonContext)).toEqual({
      groupBy: 'model', filters: { ...filters, keyId: [] },
    });
    expect(changeTelemetryFilter({ groupBy: 'model', filters }, 'keyId', ['own-key'], comparisonContext)).toEqual({
      groupBy: 'model', filters: { ...filters, userId: ['1'], keyId: ['own-key'] },
    });
    expect(scopeTelemetryIdentity('model', filters, context).filters.model).toEqual([]);
  });

  it('sets API key grouping and filtering to the current user scope', () => {
    expect(changeTelemetryGroupBy({ groupBy: 'model', filters }, 'keyId', context)).toEqual({
      groupBy: 'keyId',
      filters: { model: ['gpt-5'], upstream: ['up-1'], userId: ['1'], keyId: [] },
    });
    expect(changeTelemetryFilter({ groupBy: 'model', filters: { ...filters, userId: ['2'], keyId: [] } }, 'keyId', ['key-2'], context)).toEqual({
      groupBy: 'model',
      filters: { model: [], upstream: ['up-1'], userId: ['1'], keyId: ['key-2'] },
    });
  });

  it('leaves API key grouping and clears key filters when another user is selected', () => {
    expect(changeTelemetryFilter({
      groupBy: 'keyId',
      filters: { ...filters, userId: ['1'], keyId: [] },
    }, 'userId', ['2'], context)).toEqual({
      groupBy: 'model',
      filters: { model: [], upstream: ['up-1'], userId: ['2'], keyId: [] },
    });
  });
});
