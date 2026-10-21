-- Migration 006a: RGP workflow - new enum values.
--
-- PostgreSQL will not let a newly added enum value be USED in the same
-- transaction that adds it, so these two statements live in their own file.
-- Run this FIRST, then 006b_rgp_columns.sql:
--
--   docker exec -i challan_postgres psql -U challan_app -d challan_db < db/migrations/006a_rgp_enums.sql
--   docker exec -i challan_postgres psql -U challan_app -d challan_db < db/migrations/006b_rgp_columns.sql
--
-- Safe to run more than once. Enum values cannot be removed once added.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'CENTER_MANAGER';
ALTER TYPE challan_status ADD VALUE IF NOT EXISTS 'CM_APPROVED';
