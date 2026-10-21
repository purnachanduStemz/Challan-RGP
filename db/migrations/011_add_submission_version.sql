ALTER TABLE delivery_challans
  ADD COLUMN IF NOT EXISTS submission_version INTEGER NOT NULL DEFAULT 1;

UPDATE delivery_challans
SET submission_version = GREATEST(1, COALESCE(rework_count, 0) + 1)
WHERE submission_version = 1 AND COALESCE(rework_count, 0) > 0;
