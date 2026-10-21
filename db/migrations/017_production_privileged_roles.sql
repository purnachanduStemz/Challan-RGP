-- 017: Append-only audit protection.
-- Run this migration with a deployment account that owns the schema.
-- Do not create production users with passwords in this file.

COMMENT ON TABLE audit_events IS
  'Append-only business audit history. The application role must not UPDATE or DELETE rows.';

COMMENT ON TABLE admin_audit_log IS
  'Append-only administrative audit history. The application role must not UPDATE or DELETE rows.';

-- The application must still be able to insert and read audit records. These
-- statements are intentionally idempotent and apply when challan_app owns the
-- runtime connection, as in the supplied Docker configuration.
REVOKE UPDATE, DELETE ON audit_events FROM challan_app;
REVOKE UPDATE, DELETE ON admin_audit_log FROM challan_app;
GRANT SELECT, INSERT ON audit_events TO challan_app;
GRANT SELECT, INSERT ON admin_audit_log TO challan_app;

CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Audit records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

DROP TRIGGER IF EXISTS admin_audit_log_append_only ON admin_audit_log;
CREATE TRIGGER admin_audit_log_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
