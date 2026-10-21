-- Migration 015: fixes the error raised when a Center Manager / GSOC enters a reason
-- for "Request Changes" or "Reject Request".
--
-- Cause 1: older databases still have the challan_status value 'REJECTED'. The app now writes
--          'CHANGES_REQUESTED', so Postgres refused it (invalid input value for enum).
-- Cause 2: databases built from migration 009 still carry UNIQUE (challan_id, version_number) on
--          challan_versions, which "Reject Request" / resubmit can violate.
-- Cause 3: columns used by the workflow may be missing on databases that skipped older migrations.
--
-- Safe to run more than once. (The backend also runs this automatically on start-up.)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'challan_status' AND e.enumlabel = 'REJECTED')
     AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'challan_status' AND e.enumlabel = 'CHANGES_REQUESTED') THEN
    ALTER TYPE challan_status RENAME VALUE 'REJECTED' TO 'CHANGES_REQUESTED';
  END IF;
END $$;

ALTER TYPE challan_status ADD VALUE IF NOT EXISTS 'CM_APPROVED';
ALTER TYPE challan_status ADD VALUE IF NOT EXISTS 'CHANGES_REQUESTED';

ALTER TABLE delivery_challans
  ADD COLUMN IF NOT EXISTS rework_count       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rework_stage       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS rejected_reason    TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_reason   TEXT,
  ADD COLUMN IF NOT EXISTS gsoc_remarks       TEXT,
  ADD COLUMN IF NOT EXISTS cm_approved_by     UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cm_approved_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE challan_versions
  DROP CONSTRAINT IF EXISTS challan_versions_challan_id_version_number_key;
CREATE INDEX IF NOT EXISTS idx_challan_versions_order
  ON challan_versions(challan_id, created_at DESC, id);

ALTER TABLE audit_events ALTER COLUMN performed_by DROP NOT NULL;
