-- Header observations used x-codex-active-limit (usually premium), while
-- /wham/usage observations used codex. They describe the same default family.
-- Missing headers also produced empty unknown entries. Retain real named
-- families, choose the newest reading, and preserve the latest known credits.
-- https://github.com/openai/codex/blob/50379197779be0e5afcbddb014a34cd1fc08af53/codex-rs/codex-api/src/rate_limits.rs#L27-L100
WITH candidates AS (
  SELECT
    upstreams.id,
    entry.key AS source,
    CASE WHEN entry.key IN ('premium', 'unknown') THEN 'codex' ELSE entry.key END AS family,
    json_extract(entry.value, '$.fetchedAt') AS fetched_at,
    json_remove(json_extract(entry.value, '$.data'), '$.active_limit') AS data
  FROM upstreams, json_each(state_json, '$.accounts[0].quotaSnapshot') AS entry
  WHERE provider = 'codex'
    AND json_type(state_json, '$.accounts[0].quotaSnapshot') = 'object'
), readings AS (
  SELECT * FROM candidates
  WHERE (
    json_type(data, '$.primary_used_percent') IN ('integer', 'real')
    AND json_extract(data, '$.primary_window_minutes') IS NOT 0
  ) OR (
    json_type(data, '$.secondary_used_percent') IN ('integer', 'real')
    AND json_extract(data, '$.secondary_window_minutes') IS NOT 0
  ) OR json_type(data, '$.credits_has_credits') IN ('true', 'false')
    OR json_type(data, '$.credits_balance') IN ('integer', 'real')
), ranked AS (
  SELECT *, row_number() OVER (
    PARTITION BY id, family ORDER BY fetched_at DESC, source = family DESC, source
  ) AS position
  FROM readings
), merged AS (
  SELECT id, family, fetched_at, json_patch(
    coalesce((
      SELECT json_group_object(key, json(CASE type
        WHEN 'true' THEN 'true'
        WHEN 'false' THEN 'false'
        ELSE json_quote(value)
      END))
      FROM json_each((
        SELECT credits.data FROM readings AS credits
        WHERE credits.id = ranked.id AND credits.family = ranked.family
          AND (json_type(credits.data, '$.credits_has_credits') IN ('true', 'false')
            OR json_type(credits.data, '$.credits_balance') IN ('integer', 'real'))
        ORDER BY credits.fetched_at DESC, credits.source = credits.family DESC, credits.source
        LIMIT 1
      ))
      WHERE key IN ('credits_has_credits', 'credits_balance')
    ), '{}'),
    data
  ) AS data
  FROM ranked WHERE position = 1
)
UPDATE upstreams
SET state_json = json_set(state_json, '$.accounts[0].quotaSnapshot', json((
  SELECT CASE WHEN count(*) = 0 THEN 'null' ELSE json_group_object(
    family, json_object('fetchedAt', fetched_at, 'data', json(data))
  ) END
  FROM merged WHERE merged.id = upstreams.id
)))
WHERE provider = 'codex'
  AND json_type(state_json, '$.accounts[0].quotaSnapshot') = 'object';

-- Historical charts use the same identity. On a shared minute, keep the
-- latest observation rather than summing two gauge readings.
INSERT INTO upstream_metrics (upstream_id, metric_name, metric_labels, bucket, timestamp, value)
SELECT upstream_id, metric_name, json_set(metric_labels, '$.limit', 'codex'), bucket, timestamp, value
FROM upstream_metrics
WHERE upstream_id IN (SELECT id FROM upstreams WHERE provider = 'codex')
  AND metric_name = 'quota.window.used_percent'
  AND json_extract(metric_labels, '$.limit') IN ('premium', 'unknown', '')
ORDER BY timestamp
ON CONFLICT (upstream_id, metric_name, metric_labels, bucket) DO UPDATE
SET timestamp = excluded.timestamp, value = excluded.value
WHERE excluded.timestamp > upstream_metrics.timestamp;

DELETE FROM upstream_metrics
WHERE upstream_id IN (SELECT id FROM upstreams WHERE provider = 'codex')
  AND metric_name = 'quota.window.used_percent'
  AND json_extract(metric_labels, '$.limit') IN ('premium', 'unknown', '');
