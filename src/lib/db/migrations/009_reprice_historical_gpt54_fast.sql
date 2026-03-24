-- Historical gpt-5.4 requests routed through non-Codex providers were
-- previously persisted with standard pricing. Clear stored cost so startup
-- reconciliation can recompute them with the fast-tier multiplier.
UPDATE usage_history
SET cost_usd = NULL
WHERE cost_usd IS NOT NULL
  AND (model = 'gpt-5.4' OR model LIKE '%/gpt-5.4')
  AND LOWER(TRIM(COALESCE(provider, ''))) NOT IN ('codex', 'cx');
