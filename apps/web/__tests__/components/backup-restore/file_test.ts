import { describe, expect, it } from 'vitest';

import { BACKUP_FILE_VERSION, parseBackupFile } from '../../../src/components/backup-restore/file';

const data = {
  users: [],
  userPreferences: [],
  groups: [],
  accessRecords: [],
  apiKeys: [],
  upstreams: [],
  proxies: [],
  usage: [],
  searchUsage: [],
  upstreamMetrics: [],
  performanceIncluded: false,
  searchConfig: null,
  siteSettings: { siteName: null },
};

const backup = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  version: BACKUP_FILE_VERSION,
  exportedAt: '2026-07-28T00:00:00.000Z',
  data,
  ...overrides,
});

describe('backup file validation', () => {
  it('exports version 26 and accepts its envelope', () => {
    expect(BACKUP_FILE_VERSION).toBe(26);
    expect(parseBackupFile(backup()).ok).toBe(true);
  });

  it.each([25, 26])('preserves version %s and both performance tiers for import', version => {
    const performance = [{ model: 'model-a', serviceTier: 'default', ...(version === 26 ? { requestedServiceTier: 'priority' } : {}) }];
    const raw = backup({ version, data: { ...data, performanceIncluded: true, performance } });
    expect(parseBackupFile(raw)).toEqual({ ok: true, payload: JSON.parse(raw) });
  });

  it.each([24, 0, 27, '26'])('rejects unsupported envelope version %s outright', version => {
    expect(parseBackupFile(backup({ version })).ok).toBe(false);
  });

  it('rejects unknown fields instead of stripping them', () => {
    expect(parseBackupFile(backup({ typo: true })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, typo: [] } })).ok).toBe(false);
  });

  it('requires the preferences collection this version exports', () => {
    expect(parseBackupFile(backup({ data: { ...data, userPreferences: undefined } })).ok).toBe(false);
  });

  it('keeps performance presence synchronized with its flag', () => {
    expect(parseBackupFile(backup({ data: { ...data, performance: [] } })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, performanceIncluded: true } })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, performanceIncluded: true, performance: [] } })).ok).toBe(true);
  });
});
