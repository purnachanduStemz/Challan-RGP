-- Migration 012: submission_version now counts Changes Requested cycles.
-- 0 = never sent back; 1 = first Changes Requested cycle; 2 = second; and so on.
ALTER TABLE delivery_challans ALTER COLUMN submission_version SET DEFAULT 0;
UPDATE delivery_challans SET submission_version = COALESCE(rework_count, 0);
