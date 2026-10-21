-- 016: Admin Console (ADMIN and SUPER_ADMIN are privileged roles)
--  * users: designation, signature image (PNG/JPG stored as bytes), forced password change for admin-issued credentials
--  * form_fields: admin-managed field definitions (labels, required/visible, custom fields)
--  * delivery_challans.custom_data: values of admin-defined custom fields
--  * app_settings: approval-block (Prepared / Checked / Authorized) labels for the PDF
--  * admin_audit_log: every admin action
-- The backend also applies all of this on start-up (services/schemaGuard.js), so this file is optional.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS designation VARCHAR(150),
  ADD COLUMN IF NOT EXISTS signature_data BYTEA,
  ADD COLUMN IF NOT EXISTS signature_mime VARCHAR(50),
  ADD COLUMN IF NOT EXISTS signature_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE delivery_challans
  ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS form_fields (
  field_key   VARCHAR(80) PRIMARY KEY,
  label       VARCHAR(120) NOT NULL,
  section     VARCHAR(80),
  field_type  VARCHAR(20) NOT NULL DEFAULT 'text',
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_visible  BOOLEAN NOT NULL DEFAULT TRUE,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked   BOOLEAN NOT NULL DEFAULT FALSE,   -- required by GST rules / validators: only the label may change
  options     JSONB,
  help_text   VARCHAR(200),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(80) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES users(id),
  action      VARCHAR(60) NOT NULL,
  target_type VARCHAR(30),
  target_id   VARCHAR(80),
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
