-- Seed users, one per role. Default password for ALL seed users: Password123!
-- CHANGE THESE before using outside local development.
-- full_name is set to the role name itself so no personal names appear in the demo data.
--
-- CENTER_MANAGER is the first-level approver for its location; AUTHORIZER is the
-- second-level (GSOC) approver.
--
-- location is only enforced for PREPARER, SECURITY, VIEWER and CENTER_MANAGER roles (see
-- backend/src/routes/challans.js hasLocationAccess()). It's set here to
-- 'QMC Store, Building 1' to demonstrate the scoping — a real deployment
-- would have one PREPARER/SECURITY/VIEWER set per physical location, each
-- with their own `location` value matching the qmc_location used on their
-- challans. SUPER_ADMIN/ADMIN/AUTHORIZER are left NULL (unrestricted — they oversee
-- all locations).

INSERT INTO users (full_name, email, password_hash, role, location) VALUES
('Admin',      'admin@stemz.local',      '$2a$10$ZGM6MB/6u0l1hvklCzGwUutWgVbnmbAdff9UUxfMTRSX5A1v3GkYO', 'ADMIN',      NULL),
('Preparer',   'preparer@stemz.local',   '$2a$10$ZGM6MB/6u0l1hvklCzGwUutWgVbnmbAdff9UUxfMTRSX5A1v3GkYO', 'PREPARER',   'QMC Store, Building 1'),
('Center Manager', 'cm@stemz.local',    '$2a$10$ZGM6MB/6u0l1hvklCzGwUutWgVbnmbAdff9UUxfMTRSX5A1v3GkYO', 'CENTER_MANAGER', 'QMC Store, Building 1'),
('Authorizer', 'authorizer@stemz.local', '$2a$10$ZGM6MB/6u0l1hvklCzGwUutWgVbnmbAdff9UUxfMTRSX5A1v3GkYO', 'AUTHORIZER', NULL),
('Security',   'security@stemz.local',   '$2a$10$ZGM6MB/6u0l1hvklCzGwUutWgVbnmbAdff9UUxfMTRSX5A1v3GkYO', 'SECURITY',   'QMC Store, Building 1'),
('Viewer',     'viewer@stemz.local',     '$2a$10$ZGM6MB/6u0l1hvklCzGwUutWgVbnmbAdff9UUxfMTRSX5A1v3GkYO', 'VIEWER',     'QMC Store, Building 1');

-- challan_sequences rows are created on demand per (fiscal year, location) by services/numbering.js.
