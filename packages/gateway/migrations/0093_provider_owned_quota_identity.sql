-- Quota identity belongs to the provider's protocol projection. Storage must
-- preserve it independently of the current snapshot: a reset or history
-- restore can leave that snapshot empty while valid metrics still arrive.
-- Keep the historical repairs in their migrations, without interpreting
-- future names or observations through persistent alias-rewriting rules.
-- Connections still running writers from before the family-identity change
-- must drain before applying this migration; stored names cannot identify
-- which deployed version produced an observation.
DROP TRIGGER codex_quota_family_write;
DROP TRIGGER codex_quota_metric_family_write;
