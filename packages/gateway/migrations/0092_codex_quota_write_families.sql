-- Connections opened before 0091 can keep writing the former snapshot shape
-- after deployment. Normalize those writes at the database boundary, where
-- both Worker versions meet. The active_limit field distinguishes an old
-- premium alias from a real family named premium written by the new parser.
-- https://github.com/openai/codex/blob/50379197779be0e5afcbddb014a34cd1fc08af53/codex-rs/codex-api/src/rate_limits.rs#L27-L100
CREATE TRIGGER codex_quota_family_write
AFTER UPDATE OF state_json ON upstreams
WHEN NEW.provider = 'codex'
  AND json_type(NEW.state_json, '$.accounts[0].quotaSnapshot') = 'object'
  AND EXISTS (
    SELECT 1 FROM json_each(NEW.state_json, '$.accounts[0].quotaSnapshot')
    WHERE json_type(value, '$.data.active_limit') IS NOT NULL
      OR NOT (
        (coalesce(json_type(value, '$.data.primary_used_percent') IN ('integer', 'real'), 0)
          AND json_extract(value, '$.data.primary_window_minutes') IS NOT 0)
        OR (coalesce(json_type(value, '$.data.secondary_used_percent') IN ('integer', 'real'), 0)
          AND json_extract(value, '$.data.secondary_window_minutes') IS NOT 0)
        OR coalesce(json_type(value, '$.data.credits_has_credits') IN ('true', 'false'), 0)
        OR coalesce(json_type(value, '$.data.credits_balance') IN ('integer', 'real'), 0)
      )
  )
BEGIN
  UPDATE upstreams
  SET state_json = json_set(NEW.state_json, '$.accounts[0].quotaSnapshot', json((
    WITH candidates AS (
      SELECT key AS source,
        CASE WHEN key IN ('premium', 'unknown')
          AND json_type(value, '$.data.active_limit') IS NOT NULL
          THEN 'codex' ELSE key END AS family,
        json_extract(value, '$.fetchedAt') AS fetched_at,
        json_remove(json_extract(value, '$.data'), '$.active_limit') AS data
      FROM json_each(NEW.state_json, '$.accounts[0].quotaSnapshot')
    ), readings AS (
      SELECT * FROM candidates
      WHERE (json_type(data, '$.primary_used_percent') IN ('integer', 'real')
          AND json_extract(data, '$.primary_window_minutes') IS NOT 0)
        OR (json_type(data, '$.secondary_used_percent') IN ('integer', 'real')
          AND json_extract(data, '$.secondary_window_minutes') IS NOT 0)
        OR json_type(data, '$.credits_has_credits') IN ('true', 'false')
        OR json_type(data, '$.credits_balance') IN ('integer', 'real')
    ), ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY family ORDER BY fetched_at DESC, source = family DESC, source
      ) AS position
      FROM readings
    ), merged AS (
      SELECT family, fetched_at, json_patch(coalesce((
        SELECT json_group_object(key, json(CASE type
          WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_quote(value)
        END))
        FROM json_each((
          SELECT credits.data FROM readings AS credits
          WHERE credits.family = ranked.family
            AND (json_type(credits.data, '$.credits_has_credits') IN ('true', 'false')
              OR json_type(credits.data, '$.credits_balance') IN ('integer', 'real'))
          ORDER BY credits.fetched_at DESC, credits.source = credits.family DESC, credits.source
          LIMIT 1
        ))
        WHERE key IN ('credits_has_credits', 'credits_balance')
      ), '{}'), data) AS data
      FROM ranked WHERE position = 1
    )
    SELECT CASE WHEN count(*) = 0 THEN 'null' ELSE json_group_object(
      family, json_object('fetchedAt', fetched_at, 'data', json(data))
    ) END FROM merged
  )))
  WHERE id = NEW.id;
END;

-- Also repair writes that arrived between the first migration and this one.
UPDATE upstreams SET state_json = state_json WHERE provider = 'codex';

-- The writer saves its snapshot before recording gauges. An independent
-- family remains in that snapshot; a migrated alias does not. Preserve real
-- family names and normalize only absent aliases, including UPSERT attempts.
CREATE TRIGGER codex_quota_metric_family_write
BEFORE INSERT ON upstream_metrics
WHEN NEW.metric_name = 'quota.window.used_percent'
  AND json_extract(NEW.metric_labels, '$.limit') IN ('premium', 'unknown', '')
  AND EXISTS (
    SELECT 1 FROM upstreams
    WHERE id = NEW.upstream_id AND provider = 'codex'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(state_json, '$.accounts[0].quotaSnapshot')
        WHERE key = json_extract(NEW.metric_labels, '$.limit')
      )
  )
BEGIN
  INSERT INTO upstream_metrics (upstream_id, metric_name, metric_labels, bucket, timestamp, value)
  VALUES (NEW.upstream_id, NEW.metric_name, json_set(NEW.metric_labels, '$.limit', 'codex'), NEW.bucket, NEW.timestamp, NEW.value)
  ON CONFLICT (upstream_id, metric_name, metric_labels, bucket) DO UPDATE
  SET timestamp = excluded.timestamp, value = excluded.value
  WHERE excluded.timestamp > upstream_metrics.timestamp;
  SELECT RAISE(IGNORE);
END;

INSERT INTO upstream_metrics (upstream_id, metric_name, metric_labels, bucket, timestamp, value)
SELECT m.upstream_id, m.metric_name, json_set(m.metric_labels, '$.limit', 'codex'), m.bucket, m.timestamp, m.value
FROM upstream_metrics AS m JOIN upstreams AS u ON u.id = m.upstream_id
WHERE u.provider = 'codex' AND m.metric_name = 'quota.window.used_percent'
  AND json_extract(m.metric_labels, '$.limit') IN ('premium', 'unknown', '')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(u.state_json, '$.accounts[0].quotaSnapshot')
    WHERE key = json_extract(m.metric_labels, '$.limit')
  )
ORDER BY m.timestamp
ON CONFLICT (upstream_id, metric_name, metric_labels, bucket) DO UPDATE
SET timestamp = excluded.timestamp, value = excluded.value
WHERE excluded.timestamp > upstream_metrics.timestamp;

DELETE FROM upstream_metrics
WHERE metric_name = 'quota.window.used_percent'
  AND json_extract(metric_labels, '$.limit') IN ('premium', 'unknown', '')
  AND EXISTS (
    SELECT 1 FROM upstreams AS u
    WHERE u.id = upstream_metrics.upstream_id AND u.provider = 'codex'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(u.state_json, '$.accounts[0].quotaSnapshot')
        WHERE key = json_extract(upstream_metrics.metric_labels, '$.limit')
      )
  );
