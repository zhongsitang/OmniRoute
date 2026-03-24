-- Persist billing metadata for accurate historical reporting.
ALTER TABLE usage_history ADD COLUMN service_tier TEXT DEFAULT NULL;
ALTER TABLE usage_history ADD COLUMN cost_usd REAL DEFAULT NULL;

ALTER TABLE call_logs ADD COLUMN service_tier TEXT DEFAULT NULL;
ALTER TABLE call_logs ADD COLUMN cost_usd REAL DEFAULT NULL;

-- Historical migration rule requested by the user:
-- treat all gpt-5.4 requests as Codex fast tier.
UPDATE usage_history
SET service_tier = 'priority'
WHERE service_tier IS NULL
  AND (model = 'gpt-5.4' OR model LIKE '%/gpt-5.4');

UPDATE call_logs
SET service_tier = 'priority'
WHERE service_tier IS NULL
  AND (model = 'gpt-5.4' OR model LIKE '%/gpt-5.4');
