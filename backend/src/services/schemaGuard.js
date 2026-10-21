const db = require('../db');
const { seedFormFields } = require('./formFields');

/**
 * Start-up self-heal. Brings an older database in line with what the code writes, so that
 * "Request Changes (CM/GSOC)" and "Reject Request" cannot fail because a migration was skipped.
 * Mirrors db/migrations/015_fix_changes_requested_and_versions.sql. Every step is idempotent.
 * ALTER TYPE ... ADD VALUE is run as its own statement (not inside a transaction block).
 */
const STEPS = [
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                WHERE t.typname = 'challan_status' AND e.enumlabel = 'REJECTED')
        AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                WHERE t.typname = 'challan_status' AND e.enumlabel = 'CHANGES_REQUESTED') THEN
       ALTER TYPE challan_status RENAME VALUE 'REJECTED' TO 'CHANGES_REQUESTED';
     END IF;
   END $$`,
  `ALTER TYPE challan_status ADD VALUE IF NOT EXISTS 'CM_APPROVED'`,
  `ALTER TYPE challan_status ADD VALUE IF NOT EXISTS 'CHANGES_REQUESTED'`,
  `ALTER TABLE delivery_challans
     ADD COLUMN IF NOT EXISTS rework_count       INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS rework_stage       VARCHAR(50),
     ADD COLUMN IF NOT EXISTS rejected_reason    TEXT,
     ADD COLUMN IF NOT EXISTS cancelled_reason   TEXT,
     ADD COLUMN IF NOT EXISTS gsoc_remarks       TEXT,
     ADD COLUMN IF NOT EXISTS cm_approved_by     UUID REFERENCES users(id),
     ADD COLUMN IF NOT EXISTS cm_approved_at     TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS submission_version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE challan_versions DROP CONSTRAINT IF EXISTS challan_versions_challan_id_version_number_key`,
  `ALTER TABLE audit_events ALTER COLUMN performed_by DROP NOT NULL`,
  // ---- Admin Console (migration 016) ----
  `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS designation VARCHAR(150),
     ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
     ADD COLUMN IF NOT EXISTS otp_required BOOLEAN NOT NULL DEFAULT FALSE,
     ADD COLUMN IF NOT EXISTS otp_code_hash VARCHAR(64),
     ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS otp_attempts INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS signature_data BYTEA,
     ADD COLUMN IF NOT EXISTS signature_mime VARCHAR(50),
     ADD COLUMN IF NOT EXISTS signature_updated_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
     ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id),
     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE delivery_challan_items ADD COLUMN IF NOT EXISTS gst_rate NUMERIC(5,2)`,
  `ALTER TABLE delivery_challan_items ALTER COLUMN hsn_code TYPE VARCHAR(20)`,
  `CREATE TABLE IF NOT EXISTS form_fields (
     field_key VARCHAR(80) PRIMARY KEY, label VARCHAR(120) NOT NULL, section VARCHAR(80),
     field_type VARCHAR(20) NOT NULL DEFAULT 'text', is_required BOOLEAN NOT NULL DEFAULT FALSE,
     is_visible BOOLEAN NOT NULL DEFAULT TRUE, is_system BOOLEAN NOT NULL DEFAULT FALSE,
     is_locked BOOLEAN NOT NULL DEFAULT FALSE, options JSONB, help_text VARCHAR(200),
     sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     key VARCHAR(80) PRIMARY KEY, value JSONB NOT NULL,
     updated_by UUID REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID REFERENCES users(id),
     action VARCHAR(60) NOT NULL, target_type VARCHAR(30), target_id VARCHAR(80), detail JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC)`,
  `CREATE OR REPLACE FUNCTION prevent_audit_mutation()
   RETURNS trigger
   LANGUAGE plpgsql
   AS $$
   BEGIN
     RAISE EXCEPTION 'Audit records are append-only';
   END;
   $$`,
  `DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events`,
  `CREATE TRIGGER audit_events_append_only
   BEFORE UPDATE OR DELETE ON audit_events
   FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation()`,
  `DROP TRIGGER IF EXISTS admin_audit_log_append_only ON admin_audit_log`,
  `CREATE TRIGGER admin_audit_log_append_only
   BEFORE UPDATE OR DELETE ON admin_audit_log
   FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation()`,
  `REVOKE UPDATE, DELETE ON audit_events FROM challan_app`,
  `REVOKE UPDATE, DELETE ON admin_audit_log FROM challan_app`,
  `GRANT SELECT, INSERT ON audit_events TO challan_app`,
  `GRANT SELECT, INSERT ON admin_audit_log TO challan_app`
];

async function ensureSchema() {
  for (const sql of STEPS) {
    try {
      await db.query(sql);
    } catch (err) {
      // Never stop the API from starting; report clearly so it can be fixed by hand.
      console.error('[schema-guard] step failed:', err.message, '\n  ->', sql.replace(/\s+/g, ' ').slice(0, 120)); // eslint-disable-line no-console
    }
  }
  try {
    await seedFormFields();
  } catch (err) {
    console.error('[schema-guard] could not seed form fields:', err.message); // eslint-disable-line no-console
  }
  console.log('[schema-guard] database checked'); // eslint-disable-line no-console
}

module.exports = { ensureSchema };
