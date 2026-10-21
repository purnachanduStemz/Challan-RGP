ALTER TABLE challan_versions
  DROP CONSTRAINT IF EXISTS challan_versions_challan_id_version_number_key;

CREATE INDEX IF NOT EXISTS idx_challan_versions_order
  ON challan_versions(challan_id, created_at DESC, id);
