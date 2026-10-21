-- Returnable Delivery Challan cum Gate Pass (MVP) - Database Schema
-- Implements Technical Specification Section 8

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('ADMIN','PREPARER','AUTHORIZER','SECURITY','VIEWER','CENTER_MANAGER');
CREATE TYPE movement_type AS ENUM ('JOB_WORK','REPAIR','TESTING','EXHIBITION','BRANCH_TRANSFER','OTHER');
CREATE TYPE challan_status AS ENUM ('DRAFT','SUBMITTED','CM_APPROVED','CHANGES_REQUESTED','ISSUED','GATE_OUT','PARTIALLY_RETURNED','RETURNED','CANCELLED');
CREATE TYPE return_condition AS ENUM ('GOOD','DAMAGED','PARTIAL');
CREATE TYPE itc04_status AS ENUM ('Y','N','NA');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(255),
  role user_role NOT NULL,
  -- Assigned location for this user, matched against delivery_challans.qmc_location.
  -- Only enforced for PREPARER, SECURITY, and VIEWER roles (see
  -- backend/src/routes/challans.js hasLocationAccess()). NULL means "not
  -- restricted to a single location" (e.g. ADMIN/AUTHORIZER typically stay
  -- NULL; a PREPARER/SECURITY/VIEWER with NULL location is also
  -- unrestricted, so set this explicitly to scope a user to one location).
  location VARCHAR(120),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE challan_sequences (
  fiscal_year VARCHAR(5) NOT NULL,
  location_code VARCHAR(3) NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fiscal_year, location_code)
);

CREATE TABLE delivery_challans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_number VARCHAR(64) NOT NULL UNIQUE,
  fiscal_year VARCHAR(5) NOT NULL,
  sequence_number INTEGER NOT NULL,
  gate_pass_serial_number VARCHAR(16) NOT NULL,

  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  place_of_issue VARCHAR(150) NOT NULL,

  consignor_name VARCHAR(200) NOT NULL DEFAULT 'Stemz Radiology Pvt. Ltd.',
  consignor_address TEXT,
  consignor_gstin VARCHAR(15),
  consignor_state VARCHAR(100),
  consignor_state_code VARCHAR(2),

  consignee_name VARCHAR(200) NOT NULL,
  consignee_address TEXT NOT NULL,
  consignee_gstin VARCHAR(15),
  consignee_is_urp BOOLEAN NOT NULL DEFAULT FALSE,
  consignee_state VARCHAR(100),
  consignee_state_code VARCHAR(2),

  qmc_location VARCHAR(200) NOT NULL,
  qmc_number VARCHAR(100),
  place_of_supply VARCHAR(100),

  movement_type movement_type NOT NULL,
  movement_type_other_description VARCHAR(200),
  movement_reason TEXT,

  issued_to_employee_id UUID REFERENCES users(id),
  issued_to_employee_name VARCHAR(150) NOT NULL,

  transporter_name VARCHAR(200),
  mode_of_transport VARCHAR(50),
  transporter_gstin VARCHAR(15),
  vehicle_number VARCHAR(20),
  eway_bill_number VARCHAR(20),

  is_taxable_supply BOOLEAN NOT NULL DEFAULT FALSE,
  total_taxable_value NUMERIC(14,2),
  tax_rate NUMERIC(5,2),
  cgst_amount NUMERIC(14,2),
  sgst_utgst_amount NUMERIC(14,2),
  igst_amount NUMERIC(14,2),
  cess_amount NUMERIC(14,2),

  expected_return_date DATE,
  actual_return_date DATE,
  received_back_date DATE,
  return_condition return_condition,
  received_back_by VARCHAR(150),
  job_work_ref VARCHAR(100),
  itc04_reported itc04_status NOT NULL DEFAULT 'NA',

  remarks TEXT,

  prepared_by_id UUID NOT NULL REFERENCES users(id),
  checked_by_name VARCHAR(150),
  authorized_by_id UUID REFERENCES users(id),
  authorized_at TIMESTAMPTZ,

  status challan_status NOT NULL DEFAULT 'DRAFT',
  submission_version INTEGER NOT NULL DEFAULT 0, -- times submitted by the applicant: 0 draft, 1 = V1, 2 = V2, 3 = V3 (max)
  cancelled_reason TEXT,
  rejected_reason TEXT,
  rework_count INTEGER NOT NULL DEFAULT 0,
  rework_stage VARCHAR(50),

  -- RGP workflow (migration 006): CM first-level approval, GSOC send-back remarks,
  -- and overdue-reminder throttling.
  cm_approved_by UUID REFERENCES users(id),
  cm_approved_at TIMESTAMPTZ,
  gsoc_remarks TEXT,
  last_reminder_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0,

  gate_out_at TIMESTAMPTZ,
  gate_out_by UUID REFERENCES users(id),

  pdf_storage_key TEXT,
  pdf_generated_at TIMESTAMPTZ,
  pdf_template_version VARCHAR(20),

  version INTEGER NOT NULL DEFAULT 1,

  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_return_date CHECK (actual_return_date IS NULL OR actual_return_date >= issue_date)
);

CREATE INDEX idx_challans_status ON delivery_challans(status);
CREATE INDEX idx_challans_issue_date ON delivery_challans(issue_date);
CREATE INDEX idx_challans_movement_type ON delivery_challans(movement_type);
CREATE INDEX idx_challans_overdue ON delivery_challans(expected_return_date)
  WHERE status IN ('ISSUED','GATE_OUT','PARTIALLY_RETURNED');

CREATE TABLE delivery_challan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_id UUID NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  description_of_goods VARCHAR(300) NOT NULL,
  hsn_code VARCHAR(20),
  make VARCHAR(150),
  serial_number VARCHAR(150),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(20) NOT NULL,
  gst_rate NUMERIC(5,2),
  taxable_value NUMERIC(14,2),
  reason_for_movement VARCHAR(300),
  UNIQUE(challan_id, line_number)
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_id UUID NOT NULL REFERENCES delivery_challans(id),
  event_type VARCHAR(50) NOT NULL,
  field_name VARCHAR(100),
  old_value TEXT,
  new_value TEXT,
  remarks TEXT,
  performed_by UUID REFERENCES users(id), -- NULL = system action (e.g. scheduled reminder)
  performed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_challan ON audit_events(challan_id, performed_at);

CREATE TABLE challan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_id UUID NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status challan_status NOT NULL,
  change_type VARCHAR(50) NOT NULL,
  reason TEXT,
  snapshot JSONB NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id)
);

CREATE INDEX idx_challan_versions_challan ON challan_versions(challan_id, version_number DESC);

-- DB-level protection: application role must never UPDATE/DELETE audit_events.
-- (Run separately once you know your app's DB role name, e.g.:)
-- REVOKE UPDATE, DELETE ON audit_events FROM challan_app;
-- GRANT INSERT, SELECT ON audit_events TO challan_app;

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

CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Audit records are append-only';
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TRIGGER admin_audit_log_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
