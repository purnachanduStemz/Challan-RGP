-- Migration: add users.location
--
-- schema.sql / seed.sql only run automatically via docker-entrypoint-initdb.d
-- the FIRST time the Postgres data volume is created. If your database
-- already existed before this change, run this migration manually:
--
--   docker exec -i challan_postgres psql -U challan_app -d challan_db < db/migrations/001_add_user_location.sql
--
-- It's safe to run more than once.

ALTER TABLE users ADD COLUMN IF NOT EXISTS location VARCHAR(120);

COMMENT ON COLUMN users.location IS
  'Assigned location, matched against delivery_challans.qmc_location. Only enforced for PREPARER/SECURITY/VIEWER roles. NULL = unrestricted.';

-- Example: scope the seeded demo preparer/security/viewer users to a location.
-- Adjust the location string to match the qmc_location values your team
-- actually uses, then re-run (or just run the matching UPDATEs by hand):
--
-- UPDATE users SET location = 'QMC Store, Building 1' WHERE email = 'preparer@stemz.local';
-- UPDATE users SET location = 'QMC Store, Building 1' WHERE email = 'security@stemz.local';
-- UPDATE users SET location = 'QMC Store, Building 1' WHERE email = 'viewer@stemz.local';
