import type { UpstreamMetricRecord, UpstreamMetricsRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

export const UPSTREAM_METRICS_INTERVAL_MS = 60_000;
const columns = 'upstream_id AS upstreamId, metric_key AS key, timestamp, value';

export class SqlUpstreamMetricsRepo implements UpstreamMetricsRepo {
  constructor(private db: SqlDatabase) {}

  async record(record: UpstreamMetricRecord): Promise<void> {
    // Coalesce changed values in SQL so concurrent requests and separate Worker
    // isolates share interval state without process timers.
    await this.db.prepare(`
      INSERT INTO upstream_metrics (upstream_id, metric_key, bucket, timestamp, value)
      SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM upstream_metrics
        WHERE upstream_id = ? AND metric_key = ? AND timestamp > ?
      ) AND NOT EXISTS (
        SELECT 1 FROM upstream_metrics
        WHERE upstream_id = ? AND metric_key = ? AND value = ?
          AND timestamp = (SELECT MAX(timestamp) FROM upstream_metrics WHERE upstream_id = ? AND metric_key = ?)
      )
      ON CONFLICT (upstream_id, metric_key, bucket) DO UPDATE SET
        timestamp = excluded.timestamp, value = excluded.value
      WHERE excluded.timestamp >= upstream_metrics.timestamp
    `).bind(record.upstreamId, record.key, Math.floor(record.timestamp / UPSTREAM_METRICS_INTERVAL_MS), record.timestamp, record.value,
      record.upstreamId, record.key, record.timestamp, record.upstreamId, record.key, record.value, record.upstreamId, record.key).run();
  }

  async listAll(): Promise<UpstreamMetricRecord[]> {
    const { results } = await this.db.prepare(`SELECT ${columns} FROM upstream_metrics ORDER BY timestamp, upstreamId, key`).all<UpstreamMetricRecord>();
    return results;
  }

  async set(record: UpstreamMetricRecord): Promise<void> {
    await this.db.prepare(`
      INSERT INTO upstream_metrics (upstream_id, metric_key, bucket, timestamp, value)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (upstream_id, metric_key, bucket) DO UPDATE SET
        timestamp = excluded.timestamp, value = excluded.value
    `).bind(record.upstreamId, record.key, Math.floor(record.timestamp / UPSTREAM_METRICS_INTERVAL_MS), record.timestamp, record.value).run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM upstream_metrics').run();
  }

  async query(upstreamId: string, start: number, end: number): Promise<UpstreamMetricRecord[]> {
    // A gauge persists until its next observation, including at the left edge of a query.
    const { results } = await this.db.prepare(`
      SELECT ${columns} FROM upstream_metrics
      WHERE timestamp >= ? AND timestamp < ? AND upstream_id = ?
      UNION ALL
      SELECT ${columns} FROM upstream_metrics
      WHERE (upstream_id, metric_key, timestamp) IN (
        SELECT upstream_id, metric_key, MAX(timestamp) FROM upstream_metrics
        WHERE timestamp < ? AND upstream_id = ? GROUP BY upstream_id, metric_key
      )
      ORDER BY timestamp, upstreamId, key
    `).bind(start, end, upstreamId, start, upstreamId).all<UpstreamMetricRecord>();
    return results;
  }
}
