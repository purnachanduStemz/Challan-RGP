-- 018: Production PostgreSQL roles.
-- Run this file as a PostgreSQL bootstrap/superuser, not as challan_app.
-- This file deliberately does not contain passwords.
--
-- Set credentials out-of-band after applying this migration:
--   \password rgp_db_admin
--   \password challan_app
--
-- Recommended production ownership:
--   rgp_schema_owner: NOLOGIN role that owns application objects
--   rgp_db_admin:     named human/operator login for migrations
--   challan_app:      runtime login used only by the Node.js backend

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgp_schema_owner') THEN
    CREATE ROLE rgp_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgp_db_admin') THEN
    CREATE ROLE rgp_db_admin LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'challan_app') THEN
    CREATE ROLE challan_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
END
$$;

GRANT rgp_schema_owner TO rgp_db_admin;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO challan_app;
GRANT USAGE, CREATE ON SCHEMA public TO rgp_schema_owner;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO challan_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO challan_app;

-- Audit history is append-only for the runtime account.
REVOKE UPDATE, DELETE ON audit_events FROM challan_app;
REVOKE UPDATE, DELETE ON admin_audit_log FROM challan_app;
GRANT SELECT, INSERT ON audit_events TO challan_app;
GRANT SELECT, INSERT ON admin_audit_log TO challan_app;

ALTER DEFAULT PRIVILEGES FOR ROLE rgp_schema_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO challan_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rgp_schema_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO challan_app;

COMMENT ON ROLE rgp_schema_owner IS
  'NOLOGIN owner of Returnable Gate Pass schema objects; never used by the application';
COMMENT ON ROLE rgp_db_admin IS
  'Named migration/operator account; assign a unique secret out-of-band';
COMMENT ON ROLE challan_app IS
  'Least-privilege Node.js runtime account; never use for migrations';
