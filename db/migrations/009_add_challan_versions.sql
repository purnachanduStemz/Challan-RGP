CREATE TABLE IF NOT EXISTS challan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_id UUID NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status challan_status NOT NULL,
  change_type VARCHAR(50) NOT NULL,
  reason TEXT,
  snapshot JSONB NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (challan_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_challan_versions_challan
  ON challan_versions(challan_id, version_number DESC);
