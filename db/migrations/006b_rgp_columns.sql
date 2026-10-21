-- Migration 006b: RGP workflow - new columns. Run AFTER 006a_rgp_enums.sql.
-- Safe to run more than once.

ALTER TABLE delivery_challans
  ADD COLUMN IF NOT EXISTS cm_approved_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cm_approved_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gsoc_remarks     TEXT,
  ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_count   INTEGER NOT NULL DEFAULT 0;

-- The scheduled overdue reminder is a system action with no logged-in user,
-- so its REMINDER_SENT audit row needs performed_by to be nullable.
-- (NULL is displayed as "System" in the audit trail.)
ALTER TABLE audit_events ALTER COLUMN performed_by DROP NOT NULL;

-- Optional: give the reminder job a fast lookup of overdue open challans.
-- (idx_challans_overdue already exists from schema.sql; nothing else needed.)

-- Existing data: challans already in SUBMITTED are treated as "Pending CM
-- Approval" (no change needed). If you would rather let GSOC act on them
-- immediately, uncomment:
-- UPDATE delivery_challans SET status = 'CM_APPROVED', cm_approved_at = now() WHERE status = 'SUBMITTED';
