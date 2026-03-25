ALTER TABLE proxy_registry ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE proxy_registry ADD COLUMN owner_scope TEXT;
ALTER TABLE proxy_registry ADD COLUMN owner_scope_id TEXT;

CREATE INDEX IF NOT EXISTS idx_proxy_registry_visibility
  ON proxy_registry(visibility, status);

CREATE INDEX IF NOT EXISTS idx_proxy_registry_owner
  ON proxy_registry(owner_scope, owner_scope_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_registry_managed_owner
  ON proxy_registry(owner_scope, COALESCE(owner_scope_id, '__global__'))
  WHERE visibility = 'managed' AND owner_scope IS NOT NULL;
